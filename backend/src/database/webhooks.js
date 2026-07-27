/**
 * Webhook registration storage for distribute completion callbacks (#295).
 */

import { db, countWrite } from "./core.js";

export function registerWebhook(contractId, url) {
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

export function listWebhooks(contractId) {
  const stmt = db.prepare(`
    SELECT id, contractId, url, enabled, retry_count, next_retry_time, payload, createdAt
    FROM webhooks
    WHERE contractId = ? AND enabled = 1
    ORDER BY createdAt ASC
  `);

  return stmt.all(contractId);
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
    SELECT id, contractId, url, enabled, retry_count, next_retry_time, payload
    FROM webhooks
    WHERE enabled = 1
      AND retry_count < 4
      AND next_retry_time IS NOT NULL
      AND next_retry_time <= ?
  `);

  return stmt.all(nowIso);
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
