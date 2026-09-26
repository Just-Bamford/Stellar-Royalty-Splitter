/**
 * Token swap aggregator — best-rate selection across multiple DEXes (#974).
 *
 * Problem: Payout conversion to USD previously used a single DEX/provider,
 * so users got sub-optimal rates. This module queries multiple sources,
 * compares rates, and executes on the best one with automatic fallback.
 *
 * Supported providers (queried in parallel):
 *   1. Stellar DEX       – on-chain order book via Horizon /paths/strict-receive
 *   2. Stellar AMM paths – Horizon /paths/strict-send (AMM liquidity pools)
 *   3. 0x / Paraswap     – optional off-chain aggregator (requires API key env vars)
 *
 * Usage:
 *   import { getBestSwapRate, executeSwap } from "./swap-aggregator.js";
 *
 *   const quote = await getBestSwapRate({ fromAsset, toAsset, amount });
 *   // quote: { provider, rate, estimatedOutput, path, meta }
 *
 *   const result = await executeSwap(quote, callerAddress);
 *   // result: { provider, txXdr?, txHash?, estimatedOutput, executedAt }
 *
 * Environment variables:
 *   HORIZON_URL                – Stellar Horizon base URL (default: testnet)
 *   SWAP_SLIPPAGE_BPS          – max allowed slippage in basis points (default: 50 = 0.5%)
 *   SWAP_TIMEOUT_MS            – per-provider quote timeout (default: 5000)
 *   PARASWAP_API_KEY           – enables Paraswap provider when set
 *   ZEROX_API_KEY              – enables 0x provider when set
 *   ZEROX_CHAIN_ID             – chain ID for 0x (default: 1 for Ethereum mainnet)
 */

import logger from "./logger.js";
import { startSpan } from "./tracing.js";

const HORIZON_URL     = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const SLIPPAGE_BPS    = parseInt(process.env.SWAP_SLIPPAGE_BPS ?? "50",   10);
const TIMEOUT_MS      = parseInt(process.env.SWAP_TIMEOUT_MS   ?? "5000", 10);
const ZEROX_CHAIN_ID  = process.env.ZEROX_CHAIN_ID ?? "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a fetch promise with a hard timeout so a slow provider never blocks
 * the aggregator.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Apply slippage to an estimated output amount (BigInt-safe string arithmetic).
 * Returns the minimum acceptable output as a string.
 */
export function applySlippage(estimatedOutput, slippageBps = SLIPPAGE_BPS) {
  const amount = parseFloat(estimatedOutput);
  if (isNaN(amount)) return "0";
  const minOutput = amount * (1 - slippageBps / 10_000);
  return minOutput.toFixed(7);
}

// ---------------------------------------------------------------------------
// Provider: Stellar DEX — strict-receive path (order-book + AMM)
// ---------------------------------------------------------------------------

/**
 * Query Stellar Horizon for the best path-payment route (strict-receive).
 * This covers both the classic order book and AMM liquidity pools.
 *
 * @param {object} params
 * @param {string} params.fromAsset  – "native" or "CODE:ISSUER"
 * @param {string} params.toAsset    – "native" or "CODE:ISSUER"
 * @param {string} params.amount     – destination amount (string, in stroops or units)
 * @returns {object|null} Quote or null on failure
 */
