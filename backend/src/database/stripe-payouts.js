/**
 * Stripe fiat payout persistence — closes #924.
 *
 * Two tables, created by the `initializeDatabase` migration in `core.js`
 * (version 16):
 *   stripe_accounts        — one linked Stripe Connect account per wallet
 *   stripe_payouts         — payout records (status pending -> completed/failed)
 *   stripe_webhook_events  — dedupe log for inbound Stripe webhook events
 *
 * Mirrors the exact query/schema convention established in
 * `src/database/sms-preferences.js` (#927): raw SQL via `db.prepare`,
 * upsert-then-read helpers, and `countWrite()` after every mutation for WAL
 * checkpointing.
 */

import { db, countWrite } from "./core.js";

// ── Stripe Connect accounts ─────────────────────────────────────────────────

/**
 * Return the linked Stripe account for `walletAddress`, or null.
 *
 * @param {string} walletAddress
 * @returns {{ walletAddress: string, stripeAccountId: string, status: string, createdAt: string, updatedAt: string } | null}
 */
export function getStripeAccount(walletAddress) {
  return (
    db
      .prepare(
        `SELECT walletAddress, stripeAccountId, status, createdAt, updatedAt
         FROM stripe_accounts
         WHERE walletAddress = ?`
      )
      .get(walletAddress) ?? null
  );
}

/**
 * Upsert the linked Stripe Connect account for `walletAddress`.
 *
 * @param {string} walletAddress
 * @param {{ stripeAccountId: string, status?: 'pending'|'connected'|'disconnected' }} fields
 * @returns {{ walletAddress: string, stripeAccountId: string, status: string, createdAt: string, updatedAt: string }}
 */
