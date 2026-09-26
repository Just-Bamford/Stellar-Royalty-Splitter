/**
 * XLM/USD price oracle — new scope added for #924.
 *
 * No price-conversion source existed anywhere in this codebase prior to this
 * change (checked for "oracle" / "xlm.*usd" case-insensitively across
 * `backend/src` — the CRM/QuickBooks/OpenSea integrations only ever move XLM
 * or stroop amounts around verbatim, they never convert to fiat). This is a
 * minimal, typed, dependency-free market-price lookup so the Stripe payout
 * flow can convert a collaborator's XLM balance to USD before creating a
 * payout.
 *
 * Source: CoinGecko's public simple-price endpoint (no API key required).
 * Configurable via PRICE_ORACLE_URL for self-hosting/mirroring. Mirrors the
 * "never throw synchronously, resolve to a typed result object" convention
 * used by `services/twilio-sms.js` (#927) and the Salesforce OAuth client
 * (#939) so callers never need a try/catch around a price lookup.
 */

import logger from "../logger.js";

export const DEFAULT_PRICE_ORACLE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd";

/** Cache the last successful lookup briefly to avoid hammering the upstream API on retries/bursts. */
const DEFAULT_CACHE_TTL_MS = 60_000;
let cached = null; // { rate, fetchedAt }

/**
 * Fetch the current XLM/USD market price.
 *
 * Never throws — network failures, non-2xx responses, and malformed payloads
 * all resolve to `{ ok: false, reason }` so callers can respond with a clean
 * error instead of a 500.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]  injected for tests; defaults to global fetch
 * @param {string} [options.url]              override the oracle URL (defaults to PRICE_ORACLE_URL env or the CoinGecko default)
 * @param {number} [options.cacheTtlMs]       how long a successful lookup is reused (default 60s); 0 disables the cache
 * @param {boolean} [options.bypassCache]     force a fresh fetch even if a cached value is still valid
 * @returns {Promise<{ ok: true, rate: number, source: string, fetchedAt: string } | { ok: false, reason: string }>}
 */
export async function getXlmUsdPrice({
  fetchImpl = globalThis.fetch,
  url = process.env.PRICE_ORACLE_URL || DEFAULT_PRICE_ORACLE_URL,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  bypassCache = false,
} = {}) {
  if (!bypassCache && cacheTtlMs > 0 && cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
    return { ok: true, rate: cached.rate, source: "cache", fetchedAt: new Date(cached.fetchedAt).toISOString() };
  }

  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "fetch_unavailable" };
  }

  let res;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    logger.error("Price oracle request failed", { error: err?.message ?? String(err) });
    return { ok: false, reason: "network_error" };
  }

  if (!res.ok) {
    logger.error("Price oracle returned a non-2xx response", { status: res.status });
    return { ok: false, reason: `upstream_error_${res.status}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }

  const rate = Number(data?.stellar?.usd);
  if (!Number.isFinite(rate) || rate <= 0) {
    return { ok: false, reason: "invalid_price" };
  }

  cached = { rate, fetchedAt: Date.now() };
  return { ok: true, rate, source: "coingecko", fetchedAt: new Date(cached.fetchedAt).toISOString() };
}

/** Clears the in-memory price cache. Exposed for tests. */
export function resetPriceCache() {
  cached = null;
}

/**
 * Convert an XLM amount to USD cents at the given rate.
 * Pure helper, kept separate from the network call so it is trivially
 * unit-testable and reusable at both request time and in tests.
 *
 * @param {number|string} amountXlm
 * @param {number} rate  USD per 1 XLM
 * @returns {number} USD amount in integer cents (rounded to nearest cent)
 */
export function xlmToUsdCents(amountXlm, rate) {
  const amount = Number(amountXlm);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(rate) || rate < 0) {
    throw new Error("xlmToUsdCents requires a non-negative finite amount and rate");
  }
  return Math.round(amount * rate * 100);
}