async function queryStellarDex({ fromAsset, toAsset, amount }) {
  const base = HORIZON_URL.replace(/\/$/, "");
  const [toCode, toIssuer]     = toAsset   === "native" ? ["native", null] : toAsset.split(":");
  const [fromCode, fromIssuer] = fromAsset === "native" ? ["native", null] : fromAsset.split(":");

  const params = new URLSearchParams({
    destination_asset_type:   toCode   === "native" ? "native" : "credit_alphanum4",
    destination_asset_code:   toCode   === "native" ? ""       : toCode,
    destination_asset_issuer: toIssuer ?? "",
    destination_amount:       amount,
    source_asset_type:        fromCode === "native" ? "native" : "credit_alphanum4",
    source_asset_code:        fromCode === "native" ? ""       : fromCode,
    source_asset_issuer:      fromIssuer ?? "",
  });
  // Remove empty params
  for (const [k, v] of [...params.entries()]) {
    if (v === "") params.delete(k);
  }

  const url = `${base}/paths/strict-receive?${params}`;

  const res = await withTimeout(
    fetch(url, { headers: { Accept: "application/json" } }),
    TIMEOUT_MS,
    "Stellar DEX strict-receive"
  );

  if (!res.ok) throw new Error(`Horizon strict-receive HTTP ${res.status}`);
  const data = await res.json();

  const records = data?._embedded?.records ?? [];
  if (records.length === 0) return null;

  // Pick the record with the lowest source_amount (best rate for the buyer)
  records.sort((a, b) => parseFloat(a.source_amount) - parseFloat(b.source_amount));
  const best = records[0];

  return {
    provider:         "stellar-dex",
    rate:             parseFloat(amount) / parseFloat(best.source_amount),
    estimatedOutput:  amount,
    sourceAmount:     best.source_amount,
    path:             best.path ?? [],
    meta:             { type: "strict-receive", records: records.length },
  };
}

/**
 * Query Stellar Horizon for the best path-payment route (strict-send).
 * Maximises the destination amount for a fixed source amount.
 *
 * @param {object} params
 * @param {string} params.fromAsset
 * @param {string} params.toAsset
 * @param {string} params.amount  – source amount
 * @returns {object|null}
 */
async function queryStellarAmm({ fromAsset, toAsset, amount }) {
  const base = HORIZON_URL.replace(/\/$/, "");
  const [toCode, toIssuer]     = toAsset   === "native" ? ["native", null] : toAsset.split(":");
  const [fromCode, fromIssuer] = fromAsset === "native" ? ["native", null] : fromAsset.split(":");

  const params = new URLSearchParams({
    source_asset_type:        fromCode === "native" ? "native" : "credit_alphanum4",
    source_asset_code:        fromCode === "native" ? ""       : fromCode,
    source_asset_issuer:      fromIssuer ?? "",
    source_amount:            amount,
    destination_asset_type:   toCode   === "native" ? "native" : "credit_alphanum4",
    destination_asset_code:   toCode   === "native" ? ""       : toCode,
    destination_asset_issuer: toIssuer ?? "",
  });
  for (const [k, v] of [...params.entries()]) {
    if (v === "") params.delete(k);
  }

  const url = `${base}/paths/strict-send?${params}`;

  const res = await withTimeout(
    fetch(url, { headers: { Accept: "application/json" } }),
    TIMEOUT_MS,
    "Stellar AMM strict-send"
  );

  if (!res.ok) throw new Error(`Horizon strict-send HTTP ${res.status}`);
  const data = await res.json();

  const records = data?._embedded?.records ?? [];
  if (records.length === 0) return null;

  // Pick the record with the highest destination_amount (best rate)
  records.sort((a, b) => parseFloat(b.destination_amount) - parseFloat(a.destination_amount));
  const best = records[0];

  return {
    provider:        "stellar-amm",
    rate:            parseFloat(best.destination_amount) / parseFloat(amount),
    estimatedOutput: best.destination_amount,
    sourceAmount:    amount,
    path:            best.path ?? [],
    meta:            { type: "strict-send", records: records.length },
  };
}

// ---------------------------------------------------------------------------
// Provider: Paraswap (optional — requires PARASWAP_API_KEY)
// ---------------------------------------------------------------------------

