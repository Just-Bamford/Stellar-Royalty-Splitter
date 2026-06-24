/**
 * Webhook registration and dead-letter queue storage (#295, #401).
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

// ---------------------------------------------------------------------------
// Dead-letter queue (#401)
// ---------------------------------------------------------------------------

export function enqueueDeadLetter(webhookId, contractId, url, payload, errorMessage) {
  db.prepare(`
    INSERT INTO webhook_dead_letters (webhookId, contractId, url, payload, errorMessage)
    VALUES (?, ?, ?, ?, ?)
  `).run(webhookId, contractId, url, JSON.stringify(payload), errorMessage);
  countWrite();
}

export function listDeadLetters(contractId, limit = 50) {
  return db
    .prepare(
      `SELECT id, webhookId, contractId, url, payload, errorMessage, retryCount, createdAt, lastAttemptAt
       FROM webhook_dead_letters
       WHERE contractId = ? AND retryCount < 10
       ORDER BY createdAt ASC
       LIMIT ?`,
    )
    .all(contractId, limit);
}

export function listAllPendingDeadLetters(limit = 100) {
  return db
    .prepare(
      `SELECT id, webhookId, contractId, url, payload, errorMessage, retryCount, createdAt, lastAttemptAt
       FROM webhook_dead_letters
       WHERE retryCount < 10
       ORDER BY createdAt ASC
       LIMIT ?`,
    )
    .all(limit);
}

export function markDeadLetterRetried(id, succeeded) {
  if (succeeded) {
    db.prepare(`DELETE FROM webhook_dead_letters WHERE id = ?`).run(id);
  } else {
    db.prepare(
      `UPDATE webhook_dead_letters
       SET retryCount = retryCount + 1, lastAttemptAt = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(id);
  }
  countWrite();
}
