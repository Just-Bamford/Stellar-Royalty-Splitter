/**
 * Stripe wrapper — closes #924.
 *
 * Thin wrapper around the `stripe` npm package, mirroring the error-handling
 * style of `src/services/twilio-sms.js` (#927): never throws synchronously,
 * always resolves to a typed result object indicating success/failure so
 * callers can persist delivery status without a try/catch at every call
 * site. Connect OAuth state signing mirrors `services/salesforce.js` (#939)
 * (`createOAuthState` / `verifyOAuthState`).
 *
 * Configuration (env):
 *   STRIPE_SECRET_KEY       — Stripe secret key (sk_...)
 *   STRIPE_CONNECT_CLIENT_ID — Stripe Connect application client id (ca_...),
 *                              required to build the OAuth authorize URL
 *   STRIPE_WEBHOOK_SECRET    — signing secret for verifying inbound webhooks
 */

import crypto from "crypto";
import Stripe from "stripe";
import logger from "../logger.js";

export const DEFAULT_STRIPE_CONNECT_OAUTH_URL = "https://connect.stripe.com/oauth/authorize";
export const DEFAULT_STRIPE_API_VERSION = "2024-06-20";

let cachedClient = null;
let cachedClientKey = null;

/**
 * Lazily construct (and cache) the Stripe SDK client for the configured
 * secret key. Returns null when unconfigured so callers can short-circuit
 * with a typed result instead of the SDK throwing.
 */
function getClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  if (cachedClient && cachedClientKey === secretKey) return cachedClient;
  cachedClient = new Stripe(secretKey, { apiVersion: DEFAULT_STRIPE_API_VERSION });
  cachedClientKey = secretKey;
  return cachedClient;
}

/** True when STRIPE_SECRET_KEY is present in the environment. */
export function isStripeConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

/** Reset the cached Stripe client. Exposed for tests that swap env vars between cases. */
export function resetStripeClientCache() {
  cachedClient = null;
  cachedClientKey = null;
}

function stripeErrorReason(error) {
  return error?.raw?.message || error?.message || "stripe_error";
}

// ── Connect OAuth ────────────────────────────────────────────────────────────

/**
 * Build the Stripe Connect OAuth authorize URL the collaborator's browser
 * opens to link their Stripe account for payouts.
 *
 * @param {object} params
 * @param {string} params.walletAddress   bound into the signed `state` param
 * @param {string} params.redirectUri
 * @param {string} [params.clientId]      defaults to STRIPE_CONNECT_CLIENT_ID
 * @param {string} [params.state]         pre-computed signed state (see createConnectState); generated if omitted and a secret is available
 * @returns {{ ok: true, url: string, state: string } | { ok: false, reason: string }}
 */
export function buildConnectOAuthUrl({ walletAddress, redirectUri, clientId, state } = {}) {
  const resolvedClientId = clientId || process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!resolvedClientId) {
    return { ok: false, reason: "stripe_connect_not_configured" };
  }
  if (!walletAddress) {
    return { ok: false, reason: "missing_wallet_address" };
  }
  if (!redirectUri) {
    return { ok: false, reason: "missing_redirect_uri" };
  }

  let resolvedState = state;
  if (!resolvedState) {
    const created = createConnectState(walletAddress);
    if (!created.ok) return created;
    resolvedState = created.state;
  }

  const url = new URL(DEFAULT_STRIPE_CONNECT_OAUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", resolvedClientId);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", resolvedState);

  return { ok: true, url: url.toString(), state: resolvedState };
}

/**
 * Create a tamper-proof, expiring OAuth `state` value bound to a wallet
 * address, so a leaked state cannot be replayed to link a different wallet.
 * Uses STRIPE_SECRET_KEY as the signing secret (rotating it invalidates any
 * in-flight OAuth link attempts, same tradeoff as the Salesforce integration).
 *
 * @param {string} walletAddress
 * @param {{ ttlMs?: number, now?: number }} [options]
 */
export function createConnectState(walletAddress, { ttlMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return { ok: false, reason: "stripe_not_configured" };

  const body = Buffer.from(
    JSON.stringify({ w: walletAddress, n: crypto.randomBytes(8).toString("hex"), e: now + ttlMs })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return { ok: true, state: `${body}.${signature}` };
}

/**
 * Verify + decode a state produced by {@link createConnectState}.
 *
 * @param {string} state
 * @returns {{ walletAddress: string } | null}
 */
export function verifyConnectState(state, { now = Date.now() } = {}) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (typeof state !== "string" || !secret) return null;

  const separator = state.indexOf(".");
  if (separator === -1) return null;
  const body = state.slice(0, separator);
  const provided = state.slice(separator + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.e !== "number" || parsed.e < now || !parsed.w) return null;
    return { walletAddress: parsed.w };
  } catch {
    return null;
  }
}

