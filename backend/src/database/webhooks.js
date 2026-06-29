/**
 * Webhook registration storage for distribute completion callbacks (#295).
 */

import { db, countWrite } from "./core.js";

export function registerWebhook(contractId, url) {
  const stmt = db.prepare(`
    INSERT INTO webhooks (contractId, url, enabled)
    VALUES (?, ?, 1)
    ON CONFLICT(contractId, url) DO UPDATE SET enabled = 1
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
    SELECT id, contractId, url, enabled, createdAt
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

export function recordDeliveryAttempt({ webhookId, contractId, success, statusCode, errorMessage, durationMs, attempt }) {
  db.prepare(`
    INSERT INTO webhook_deliveries (webhookId, contractId, success, statusCode, errorMessage, durationMs, attempt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(webhookId, contractId, success ? 1 : 0, statusCode ?? null, errorMessage ?? null, durationMs ?? null, attempt);
  countWrite();
}

export function getDeliveryAttempts(webhookId, limit = 20) {
  return db.prepare(`
    SELECT id, webhookId, contractId, success, statusCode, errorMessage, durationMs, attempt, timestamp
    FROM webhook_deliveries
    WHERE webhookId = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(webhookId, limit);
}

export function getDeliveryStats(webhookId) {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(success) as successes,
      AVG(CASE WHEN success = 1 THEN durationMs END) as avgLatencyMs,
      MAX(timestamp) as lastAttempt
    FROM webhook_deliveries
    WHERE webhookId = ?
  `).get(webhookId);
}

export function getContractDeliveryStats(contractId) {
  return db.prepare(`
    SELECT
      w.id as webhookId,
      w.url,
      COUNT(d.id) as total,
      SUM(d.success) as successes,
      AVG(CASE WHEN d.success = 1 THEN d.durationMs END) as avgLatencyMs,
      MAX(d.timestamp) as lastAttempt
    FROM webhooks w
    LEFT JOIN webhook_deliveries d ON d.webhookId = w.id
    WHERE w.contractId = ? AND w.enabled = 1
    GROUP BY w.id
  `).all(contractId);
}
