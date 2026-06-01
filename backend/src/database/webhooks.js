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
