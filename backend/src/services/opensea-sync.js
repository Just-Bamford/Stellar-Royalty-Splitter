/**
 * OpenSea marketplace resale sync — closes #928.
 *
 * Parses an OpenSea webhook payload, calculates the secondary royalty at a
 * configurable rate (default 5%, expressed in basis points to match
 * `getRoyaltyRateFromContract`'s on-chain scale — see
 * `src/routes/secondary-royalty.js`'s `Math.floor((salePrice * rate) / 10000)`
 * calculation, which this mirrors exactly), and calls the existing
 * `record_secondary_sale` contract integration point.
 *
 * ── Scoping note: no server-side transaction signing ────────────────────
 * This codebase's backend never signs or submits a real transaction itself
 * — every route that touches the contract (`routes/secondary-royalty.js`,
 * `routes/distribute.js`, the payment-schedule job) only ever builds
 * *unsigned* XDR via `buildTx()` for a wallet to sign client-side; even the
 * automated payment-schedule job only simulates and records an audit trail
 * ("the actual XDR signing is the responsibility of the contract operator").
 * There is no webhook-initiated signer in an OpenSea resale — nobody's
 * wallet is present to authorize the call. To stay consistent with that
 * architecture rather than inventing a new signing path, this module:
 *   1. Always persists the sale (secondary_sales + marketplace_events) so
 *      the royalty is durably recorded and idempotent, and
 *   2. Builds the unsigned `record_secondary_royalty` XDR via the same
 *      `buildTx()` used by the manual flow IF an operator/relayer wallet is
 *      configured via `OPENSEA_RELAYER_WALLET` (the wallet that will
 *      eventually sign it, e.g. an ops multisig cosigner flow) — otherwise
 *      it records the sale without XDR and logs that XDR building was
 *      skipped. Either way the sale is recorded and broadcast as pending;
 *      only the "who signs the built XDR" question is deployment-specific
 *      and left to `OPENSEA_RELAYER_WALLET` configuration.
 */

import { recordSecondarySale, addAuditLog } from "../database/index.js";
import {
  getMarketplaceEvent,
  recordMarketplaceEvent,
  getMarketplaceSettings,
} from "../database/marketplace-events.js";
import { buildTx, i128ToScVal } from "../stellar.js";
import { broadcastToContract } from "../websocket.js";
import logger from "../logger.js";

export const DEFAULT_ROYALTY_RATE_BPS = 500; // 5%, expressed in basis points (out of 10000)

// `secondary_sales.saleToken` is a Stellar contract address (a SAC) in the
// manual-entry flow (routes/secondary-royalty.js), because that sale was
// paid in a Stellar-native asset. An OpenSea resale is paid off-chain (ETH/
// WETH on Ethereum/whatever chain the collection lives on) — there is no
// real Stellar SAC to put here. Using a fabricated-looking `C...` address
// would misrepresent the row as a genuine Stellar asset contract, so this
// sentinel makes the "external, non-Stellar payment" origin explicit instead.
export const EXTERNAL_SALE_TOKEN_MARKER = "OPENSEA_EXTERNAL";

const MAX_RETRIES = Number(process.env.OPENSEA_SYNC_MAX_RETRIES) || 3;
const BASE_BACKOFF_MS = Number(process.env.OPENSEA_SYNC_BACKOFF_MS) || 1000;

/**
 * Parse the fields this module needs out of a raw OpenSea webhook payload.
 *
 * OpenSea's "item_sold" event shape (relevant fields only):
 * {
 *   event_type: "item_sold",
 *   payload: {
 *     event_id: "...",
 *     item: { nft_id: "chain/contract/token_id", ... },
 *     payment_token: { ... },
 *     sale_price: "1000000000000000000",   // string, base units
 *     taker: "0x...",   // buyer
 *     maker: "0x...",   // seller (some payloads use from_account/to_account instead)
 *     from_account: { address: "0x..." },
 *     to_account: { address: "0x..." },
 *     collection: { slug: "..." },
 *   }
 * }
 *
 * This backend's royalty contract is identified separately (the Soroban
 * `contractId`) from the NFT's chain/contract in the OpenSea payload, so the
 * caller must supply which royalty `contractId` this event applies to (the
 * webhook route resolves that from the collection slug -> contractId
 * mapping it is configured with, see routes/marketplaces/opensea.js).
 *
 * @param {object} payload  raw parsed OpenSea webhook body
 * @returns {{ eventId: string, nftId: string, salePrice: string, seller: string, buyer: string } | null}
 *          null if required fields are missing
 */
export function parseOpenSeaPayload(payload) {
  const body = payload?.payload ?? payload ?? {};

  const eventId = payload?.event_id ?? body?.event_id ?? null;
  const nftId = body?.item?.nft_id ?? body?.item?.token_id ?? null;
  const salePrice = body?.sale_price ?? null;
  const seller = body?.maker ?? body?.from_account?.address ?? body?.seller ?? null;
  const buyer = body?.taker ?? body?.to_account?.address ?? body?.buyer ?? null;

  if (!eventId || !nftId || !salePrice || !seller || !buyer) {
    return null;
  }

  return { eventId: String(eventId), nftId: String(nftId), salePrice: String(salePrice), seller: String(seller), buyer: String(buyer) };
}

/**
 * Calculate the royalty amount for a sale at the given rate.
 * Mirrors `routes/secondary-royalty.js`: floor(salePrice * rateBps / 10000).
 *
 * @param {string|number|bigint} salePrice
 * @param {number} [rateBps]  basis points, default DEFAULT_ROYALTY_RATE_BPS
 * @returns {bigint}
 */
