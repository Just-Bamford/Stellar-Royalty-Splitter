/**
 * Stripe fiat payout endpoints — closes #924.
 *
 * Mounted at `/api/v1/payments/stripe`:
 *   POST /connect         — initiate (no code) or complete (with code) the
 *                            Stripe Connect OAuth link for a wallet
 *   POST /payout-request   — convert XLM to USD at market price and create a
 *                            Stripe payout to the collaborator's linked account
 *   GET  /payout-status    — a single payout by id, or the wallet's payout history
 *   POST /webhook           — Stripe webhook receiver (payout + dispute events)
 *
 * Auth follows this codebase's existing convention: the caller identifies
 * themselves by Stellar wallet address (the same convention as
 * `routes/notifications/sms.js` and `routes/preferences.js`), and mutating
 * endpoints additionally require the `operator` role via `requireRole`,
 * matching `routes/crm/salesforce.js` (#939). The inbound webhook is
 * authenticated by Stripe's own signature scheme instead of RBAC, matching
 * `routes/kyc-webhooks.js` (#598) and `routes/crm/salesforce.js` (#939).
 */

import { Router } from "express";
import { z } from "zod";
import { sendError, sendValidationError } from "../../error-response.js";
import logger from "../../logger.js";
import { requireRole } from "../../middleware/rbac.js";
import { validate, stellarAddress } from "../../validation.js";
import {
  getStripeAccount,
  saveStripeAccount,
  recordStripePayout,
  getStripePayoutById,
  getStripePayoutByStripeId,
  listStripePayoutsByWallet,
  setStripePayoutExternalId,
  markStripePayoutFailedById,
  updateStripePayoutStatusByStripeId,
  hasProcessedStripeWebhookEvent,
  recordStripeWebhookEvent,
} from "../../database/stripe-payouts.js";
import {
  isStripeConfigured,
  buildConnectOAuthUrl,
  verifyConnectState,
  exchangeConnectCode,
  createStripePayout,
  verifyStripeWebhookSignature,
} from "../../services/stripe.js";
import { getXlmUsdPrice, xlmToUsdCents } from "../../services/price-oracle.js";
import { sendEventSms } from "../../services/sms-notifications.js";

export const stripeRouter = Router();

// ── Schemas ─────────────────────────────────────────────────────────────────

const connectSchema = z.object({
  walletAddress: stellarAddress,
  redirectUri: z.string().url("redirectUri must be a valid URL"),
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
});

const MIN_PAYOUT_XLM = 1;
const MAX_PAYOUT_XLM = 1_000_000;

const payoutRequestSchema = z.object({
  walletAddress: stellarAddress,
  amount: z
    .number()
    .finite("amount must be a finite number")
    .min(MIN_PAYOUT_XLM, `amount must be at least ${MIN_PAYOUT_XLM} XLM`)
    .max(MAX_PAYOUT_XLM, `amount must be at most ${MAX_PAYOUT_XLM} XLM`),
  frequency: z.enum(["once", "weekly", "monthly"]).optional().default("once"),
});

