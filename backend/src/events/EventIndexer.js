/**
 * Event indexer service.
 * Listens to Soroban contract events and indexes them in the database.
 * Provides search and filtering capabilities for historical events.
 * Supports webhook triggers for event notifications.
 */

import logger from "../logger.js";
import { getCacheManager } from "../cache.js";
import { db } from "../database/index.js";

export class EventIndexer {
  constructor(sorobanRpc, contractId) {
    this.sorobanRpc = sorobanRpc;
    this.contractId = contractId;
    this.cache = getCacheManager();
    this.isRunning = false;
    this.pollIntervalMs = parseInt(process.env.EVENT_INDEXER_POLL_MS ?? "5000", 10);
    this.lastLedger = null;
    this.processedEvents = new Set(); // Deduplication
    this.timer = null;
  }

  /**
   * Start indexing events.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("[EventIndexer] Started", {
      contractId: this.contractId,
      pollIntervalMs: this.pollIntervalMs,
    });
    this._pollLoop();
  }

  /**
   * Stop the indexer gracefully.
   */
  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("[EventIndexer] Stopped");
  }

  async _pollLoop() {
    while (this.isRunning) {
      try {
        await this._checkForEvents();
      } catch (err) {
        logger.error("[EventIndexer] Poll error", {
          error: err.message,
          stack: err.stack,
        });
      }
      await this._sleep(this.pollIntervalMs);
    }
  }

  async _checkForEvents() {
    // Fetch latest events from Soroban RPC for this contract
    const startLedger = this.lastLedger;
    const events = await this.sorobanRpc.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [this.contractId],
          topics: [["*", "*"]],
        },
      ],
      limit: 100,
    });

    for (const event of events.events || []) {
      const eventId = `${event.ledgerSequence}-${event.transactionHash}-${event.eventIndex}`;

      if (this.processedEvents.has(eventId)) continue;
      this.processedEvents.add(eventId);

      await this._indexEvent(event);
    }

    // Update last ledger for next poll
    if (events.events && events.events.length > 0) {
      this.lastLedger = Math.max(...events.events.map((e) => e.ledgerSequence)) + 1;
    }
  }

  async _indexEvent(event) {
    try {
      // Parse event structure
      const eventBody = this._parseEventBody(event);
      const indexedData = this._transformEventData(event, eventBody);

      // Store in database
      await this._storeIndexedEvent({
        eventId: `${event.ledgerSequence}-${event.transactionHash}-${event.eventIndex}`,
        ledgerSequence: event.ledgerSequence,
        transactionHash: event.transactionHash,
        eventIndex: event.eventIndex,
        timestamp: event.timestamp || new Date().toISOString(),
        contractId: this.contractId,
        eventType: eventBody.topic,
        eventData: indexedData,
        rawEvent: JSON.stringify(event),
      });

      logger.debug("[EventIndexer] Indexed event", {
        eventId: `${event.ledgerSequence}-${event.transactionHash}-${event.eventIndex}`,
        eventType: eventBody.topic,
        ledgerSequence: event.ledgerSequence,
      });
    } catch (err) {
      logger.error("[EventIndexer] Failed to index event", {
        error: err.message,
        eventId: `${event.ledgerSequence}-${event.transactionHash}-${event.eventIndex}`,
      });
    }
  }

  _parseEventBody(event) {
    try {
      // Soroban event parsing — topic[1] is the event name
      const topicBytes = event.topic?.[1] ? Buffer.from(event.topic[1], "base64") : null;
      const topic = topicBytes ? topicBytes.toString("utf8") : "unknown";

      const valueBytes = event.value ? Buffer.from(event.value, "base64") : null;
      const data = valueBytes ? JSON.parse(valueBytes.toString("utf8")) : {};

      return { topic, data };
    } catch (err) {
      logger.warn("[EventIndexer] Failed to parse event body", {
        error: err.message,
        event,
      });
      return { topic: "unknown", data: {} };
    }
  }

  _transformEventData(event, eventBody) {
    const data = eventBody.data;

    // Standardize event data structure
    const transformed = {
      topic: eventBody.topic,
      timestamp: event.timestamp,
      ledgerSequence: event.ledgerSequence,
      transactionHash: event.transactionHash,
      ...data,
    };

    // Specific handling for distribute events
    if (eventBody.topic === "dist") {
      transformed.type = "distribution";
      if (data.recipients) {
        transformed.recipients = Array.isArray(data.recipients) ? data.recipients : [];
      }
      if (data.amount) {
        transformed.amount = data.amount;
      }
    }

    return transformed;
  }

  async _storeIndexedEvent(eventData) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO indexed_events (
        event_id,
        ledger_sequence,
        transaction_hash,
        event_index,
        timestamp,
        contract_id,
        event_type,
        event_data,
        raw_event,
        processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(
      eventData.eventId,
      eventData.ledgerSequence,
      eventData.transactionHash,
      eventData.eventIndex,
      eventData.timestamp,
      eventData.contractId,
      eventData.eventType,
      JSON.stringify(eventData.eventData),
      eventData.rawEvent
    );

    // Trigger webhooks if any are registered for this event type
    await this._triggerEventWebhooks(eventData);
  }

  async _triggerEventWebhooks(eventData) {
    try {
      const webhooks = this.cache.getEventWebhooks(this.contractId, eventData.eventType);

      if (!webhooks || webhooks.length === 0) return;

      for (const webhook of webhooks) {
        try {
          await this._deliverEventWebhook(webhook, eventData);
        } catch (err) {
          logger.error("[EventIndexer] Failed to deliver webhook", {
            webhookId: webhook.id,
            error: err.message,
            eventId: eventData.eventId,
          });
        }
      }
    } catch (err) {
      logger.error("[EventIndexer] Failed to get webhooks", {
        error: err.message,
        contractId: this.contractId,
      });
    }
  }

  async _deliverEventWebhook(webhook, eventData) {
    const payload = {
      event: eventData,
      timestamp: new Date().toISOString(),
      webhookId: webhook.id,
    };

    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.EVENT_WEBHOOK_TIMEOUT_MS ?? "10000", 10);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": eventData.eventType,
          "X-Webhook-Delivery": eventData.eventId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
      }

      logger.debug("[EventIndexer] Webhook delivered successfully", {
        webhookId: webhook.id,
        url: webhook.url,
        eventId: eventData.eventId,
        statusCode: response.status,
      });
    } catch (err) {
      logger.error("[EventIndexer] Webhook delivery failed", {
        webhookId: webhook.id,
        error: err.message,
        eventId: eventData.eventId,
      });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }
}

export default EventIndexer;