export function calculateRoyalty(salePrice, rateBps = DEFAULT_ROYALTY_RATE_BPS) {
  const price = BigInt(salePrice);
  const rate = BigInt(rateBps);
  return (price * rate) / 10000n;
}

/**
 * Retry an async operation with exponential backoff.
 * Minimal, scoped to this module — see the #928 implementation notes for
 * why the existing DB-persisted webhook retry job
 * (`jobs/retry-failed-webhooks.js`) doesn't fit here: that job retries
 * *outbound webhook deliveries* on a background interval across process
 * restarts, whereas this retries a single in-flight contract-call build
 * within the same request/handler lifetime.
 *
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.maxRetries]
 * @param {number} [options.baseBackoffMs]
 * @param {(attempt: number, error: Error) => void} [options.onRetry]
 * @returns {Promise<T>}
 * @template T
 */
export async function retryWithBackoff(fn, { maxRetries = MAX_RETRIES, baseBackoffMs = BASE_BACKOFF_MS, onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const delay = baseBackoffMs * 2 ** attempt;
      onRetry?.(attempt + 1, error);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Process one OpenSea "item sold" event end-to-end: parse (by the caller,
 * via parseOpenSeaPayload), dedup, calculate royalty, persist, attempt the
 * contract-call XDR build (with retry), and broadcast.
 *
 * Idempotent: if `eventId` has already been recorded for this provider, the
 * existing record is returned unchanged and nothing is re-processed.
 *
 * @param {object} params
 * @param {string} params.contractId    royalty contract this event applies to
 * @param {{eventId, nftId, salePrice, seller, buyer}} params.parsed
 * @param {number} [params.rateBps]
 * @param {object} [params.rawPayload]  stored for audit trail
 * @returns {Promise<{ status: "duplicate"|"recorded", royaltyAmount?: string, xdr?: string|null }>}
 */
export async function processOpenSeaSale({ contractId, parsed, rateBps = DEFAULT_ROYALTY_RATE_BPS, rawPayload = null }) {
  const { eventId, nftId, salePrice, seller, buyer } = parsed;

  const existing = getMarketplaceEvent("opensea", eventId);
  if (existing) {
    logger.info("OpenSea event already processed, skipping duplicate", { eventId, contractId });
    return { status: "duplicate", royaltyAmount: existing.royaltyAmount };
  }

  const settings = getMarketplaceSettings(contractId);
  if (!settings.autoRecordingEnabled) {
    logger.info("OpenSea auto-recording disabled for contract, skipping", { contractId, eventId });
    return { status: "auto_recording_disabled" };
  }

  const royaltyAmount = calculateRoyalty(salePrice, rateBps);

  // Persist the sale itself (same table/shape the manual
  // POST /api/v1/secondary-royalty flow writes to). salePrice is kept as a
  // BigInt end-to-end — OpenSea sale prices are wei-denominated strings
  // (up to 18 decimals) that routinely exceed Number.MAX_SAFE_INTEGER, so
  // converting through Number() here would silently lose precision.
  try {
    recordSecondarySale(contractId, nftId, seller, buyer, BigInt(salePrice), EXTERNAL_SALE_TOKEN_MARKER, royaltyAmount, rateBps);
  } catch (err) {
    if (err.code !== "SQLITE_CONSTRAINT_UNIQUE") throw err;
    // Sale already recorded (e.g. also submitted manually) — fall through
    // and still record the marketplace event for dedup/audit purposes.
  }

  let xdr = null;
  const relayerWallet = process.env.OPENSEA_RELAYER_WALLET;
  let contractCallStatus = "skipped_no_relayer";

  if (relayerWallet) {
    try {
      xdr = await retryWithBackoff(
        () => buildTx(relayerWallet, contractId, "record_secondary_royalty", [i128ToScVal(BigInt(salePrice))]),
        {
          onRetry: (attempt, error) => {
            logger.warn("OpenSea sync: contract-call build failed, retrying", {
              eventId,
              contractId,
              attempt,
              error: error.message,
            });
          },
        }
      );
      contractCallStatus = "recorded";
    } catch (error) {
      logger.error("OpenSea sync: contract-call build failed after all retries", {
        eventId,
        contractId,
        error: error.message,
      });
      contractCallStatus = "contract_call_failed";
    }
  } else {
    logger.warn("OPENSEA_RELAYER_WALLET not configured; recording sale without building contract-call XDR", {
      eventId,
      contractId,
    });
  }

  recordMarketplaceEvent({
    provider: "opensea",
    eventId,
    contractId,
    nftId,
    salePrice,
    royaltyAmount: royaltyAmount.toString(),
    status: contractCallStatus,
    rawPayload,
  });

  addAuditLog(contractId, "secondary_sale_recorded", "opensea_webhook", {
    eventId,
    nftId,
    salePrice: salePrice.toString(),
    royaltyAmount: royaltyAmount.toString(),
    royaltyRateUsed: rateBps,
    source: "opensea",
  });

  broadcastToContract(contractId, {
    type: "secondary_sale_recorded",
    contractId,
    source: "opensea",
    nftId,
    salePrice: salePrice.toString(),
    royaltyAmount: royaltyAmount.toString(),
    royaltyStatus: "pending",
    timestamp: new Date().toISOString(),
  });

  return { status: "recorded", royaltyAmount: royaltyAmount.toString(), xdr };
}