/**
 * Exchange a Stripe Connect OAuth authorization code for the collaborator's
 * connected Stripe account id. Never throws.
 *
 * @param {string} code
 * @returns {Promise<{ ok: true, stripeAccountId: string } | { ok: false, reason: string }>}
 */
export async function exchangeConnectCode(code) {
  const client = getClient();
  if (!client) return { ok: false, reason: "stripe_not_configured" };
  if (!code) return { ok: false, reason: "missing_code" };

  try {
    const response = await client.oauth.token({
      grant_type: "authorization_code",
      code,
    });
    if (!response?.stripe_user_id) {
      return { ok: false, reason: "missing_stripe_user_id" };
    }
    return { ok: true, stripeAccountId: response.stripe_user_id };
  } catch (error) {
    logger.error("Stripe Connect OAuth token exchange failed", { error: stripeErrorReason(error) });
    return { ok: false, reason: stripeErrorReason(error) };
  }
}

// ── Payouts ──────────────────────────────────────────────────────────────────

/**
 * Create a payout to a collaborator's linked Stripe bank account, on their
 * connected account (Stripe Connect "destination" payout).
 *
 * @param {object} params
 * @param {string} params.stripeAccountId  the connected account id (acct_...)
 * @param {number} params.amountUsdCents   payout amount, integer USD cents
 * @param {string} [params.currency]       defaults to "usd"
 * @param {string} [params.idempotencyKey] passed through to Stripe to make retries safe
 * @returns {Promise<{ ok: true, stripePayoutId: string, status: string } | { ok: false, reason: string }>}
 */
export async function createStripePayout({ stripeAccountId, amountUsdCents, currency = "usd", idempotencyKey } = {}) {
  const client = getClient();
  if (!client) return { ok: false, reason: "stripe_not_configured" };
  if (!stripeAccountId) return { ok: false, reason: "missing_stripe_account_id" };
  if (!Number.isInteger(amountUsdCents) || amountUsdCents <= 0) {
    return { ok: false, reason: "invalid_amount" };
  }

  try {
    const payout = await client.payouts.create(
      { amount: amountUsdCents, currency },
      { stripeAccount: stripeAccountId, ...(idempotencyKey ? { idempotencyKey } : {}) }
    );
    return { ok: true, stripePayoutId: payout.id, status: payout.status };
  } catch (error) {
    logger.error("Stripe payout creation failed", {
      stripeAccountId,
      amountUsdCents,
      error: stripeErrorReason(error),
    });
    return { ok: false, reason: stripeErrorReason(error) };
  }
}

/**
 * Look up the current status of a payout directly from Stripe (used as a
 * fallback when a webhook has not yet landed).
 *
 * @param {object} params
 * @param {string} params.stripeAccountId
 * @param {string} params.stripePayoutId
 * @returns {Promise<{ ok: true, status: string } | { ok: false, reason: string }>}
 */
export async function getStripePayoutStatus({ stripeAccountId, stripePayoutId } = {}) {
  const client = getClient();
  if (!client) return { ok: false, reason: "stripe_not_configured" };
  if (!stripeAccountId || !stripePayoutId) return { ok: false, reason: "missing_identifiers" };

  try {
    const payout = await client.payouts.retrieve(stripePayoutId, { stripeAccount: stripeAccountId });
    return { ok: true, status: payout.status };
  } catch (error) {
    logger.error("Stripe payout status lookup failed", {
      stripeAccountId,
      stripePayoutId,
      error: stripeErrorReason(error),
    });
    return { ok: false, reason: stripeErrorReason(error) };
  }
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * Verify + parse an inbound Stripe webhook payload using the SDK's own
 * constant-time signature verification (`Stripe-Signature` header, HMAC-SHA256
 * over `{timestamp}.{rawBody}`, tolerant of multiple `v1=` signatures).
 * Never throws — the SDK's verification error is caught and returned as a
 * typed result, matching every other wrapper in this file.
 *
 * @param {object} params
 * @param {string|Buffer} params.rawBody  the exact bytes Stripe signed (not the re-serialized parsed body)
 * @param {string} params.signature       the `Stripe-Signature` header value
 * @returns {{ ok: true, event: object } | { ok: false, reason: string }}
 */
export function verifyStripeWebhookSignature({ rawBody, signature } = {}) {
  const client = getClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "stripe_webhook_not_configured" };
  if (!client) return { ok: false, reason: "stripe_not_configured" };
  if (!signature) return { ok: false, reason: "missing_signature" };

  try {
    const event = client.webhooks.constructEvent(rawBody, signature, secret);
    return { ok: true, event };
  } catch (error) {
    logger.warn("Stripe webhook signature verification failed", { error: error?.message });
    return { ok: false, reason: "invalid_signature" };
  }
}
