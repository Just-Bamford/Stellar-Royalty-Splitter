/**
 * Webhook registration storage for distribute completion callbacks (#295),
 * extended with per-webhook event subscriptions, HMAC secrets, and delivery
 * history for the advanced webhook system (#1059).
 */

import { db, countWrite } from "./core.js";

/**
 * Normalize an events array to its canonical JSON storage form.
 * NULL (stored as SQL NULL) means "subscribed to all events" — this keeps
 * legacy rows (registered before #1059) receiving every event.
 */
export function serializeEvents(events) {
  if (events == null) return null;
  if (!Array.isArray(events)) return null;
  const cleaned = [...new Set(events.filter((e) => typeof e === "string" && e.length > 0))];
  return cleaned.length === 0 ? null : JSON.stringify(cleaned);
}

export function parseEvents(eventsJson) {
  if (eventsJson == null) return null;
  try {
    const parsed = JSON.parse(eventsJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Register a webhook URL for a contract. `events` is an optional array of
 * event names to subscribe to (NULL = all events). `secret` is an optional
 * pre-generated HMAC secret; when omitted the existing secret is preserved
 * (or NULL when the row is new — the manager generates one).
 * Backwards compatible: registerWebhook(contractId, url).
 */
export function registerWebhook(contractId, url, events = null, secret = undefined) {
  const eventsJson = serializeEvents(events);

  if (events === null && secret === undefined) {
    // Legacy fast path — preserve exact historical behavior.
    const stmt = db.prepare(`
      INSERT INTO webhooks (contractId, url, enabled, retry_count, next_retry_time)
      VALUES (?, ?, 1, 0, NULL)
      ON CONFLICT(contractId, url) DO UPDATE SET enabled = 1, retry_count = 0, next_retry_time = NULL
    `);

    const result = stmt.run(contractId, url);
    countWrite();

    if (result.changes === 0) {
      const existing = db
        .prepare("SELECT id FROM webhooks WHERE contractId = ? AND url = ?")
        .get(contractId, url);
      return existing?.id ?? null;
    }

    return result.lastInsertRowid;
  }

  const existing = db
    .prepare("SELECT id, secret, events FROM webhooks WHERE contractId = ? AND url = ?")
    .get(contractId, url);

  if (existing) {
    const stmt =
      secret === undefined
        ? db.prepare(`
            UPDATE webhooks
            SET enabled = 1, retry_count = 0, next_retry_time = NULL, events = ?
            WHERE id = ?
          `)
        : db.prepare(`
            UPDATE webhooks
            SET enabled = 1, retry_count = 0, next_retry_time = NULL, events = ?, secret = ?
            WHERE id = ?
          `);
    if (secret === undefined) {
      stmt.run(eventsJson, existing.id);
    } else {
      stmt.run(eventsJson, secret, existing.id);
    }
    countWrite();
    return existing.id;
  }

  const stmt = db.prepare(`
    INSERT INTO webhooks (contractId, url, enabled, retry_count, next_retry_time, events, secret)
    VALUES (?, ?, 1, 0, NULL, ?, ?)
  `);
  const result = stmt.run(contractId, url, eventsJson, secret ?? null);
  countWrite();
  return result.lastInsertRowid;
}

export function getWebhookById(webhookId, contractId = null) {
  const stmt =
    contractId == null
      ? db.prepare("SELECT * FROM webhooks WHERE id = ?")
      : db.prepare("SELECT * FROM webhooks WHERE id = ? AND contractId = ?");
  const row =
    contractId == null ? stmt.get(webhookId) : stmt.get(webhookId, contractId);
  return row ?? null;
}

export function listWebhooks(contractId) {
  const stmt = db.prepare(`
    SELECT id, contractId, url, enabled, retry_count, next_retry_time, payload, events, secret, createdAt
    FROM webhooks
    WHERE contractId = ? AND enabled = 1
    ORDER BY createdAt ASC
  `);

  return stmt.all(contractId);
}

/**
 * List enabled webhooks for a contract subscribed to a given event.
 * Webhooks with NULL events are subscribed to everything (legacy rows).
 */
export function listWebhooksForEvent(contractId, event) {
  return listWebhooks(contractId).filter((webhook) => {
    const events = parseEvents(webhook.events);
    if (events === null) return true;
    return events.includes(event);
  });
}

export function updateWebhookEvents(webhookId, events) {
  const stmt = db.prepare("UPDATE webhooks SET events = ? WHERE id = ?");
  const result = stmt.run(serializeEvents(events), webhookId);
  countWrite();
  return result.changes > 0;
}

export function rotateWebhookSecret(webhookId, secret) {
  const stmt = db.prepare("UPDATE webhooks SET secret = ? WHERE id = ?");
  const result = stmt.run(secret, webhookId);
  countWrite();
  return result.changes > 0;
}

export function deleteWebhook(contractId, webhookId) {
  const stmt = db.prepare(`
    UPDATE webhooks
    SET enabled = 0
    WHERE id = ? AND contractId = ?
  `);

  const result = stmt.run(webhookId, contractId);
  countWrite();
  return result.changes > 0;
}

export function updateWebhookRetryState(webhookId, retryCount, nextRetryTime) {
  const stmt = db.prepare(`
    UPDATE webhooks
    SET retry_count = ?, next_retry_time = ?
    WHERE id = ?
  `);

  const result = stmt.run(retryCount, nextRetryTime, webhookId);
  countWrite();
  return result.changes > 0;
}

export function updateWebhookRetryStateWithPayload(webhookId, retryCount, nextRetryTime, payload) {
  const stmt = db.prepare(`
    UPDATE webhooks
    SET retry_count = ?, next_retry_time = ?, payload = ?
    WHERE id = ?
  `);

  const result = stmt.run(retryCount, nextRetryTime, payload, webhookId);
  countWrite();
  return result.changes > 0;
}

export function getWebhooksDueForRetry(now = new Date()) {
  const nowIso = now.toISOString();
  const stmt = db.prepare(`
    SELECT id, contractId, url, enabled, retry_count, next_retry_time, payload, events, secret
    FROM webhooks
    WHERE enabled = 1
      AND retry_count < 4
      AND next_retry_time IS NOT NULL
      AND next_retry_time <= ?
  `);

  return stmt.all(nowIso);
}

export function moveToDlq(webhookId, url, contractId, payload, error, retryCount) {
  const stmt = db.prepare(`
    INSERT INTO webhook_dlq (webhook_id, url, contract_id, payload, error, retry_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(webhookId, url, contractId, payload, error, retryCount);
  countWrite();
  return result.lastInsertRowid;
}

export function resetWebhookRetryCount(webhookId) {
  const stmt = db.prepare(`
    UPDATE webhooks
    SET retry_count = 0, next_retry_time = NULL, payload = NULL
    WHERE id = ?
  `);

  const result = stmt.run(webhookId);
  countWrite();
  return result.changes > 0;
}

// ─── Delivery history (#1059) ───────────────────────────────────────────────

export function recordDelivery({
  webhookId = null,
  contractId,
  event,
  url,
  payload = null,
  status = "pending",
  httpStatus = null,
  attempts = 0,
  error = null,
  durationMs = null,
}) {
  const stmt = db.prepare(`
    INSERT INTO webhook_deliveries
      (webhook_id, contract_id, event, url, payload, status, http_status, attempts, error, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    webhookId,
    contractId,
    event,
    url,
    payload,
    status,
    httpStatus,
    attempts,
    error,
    durationMs
  );
  countWrite();
  return result.lastInsertRowid;
}

export function updateDelivery(deliveryId, fields = {}) {
  const allowed = ["status", "http_status", "attempts", "error", "duration_ms", "payload"];
  const sets = [];
  const values = [];
  const columnMap = {
    status: "status",
    http_status: "http_status",
    attempts: "attempts",
    error: "error",
    duration_ms: "duration_ms",
    payload: "payload",
  };
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${columnMap[key]} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return false;
  values.push(deliveryId);
  const stmt = db.prepare(`UPDATE webhook_deliveries SET ${sets.join(", ")} WHERE id = ?`);
  const result = stmt.run(...values);
  countWrite();
  return result.changes > 0;
}

export function listDeliveries({ contractId = null, webhookId = null, event = null, status = null, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const values = [];
  if (contractId != null) {
    conditions.push("contract_id = ?");
    values.push(contractId);
  }
  if (webhookId != null) {
    conditions.push("webhook_id = ?");
    values.push(webhookId);
  }
  if (event != null) {
    conditions.push("event = ?");
    values.push(event);
  }
  if (status != null) {
    conditions.push("status = ?");
    values.push(status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const stmt = db.prepare(`
    SELECT id, webhook_id AS webhookId, contract_id AS contractId, event, url,
           payload, status, http_status AS httpStatus, attempts, error,
           duration_ms AS durationMs, created_at AS createdAt
    FROM webhook_deliveries
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(...values, limit, offset);
}

export function countDeliveries({ contractId = null, webhookId = null, event = null, status = null } = {}) {
  const conditions = [];
  const values = [];
  if (contractId != null) {
    conditions.push("contract_id = ?");
    values.push(contractId);
  }
  if (webhookId != null) {
    conditions.push("webhook_id = ?");
    values.push(webhookId);
  }
  if (event != null) {
    conditions.push("event = ?");
    values.push(event);
  }
  if (status != null) {
    conditions.push("status = ?");
    values.push(status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const stmt = db.prepare(`SELECT COUNT(*) AS count FROM webhook_deliveries ${where}`);
  return stmt.get(...values)?.count ?? 0;
}

export function getDeliveryStats(contractId = null) {
  const values = contractId != null ? [contractId] : [];
  const where = contractId != null ? "WHERE contract_id = ?" : "";
  const stmt = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM webhook_deliveries
    ${where}
    GROUP BY status
  `);
  const rows = stmt.all(...values);
  const stats = { total: 0, delivered: 0, failed: 0, pending: 0, exhausted: 0 };
  for (const row of rows) {
    stats.total += row.count;
    if (stats[row.status] !== undefined) {
      stats[row.status] = row.count;
    } else {
      stats[row.status] = row.count;
    }
  }
  return stats;
}
