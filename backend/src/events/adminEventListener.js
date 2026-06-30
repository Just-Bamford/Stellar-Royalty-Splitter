/**
 * Event listener for admin transfer events (#399)
 * Subscribes to contract events and triggers cache invalidation.
 */
import logger from "../logger.js";
import { getCacheManager } from "../cache.js";

export class AdminEventListener {
  constructor(sorobanRpc, contractId) {
    this.sorobanRpc = sorobanRpc;
    this.contractId = contractId;
    this.cache = getCacheManager();
    this.isRunning = false;
    this.pollIntervalMs = parseInt(process.env.ADMIN_EVENT_POLL_MS ?? "2000", 10);
    this.lastLedger = null;
    this.processedEvents = new Set(); // Deduplication
    this.timer = null;
  }

  /**
   * Start listening for admin transfer events.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info("[AdminEventListener] Started", {
      contractId: this.contractId,
      pollIntervalMs: this.pollIntervalMs,
    });
    this._pollLoop();
  }

  /**
   * Stop the listener gracefully.
   */
  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("[AdminEventListener] Stopped");
  }

  async _pollLoop() {
    while (this.isRunning) {
      try {
        await this._checkForEvents();
      } catch (err) {
        logger.error("[AdminEventListener] Poll error", {
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

      // Parse event body to detect admin transfer
      const eventBody = this._parseEventBody(event);

      if (eventBody.topic === "admin_xfr" || eventBody.topic === "adm_acc") {
        const { previousAdmin, newAdmin } = eventBody.data;

        logger.info("[AdminEventListener] Admin transfer detected", {
          event: eventBody.topic,
          previousAdmin,
          newAdmin,
          ledgerSequence: event.ledgerSequence,
        });

        // Trigger immediate cache invalidation
        await this.cache.invalidateAdmin();

        // Log for audit trail
        this._logAdminChange(previousAdmin, newAdmin, event.ledgerSequence, event.timestamp);
      }
    }

    // Update last ledger for next poll
    if (events.events && events.events.length > 0) {
      this.lastLedger = Math.max(...events.events.map((e) => e.ledgerSequence)) + 1;
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
      logger.warn("[AdminEventListener] Failed to parse event body", {
        error: err.message,
        event,
      });
      return { topic: "unknown", data: {} };
    }
  }

  _logAdminChange(previousAdmin, newAdmin, ledgerSequence, timestamp) {
    logger.info("[Audit] Admin changed", {
      event: "admin_transferred",
      previousAdmin,
      newAdmin,
      ledgerSequence,
      timestamp: timestamp || new Date().toISOString(),
      contractId: this.contractId,
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }
}