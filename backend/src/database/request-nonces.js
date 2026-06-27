/**
 * Permanent per-contract request nonce dedup (#421).
 *
 * Distinct from idempotency.js: that mechanism caches and replays a
 * response for 24h. This permanently rejects (409, no replay) any second
 * use of the same (contractId, nonce) pair, so it also distinguishes an
 * intentional retry (client reuses a nonce on purpose) from an accidental
 * duplicate submission.
 */

import { db, countWrite } from "./core.js";

/**
 * Record a nonce for a contract if it hasn't been seen before.
 * Returns true if newly recorded, false if (contractId, nonce) already exists.
 */
export function recordNonceIfNew(contractId, nonce) {
  const stmt = db.prepare(`
    INSERT INTO request_nonces (contractId, nonce)
    VALUES (?, ?)
    ON CONFLICT(contractId, nonce) DO NOTHING
  `);

  const result = stmt.run(contractId, nonce);
  if (result.changes > 0) {
    countWrite();
    return true;
  }
  return false;
}