const payoutStatusQuerySchema = z.object({
  walletAddress: stellarAddress,
  payoutId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

function ensureStripeConfigured(res) {
  if (!isStripeConfigured()) {
    sendError(res, 503, "stripe_not_configured", "STRIPE_SECRET_KEY must be configured");
    return false;
  }
  return true;
}

/** Never leak the raw Stripe account id further than necessary through the API. */
function sanitizeAccount(account) {
  if (!account) return null;
  return {
    walletAddress: account.walletAddress,
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

// ── POST /api/v1/payments/stripe/connect ────────────────────────────────────

stripeRouter.post("/connect", requireRole("operator"), validate(connectSchema), async (req, res, next) => {
  try {
    if (!ensureStripeConfigured(res)) return;
    const { walletAddress, redirectUri, code, state } = req.body;

    // No authorization code yet: initiate the OAuth flow.
    if (!code) {
      const built = buildConnectOAuthUrl({ walletAddress, redirectUri });
      if (!built.ok) {
        return sendError(res, 503, "stripe_connect_not_configured", "Stripe Connect is not configured");
      }
      return res.json({ success: true, data: { authorizeUrl: built.url, state: built.state } });
    }

    // Authorization code present: complete the OAuth flow.
    if (!state) {
      return sendError(res, 400, "missing_state", "state is required to complete the Stripe Connect flow");
    }
    const verified = verifyConnectState(state);
    if (!verified || verified.walletAddress !== walletAddress) {
      return sendError(
        res,
        400,
        "invalid_oauth_state",
        "OAuth state is missing, expired, or does not match the wallet"
      );
    }

    const exchanged = await exchangeConnectCode(code);
    if (!exchanged.ok) {
      return sendError(res, 502, "stripe_oauth_failed", `Stripe Connect OAuth failed: ${exchanged.reason}`);
    }

    const account = saveStripeAccount(walletAddress, {
      stripeAccountId: exchanged.stripeAccountId,
      status: "connected",
    });

    logger.info("Stripe Connect account linked", { walletAddress });
    return res.status(201).json({ success: true, data: sanitizeAccount(account) });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/payments/stripe/payout-request ─────────────────────────────

stripeRouter.post(
  "/payout-request",
  requireRole("operator"),
  validate(payoutRequestSchema),
  async (req, res, next) => {
    try {
      if (!ensureStripeConfigured(res)) return;
      const { walletAddress, amount, frequency } = req.body;

      const account = getStripeAccount(walletAddress);
      if (!account || account.status !== "connected") {
        return sendError(
          res,
          400,
          "stripe_not_connected",
          "No linked Stripe account for this wallet — call POST /connect first"
        );
      }

      const price = await getXlmUsdPrice();
      if (!price.ok) {
        return sendError(res, 502, "price_oracle_unavailable", `Unable to fetch XLM/USD price: ${price.reason}`);
      }

      const amountUsdCents = xlmToUsdCents(amount, price.rate);
      if (amountUsdCents <= 0) {
        return sendError(res, 400, "amount_too_small", "Converted USD amount rounds to zero");
      }

      const created = recordStripePayout({
        walletAddress,
        stripeAccountId: account.stripeAccountId,
        amountXlm: String(amount),
        amountUsdCents,
        xlmUsdRate: String(price.rate),
        frequency,
        status: "pending",
      });

      const payout = await createStripePayout({
        stripeAccountId: account.stripeAccountId,
        amountUsdCents,
        idempotencyKey: `payout-${created.id}`,
      });

      if (!payout.ok) {
        logger.error("Stripe payout creation failed", { walletAddress, payoutRowId: created.id, reason: payout.reason });
        const failed = markStripePayoutFailedById(created.id, payout.reason);
        return sendError(res, 502, "stripe_payout_failed", `Stripe payout creation failed: ${payout.reason}`, {
          payout: failed,
        });
      }

      const updated = setStripePayoutExternalId(created.id, payout.stripePayoutId);
      logger.info("Stripe payout created", {
        walletAddress,
        stripePayoutId: payout.stripePayoutId,
        amountUsdCents,
      });

      return res.status(201).json({
        success: true,
        data: { ...updated, xlmUsdRateSource: price.source },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/payments/stripe/payout-status ────────────────────────────────

stripeRouter.get("/payout-status", requireRole("operator"), (req, res, next) => {
  try {
    const result = payoutStatusQuerySchema.safeParse(req.query);
    if (!result.success) {
      return sendValidationError(
        res,
        result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
      );
    }
    const { walletAddress, payoutId, limit, offset } = result.data;

    if (payoutId) {
      const payout = getStripePayoutById(payoutId);
      if (!payout || payout.walletAddress !== walletAddress) {
        return sendError(res, 404, "not_found", "No payout found for this wallet with that id");
      }
      return res.json({ success: true, data: payout });
    }

    const payouts = listStripePayoutsByWallet(walletAddress, { limit, offset });
    return res.json({ success: true, data: payouts, pagination: { limit, offset } });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/v1/payments/stripe/webhook ─────────────────────────────────────

const DISPUTE_EVENT_TYPES = new Set(["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"]);
const REFUND_EVENT_TYPES = new Set(["charge.refunded", "refund.created", "refund.updated"]);

stripeRouter.post("/webhook", async (req, res, next) => {
  try {
    const signature = req.get("stripe-signature");
    const rawBody = req.rawBody ?? (typeof req.body === "string" ? req.body : JSON.stringify(req.body));

    const verified = verifyStripeWebhookSignature({ rawBody, signature });
    if (!verified.ok) {
      logger.warn("Stripe webhook signature verification failed", { reason: verified.reason, ip: req.ip });
      return sendError(res, 401, "invalid_signature", "Webhook signature verification failed");
    }

    const event = verified.event;

    // Idempotency: Stripe may deliver the same event more than once.
    if (hasProcessedStripeWebhookEvent(event.id)) {
      return res.status(200).json({ success: true, data: { deduped: true } });
    }

    const payoutObject = event.data?.object;
    let payoutRow = null;

    if (event.type === "payout.paid") {
      payoutRow = updateStripePayoutStatusByStripeId(payoutObject?.id, "completed");
      if (payoutRow) {
        logger.info("Stripe payout completed", { stripePayoutId: payoutObject.id, walletAddress: payoutRow.walletAddress });
      }
    } else if (event.type === "payout.failed" || event.type === "payout.canceled") {
      const reason = payoutObject?.failure_message || payoutObject?.failure_code || "unknown";
      payoutRow = updateStripePayoutStatusByStripeId(payoutObject?.id, "failed", { failureReason: reason });
      if (payoutRow) {
        logger.warn("Stripe payout failed", { stripePayoutId: payoutObject.id, walletAddress: payoutRow.walletAddress, reason });
        // Reuse the existing SMS notification dispatch (#927) rather than
        // building a new "notify the user" call site.
        await sendEventSms(payoutRow.walletAddress, "payment_failed", {
          contractId: "stripe-payout",
          reason,
        });
      }
    } else if (event.type === "payout.updated") {
      const stripeStatus = payoutObject?.status;
      if (stripeStatus === "in_transit") {
        payoutRow = updateStripePayoutStatusByStripeId(payoutObject?.id, "in_transit");
      }
    } else if (DISPUTE_EVENT_TYPES.has(event.type) || REFUND_EVENT_TYPES.has(event.type)) {
      // Out of scope: a full dispute-resolution flow. Just record the event
      // so an admin can follow up, per the #924 acceptance criteria.
      if (payoutObject?.payout) {
        payoutRow = getStripePayoutByStripeId(payoutObject.payout);
      }
      logger.warn("Stripe dispute/refund event received", { type: event.type, id: event.id });
    } else {
      logger.info("Unhandled Stripe webhook event type", { type: event.type });
    }

    recordStripeWebhookEvent({
      stripeEventId: event.id,
      eventType: event.type,
      payoutId: payoutRow?.id ?? null,
      payload: { type: event.type, objectId: payoutObject?.id ?? null },
    });

    return res.status(200).json({ success: true, data: { received: true } });
  } catch (err) {
    next(err);
  }
});

export default stripeRouter;