export function saveStripeAccount(walletAddress, { stripeAccountId, status = "connected" }) {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO stripe_accounts (walletAddress, stripeAccountId, status, updatedAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(walletAddress)
     DO UPDATE SET stripeAccountId = excluded.stripeAccountId,
                   status          = excluded.status,
                   updatedAt       = excluded.updatedAt`
  ).run(walletAddress, stripeAccountId, status, now);

  countWrite();
  return getStripeAccount(walletAddress);
}

// ── Payouts ──────────────────────────────────────────────────────────────────

/**
 * Record a newly created payout.
 *
 * @param {object} params
 * @param {string} params.walletAddress
 * @param {string} params.stripeAccountId
 * @param {string} [params.stripePayoutId]  Stripe's payout id, once known
 * @param {string} params.amountXlm         XLM amount as a decimal string
 * @param {number} params.amountUsdCents    converted USD amount, in cents
 * @param {string} params.xlmUsdRate        the XLM/USD rate used for conversion, as a string
 * @param {'once'|'weekly'|'monthly'} [params.frequency]
 * @param {'pending'|'in_transit'|'completed'|'failed'} [params.status]
 * @returns {{ id: number|bigint }}
 */
export function recordStripePayout({
  walletAddress,
  stripeAccountId,
  stripePayoutId = null,
  amountXlm,
  amountUsdCents,
  xlmUsdRate,
  frequency = "once",
  status = "pending",
}) {
  const result = db
    .prepare(
      `INSERT INTO stripe_payouts
         (walletAddress, stripeAccountId, stripePayoutId, amountXlm, amountUsdCents, xlmUsdRate, frequency, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      walletAddress,
      stripeAccountId,
      stripePayoutId,
      amountXlm,
      amountUsdCents,
      xlmUsdRate,
      frequency,
      status
    );
  countWrite();
  return { id: result.lastInsertRowid };
}

/**
 * Return a single payout record by its local database id.
 *
 * @param {number|bigint} id
 */
export function getStripePayoutById(id) {
  return (
    db
      .prepare(
        `SELECT id, walletAddress, stripeAccountId, stripePayoutId, amountXlm, amountUsdCents,
                xlmUsdRate, frequency, status, failureReason, createdAt, updatedAt
         FROM stripe_payouts
         WHERE id = ?`
      )
      .get(id) ?? null
  );
}

/**
 * Return a single payout record by Stripe's payout id (used by the webhook
 * handler to resolve the local row for an inbound event).
 *
 * @param {string} stripePayoutId
 */
export function getStripePayoutByStripeId(stripePayoutId) {
  return (
    db
      .prepare(
        `SELECT id, walletAddress, stripeAccountId, stripePayoutId, amountXlm, amountUsdCents,
                xlmUsdRate, frequency, status, failureReason, createdAt, updatedAt
         FROM stripe_payouts
         WHERE stripePayoutId = ?`
      )
      .get(stripePayoutId) ?? null
  );
}

/**
 * Return the payout history for `walletAddress`, newest first.
 *
 * @param {string} walletAddress
 * @param {{ limit?: number, offset?: number }} [options]
 */
export function listStripePayoutsByWallet(walletAddress, { limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  return db
    .prepare(
      `SELECT id, walletAddress, stripeAccountId, stripePayoutId, amountXlm, amountUsdCents,
              xlmUsdRate, frequency, status, failureReason, createdAt, updatedAt
       FROM stripe_payouts
       WHERE walletAddress = ?
       ORDER BY createdAt DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(walletAddress, safeLimit, safeOffset);
}

/**
 * Mark a payout as failed by its local row id. Used when the Stripe API call
 * to create the payout itself fails — i.e. before a stripePayoutId ever
 * exists to key an update off of. Once a payout has a stripePayoutId, status
 * transitions are driven by the webhook via
 * {@link updateStripePayoutStatusByStripeId} instead.
 *
 * @param {number|bigint} id
 * @param {string} reason
 */
export function markStripePayoutFailedById(id, reason) {
  const now = new Date().toISOString();
  const result = db
    .prepare(`UPDATE stripe_payouts SET status = 'failed', failureReason = ?, updatedAt = ? WHERE id = ?`)
    .run(reason, now, id);
  if (result.changes > 0) countWrite();
  return getStripePayoutById(id);
}

/**
 * Attach the Stripe-assigned payout id to a locally-created payout row, once
 * the Stripe API call has returned it.
 *
 * @param {number|bigint} id  local row id
 * @param {string} stripePayoutId
 */
export function setStripePayoutExternalId(id, stripePayoutId) {
  const now = new Date().toISOString();
  const result = db
    .prepare(`UPDATE stripe_payouts SET stripePayoutId = ?, updatedAt = ? WHERE id = ?`)
    .run(stripePayoutId, now, id);
  if (result.changes > 0) countWrite();
  return getStripePayoutById(id);
}

/**
 * Update a payout's status (e.g. from a webhook event). `failureReason` is
 * only persisted when the new status is 'failed'; it is cleared otherwise.
 *
 * @param {string} stripePayoutId
 * @param {'pending'|'in_transit'|'completed'|'failed'} status
 * @param {{ failureReason?: string|null }} [options]
 */
export function updateStripePayoutStatusByStripeId(stripePayoutId, status, { failureReason = null } = {}) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE stripe_payouts
       SET status = ?, failureReason = ?, updatedAt = ?
       WHERE stripePayoutId = ?`
    )
    .run(status, status === "failed" ? failureReason : null, now, stripePayoutId);
  if (result.changes > 0) countWrite();
  return getStripePayoutByStripeId(stripePayoutId);
}

// ── Webhook event dedupe / audit log ────────────────────────────────────────

/**
 * True when this Stripe event id has already been recorded (idempotency —
 * Stripe may deliver the same webhook event more than once).
 *
 * @param {string} stripeEventId
 */
export function hasProcessedStripeWebhookEvent(stripeEventId) {
  return !!db.prepare(`SELECT 1 FROM stripe_webhook_events WHERE stripeEventId = ?`).get(stripeEventId);
}

/**
 * Record an inbound Stripe webhook event for idempotency + an audit trail of
 * disputes/refunds so an admin can follow up.
 *
 * @param {object} params
 * @param {string} params.stripeEventId
 * @param {string} params.eventType
 * @param {number|bigint} [params.payoutId]  local stripe_payouts.id, when resolved
 * @param {object} [params.payload]
 * @returns {{ id: number|bigint }}
 */
export function recordStripeWebhookEvent({ stripeEventId, eventType, payoutId = null, payload = null }) {
  const result = db
    .prepare(
      `INSERT INTO stripe_webhook_events (stripeEventId, eventType, payoutId, payload)
       VALUES (?, ?, ?, ?)`
    )
    .run(stripeEventId, eventType, payoutId, payload === null ? null : JSON.stringify(payload));
  countWrite();
  return { id: result.lastInsertRowid };
}