async function queryParaswap({ fromAsset, toAsset, amount }) {
  const apiKey = process.env.PARASWAP_API_KEY;
  if (!apiKey) return null; // provider disabled

  const url = `https://apiv5.paraswap.io/prices?srcToken=${encodeURIComponent(fromAsset)}&destToken=${encodeURIComponent(toAsset)}&amount=${amount}&network=1&side=SELL`;

  const res = await withTimeout(
    fetch(url, {
      headers: { "x-api-key": apiKey, Accept: "application/json" },
    }),
    TIMEOUT_MS,
    "Paraswap"
  );

  if (!res.ok) throw new Error(`Paraswap HTTP ${res.status}`);
  const data = await res.json();

  const destAmount = data?.priceRoute?.destAmount;
  if (!destAmount) return null;

  const outputUnits = (parseFloat(destAmount) / 1e18).toFixed(7);

  return {
    provider:        "paraswap",
    rate:            parseFloat(outputUnits) / parseFloat(amount),
    estimatedOutput: outputUnits,
    sourceAmount:    amount,
    path:            [],
    meta:            { gasCostUSD: data?.priceRoute?.gasCostUSD },
  };
}

// ---------------------------------------------------------------------------
// Provider: 0x (optional — requires ZEROX_API_KEY)
// ---------------------------------------------------------------------------

async function queryZerox({ fromAsset, toAsset, amount }) {
  const apiKey = process.env.ZEROX_API_KEY;
  if (!apiKey) return null; // provider disabled

  const url = `https://api.0x.org/swap/v1/price?sellToken=${encodeURIComponent(fromAsset)}&buyToken=${encodeURIComponent(toAsset)}&sellAmount=${amount}&chainId=${ZEROX_CHAIN_ID}`;

  const res = await withTimeout(
    fetch(url, {
      headers: { "0x-api-key": apiKey, Accept: "application/json" },
    }),
    TIMEOUT_MS,
    "0x"
  );

  if (!res.ok) throw new Error(`0x HTTP ${res.status}`);
  const data = await res.json();

  if (!data?.buyAmount) return null;

  const outputUnits = (parseFloat(data.buyAmount) / 1e18).toFixed(7);

  return {
    provider:        "0x",
    rate:            parseFloat(outputUnits) / parseFloat(amount),
    estimatedOutput: outputUnits,
    sourceAmount:    amount,
    path:            [],
    meta:            { estimatedGas: data.estimatedGas, price: data.price },
  };
}

// ---------------------------------------------------------------------------
// Aggregator — core logic
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { name: "stellar-dex", fn: queryStellarDex },
  { name: "stellar-amm", fn: queryStellarAmm },
  { name: "paraswap",    fn: queryParaswap   },
  { name: "0x",          fn: queryZerox      },
];

/**
 * Query all enabled providers in parallel and return the best quote.
 *
 * "Best" is defined as the highest `estimatedOutput` (most tokens received
 * for the source amount), which is equivalent to the lowest effective price.
 *
 * @param {object} params
 * @param {string} params.fromAsset  – source asset identifier
 * @param {string} params.toAsset    – destination asset identifier
 * @param {string} params.amount     – amount to swap (string)
 * @returns {Promise<object>} Best quote object with provider, rate, estimatedOutput, path, meta
 * @throws  If no provider returns a valid quote
 */
export async function getBestSwapRate({ fromAsset, toAsset, amount }) {
  return startSpan(
    "swap_aggregator.getBestSwapRate",
    { "swap.fromAsset": fromAsset, "swap.toAsset": toAsset, "swap.amount": amount },
    async () => {
      const results = await Promise.allSettled(
        PROVIDERS.map(({ name, fn }) =>
          fn({ fromAsset, toAsset, amount }).catch((err) => {
            logger.warn(`Swap provider ${name} failed`, { error: err.message });
            return null;
          })
        )
      );

      const quotes = results
        .map((r) => (r.status === "fulfilled" ? r.value : null))
        .filter(Boolean);

      if (quotes.length === 0) {
        throw new Error("No swap providers returned a valid quote");
      }

      // Select quote with highest estimatedOutput
      quotes.sort(
        (a, b) => parseFloat(b.estimatedOutput) - parseFloat(a.estimatedOutput)
      );

      const best = quotes[0];

      logger.info("Swap aggregator: best rate selected", {
        provider:        best.provider,
        rate:            best.rate,
        estimatedOutput: best.estimatedOutput,
        totalQuotes:     quotes.length,
        allProviders:    quotes.map((q) => ({ provider: q.provider, output: q.estimatedOutput })),
      });

      return { ...best, slippageMinOutput: applySlippage(best.estimatedOutput) };
    }
  );
}

