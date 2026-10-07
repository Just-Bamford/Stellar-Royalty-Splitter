/**
 * Marketplace event persistence — closes #928.
 *
 * Stores received marketplace webhook events (currently OpenSea) for two
 * purposes:
 *   1. Idempotency/dedup — the same provider event id delivered twice must
 *      only ever result in one recorded royalty.
 *   2. Audit trail — a queryable record of every marketplace event received,
 *      independent of `audit_log` (which only records the resulting
 *      `secondary_sale_recorded` action, not the raw webhook delivery).
 *
 * Also stores the per-contract "auto-recording enabled" toggle referenced
 * by the #928 issue's settings requirement (the actual UI checkbox is a
 * frontend concern and out of scope here — see the route file for details).
 */

import { db, countWrite } from "./core.js";

/**
 * Return the stored marketplace event row for `provider` + `eventId`, or
 * null if this event has not been seen before.
 *
 * @param {string} provider  e.g. "opensea"
 * @param {string} eventId   provider-assigned event id
 * @returns {object | null}
 */
export function getMarketplaceEvent(provider, eventId) {
  return (
    db
      .prepare(
        `SELECT id, provider, eventId, contractId, nftId, status, royaltyAmount, createdAt
         FROM marketplace_events
         WHERE provider = ? AND eventId = ?`
      )
      .get(provider, eventId) ?? null
  );
}

/**
 * Record a newly-processed marketplace event.
 *
 * Relies on the UNIQUE(provider, eventId) constraint for idempotency: if a
 * duplicate delivery races this insert, the unique constraint throws
 * SQLITE_CONSTRAINT_UNIQUE, which callers should treat as "already recorded"
 * rather than an error (mirrors the pattern in
 * `routes/secondary-royalty.js`'s recordSecondarySale conflict handling).
 *
 * @param {object} event
 * @param {string} event.provider
 * @param {string} event.eventId
 * @param {string} event.contractId
 * @param {string} event.nftId
 * @param {string} event.salePrice
 * @param {string} event.royaltyAmount
 * @param {string} [event.status]   default "recorded"
 * @param {object} [event.rawPayload]
 * @returns {{ id: number|bigint }}
 */
export function recordMarketplaceEvent({
  provider,
  eventId,
  contractId,
  nftId,
  salePrice,
  royaltyAmount,
  status = "recorded",
  rawPayload = null,
}) {
  const stmt = db.prepare(`
    INSERT INTO marketplace_events
      (provider, eventId, contractId, nftId, salePrice, royaltyAmount, status, rawPayload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    provider,
    eventId,
    contractId,
    nftId,
    salePrice.toString(),
    royaltyAmount.toString(),
    status,
    rawPayload ? JSON.stringify(rawPayload) : null
  );
  countWrite();
  return { id: result.lastInsertRowid };
}

/**
 * Update the status of a previously-recorded marketplace event (e.g.
 * "recorded" -> "contract_call_failed" -> "recorded" after a retry
 * succeeds).
 *
 * @param {string} provider
 * @param {string} eventId
 * @param {string} status
 */
export function updateMarketplaceEventStatus(provider, eventId, status) {
  db.prepare(
    `UPDATE marketplace_events SET status = ? WHERE provider = ? AND eventId = ?`
  ).run(status, provider, eventId);
  countWrite();
}

/**
 * List marketplace events for a contract (audit trail read path).
 *
 * @param {string} contractId
 * @param {number} [limit]
 * @param {number} [offset]
 */
export function getMarketplaceEventsByContract(contractId, limit = 50, offset = 0) {
  return db
    .prepare(
      `SELECT id, provider, eventId, contractId, nftId, salePrice, royaltyAmount, status, createdAt
       FROM marketplace_events
       WHERE contractId = ?
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(contractId, limit, offset);
}

// ─── Per-contract marketplace auto-recording setting ───────────────────────

/**
 * Return whether marketplace auto-recording is enabled for `contractId`.
 * Defaults to enabled (true) when no explicit setting has been saved, to
 * match the "auto-detect resales" behavior the issue describes as the
 * default expected state.
 *
 * @param {string} contractId
 * @returns {{ contractId: string, autoRecordingEnabled: boolean, updatedAt: string|null }}
 */
export function getMarketplaceSettings(contractId) {
  const row = db
    .prepare(
      `SELECT contractId, autoRecordingEnabled, updatedAt
       FROM marketplace_settings
       WHERE contractId = ?`
    )
    .get(contractId);

  if (!row) {
    return { contractId, autoRecordingEnabled: true, updatedAt: null };
  }
  return { ...row, autoRecordingEnabled: !!row.autoRecordingEnabled };
}

/**
 * Upsert the marketplace auto-recording toggle for `contractId`.
 *
 * @param {string} contractId
 * @param {boolean} autoRecordingEnabled
 * @returns {{ contractId: string, autoRecordingEnabled: boolean, updatedAt: string }}
 */
export function saveMarketplaceSettings(contractId, autoRecordingEnabled) {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO marketplace_settings (contractId, autoRecordingEnabled, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(contractId)
    DO UPDATE SET autoRecordingEnabled = excluded.autoRecordingEnabled,
                  updatedAt            = excluded.updatedAt
  `).run(contractId, autoRecordingEnabled ? 1 : 0, now);

  countWrite();

  return { contractId, autoRecordingEnabled, updatedAt: now };
}