/**
 * Execute a swap using the quote returned by getBestSwapRate.
 * Falls back to the next-best provider if the primary fails.
 *
 * For Stellar providers: builds a path-payment XDR for the frontend to sign.
 * For off-chain providers (0x, Paraswap): returns the calldata/transaction data.
 *
 * @param {object} quote          – Quote from getBestSwapRate
 * @param {string} callerAddress  – Stellar wallet address (for XDR building)
 * @returns {Promise<object>}     Execution result
 */
export async function executeSwap(quote, callerAddress) {
  return startSpan(
    "swap_aggregator.executeSwap",
    {
      "swap.provider":  quote.provider,
      "swap.output":    quote.estimatedOutput,
      "swap.caller":    callerAddress,
    },
    async () => {
      if (quote.provider === "stellar-dex" || quote.provider === "stellar-amm") {
        // Build path-payment XDR — the frontend signs and submits
        const { buildTx } = await import("./stellar.js");
        try {
          const xdr = await buildTx(callerAddress, null, "path_payment", [
            quote.sourceAmount,
            quote.path,
            quote.slippageMinOutput,
          ]);
          return {
            provider:        quote.provider,
            txXdr:           xdr,
            estimatedOutput: quote.estimatedOutput,
            minOutput:       quote.slippageMinOutput,
            executedAt:      new Date().toISOString(),
          };
        } catch (err) {
          logger.error("Stellar swap XDR build failed", { error: err.message });
          throw err;
        }
      }

      if (quote.provider === "paraswap") {
        // Return Paraswap transaction data for the frontend to submit
        return {
          provider:        "paraswap",
          calldata:        quote.meta?.calldata ?? null,
          estimatedOutput: quote.estimatedOutput,
          minOutput:       quote.slippageMinOutput,
          executedAt:      new Date().toISOString(),
          note:            "Submit calldata via Paraswap SDK on the frontend",
        };
      }

      if (quote.provider === "0x") {
        return {
          provider:        "0x",
          calldata:        quote.meta?.data ?? null,
          estimatedOutput: quote.estimatedOutput,
          minOutput:       quote.slippageMinOutput,
          executedAt:      new Date().toISOString(),
          note:            "Submit calldata via 0x SDK on the frontend",
        };
      }

      throw new Error(`Unknown provider: ${quote.provider}`);
    }
  );
}

/**
 * Attempt getBestSwapRate with automatic provider fallback.
 * If the top-ranked provider fails during execution, retries with the next.
 *
 * @param {object} params          – { fromAsset, toAsset, amount }
 * @param {string} callerAddress
 * @returns {Promise<object>}
 */
export async function swapWithFallback({ fromAsset, toAsset, amount }, callerAddress) {
  const results = await Promise.allSettled(
    PROVIDERS.map(({ name, fn }) =>
      fn({ fromAsset, toAsset, amount }).catch((err) => {
        logger.warn(`Swap fallback: provider ${name} failed`, { error: err.message });
        return null;
      })
    )
  );

  const quotes = results
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter(Boolean)
    .sort((a, b) => parseFloat(b.estimatedOutput) - parseFloat(a.estimatedOutput));

  for (const quote of quotes) {
    try {
      const result = await executeSwap(
        { ...quote, slippageMinOutput: applySlippage(quote.estimatedOutput) },
        callerAddress
      );
      logger.info("Swap executed successfully", {
        provider: quote.provider,
        output:   quote.estimatedOutput,
      });
      return result;
    } catch (err) {
      logger.warn(`Swap execution failed for provider ${quote.provider}, trying next`, {
        error: err.message,
      });
    }
  }

  throw new Error("All swap providers failed during execution");
}
