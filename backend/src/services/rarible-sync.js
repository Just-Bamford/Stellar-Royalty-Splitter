/**
 * Rarible marketplace resale sync — closes #954.
 *
 * Mirrors `services/opensea-sync.js` for the Rarible marketplace: parses a
 * Rarible Order-activity payload, calculates the secondary royalty at a
 * configurable rate (default 5%, in basis points to match
 * `getRoyaltyRateFromContract`'s on-chain scale and
 * `routes/secondary-royalty.js`'s `floor(salePrice * rate / 10000)`
 * calculation), and records it through the same integration points the manual
 * and OpenSea flows use.
 *
 * ── Multi-chain (Ethereum + Polygon) ───────────────────────────────────
 * Rarible reports activity on several chains and qualifies its identifiers
 * with the chain name (`ETHEREUM:0xabc…`, `POLYGON:0xdef…`). This module
 * accepts the chains in SUPPORTED_RARIBLE_CHAINS and rejects anything else
 * rather than guessing, so an unsupported chain surfaces as a 400 to the
 * webhook caller instead of being silently mis-recorded as Ethereum. The
 * resolved chain is kept on the recorded row (see
 * `raribleSaleTokenMarker`) and on the audit/broadcast payloads.
 *
 * ── Scoping note: no server-side transaction signing ────────────────────
 * Identical to the OpenSea integration: this backend never signs or submits
 * a transaction. The sale is always persisted so the royalty is durably and
 * idempotently recorded, and the unsigned `record_secondary_royalty` XDR is
 * built only when an operator wallet is configured via
 * `RARIBLE_RELAYER_WALLET`. Either way the sale is recorded; only "who signs
 * the built XDR" is deployment-specific.
 */

import { recordSecondarySale, addAuditLog } from "../database/index.js";
import {
  getMarketplaceEvent,
  recordMarketplaceEvent,
  getMarketplaceSettings,
} from "../database/marketplace-events.js";
import { buildTx, i128ToScVal } from "../stellar.js";
import { broadcastToContract } from "../websocket.js";
import {
  DEFAULT_ROYALTY_RATE_BPS,
  calculateRoyalty,
  retryWithBackoff,
} from "./opensea-sync.js";
import logger from "../logger.js";

export { DEFAULT_ROYALTY_RATE_BPS, calculateRoyalty };

/** Provider key used for Rarible rows in `marketplace_events`. */
export const RARIBLE_PROVIDER = "rarible";

/**
 * Chains this integration records. Rarible's own activity feed covers more,
 * but the issue scopes this to Ethereum and Polygon; anything else is
 * rejected so it cannot be silently attributed to the wrong chain.
 */
export const SUPPORTED_RARIBLE_CHAINS = ["ethereum", "polygon"];

const MAX_RETRIES = Number(process.env.RARIBLE_SYNC_MAX_RETRIES) || 3;
const BASE_BACKOFF_MS = Number(process.env.RARIBLE_SYNC_BACKOFF_MS) || 1000;

/**
 * `secondary_sales.saleToken` holds a Stellar asset contract address for
 * sales paid in a Stellar-native asset. A Rarible resale is paid off-chain,
 * so — exactly as `OPENSEA_EXTERNAL` does for OpenSea — this marker records
 * that the payment is external and on which chain, rather than fabricating a
 * `C…` address that would misrepresent the row as a genuine SAC.
 *
 * @param {string} chain
 * @returns {string}
 */
export function raribleSaleTokenMarker(chain) {
  return `RARIBLE_EXTERNAL:${chain}`;
}

function asString(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === "" ? null : str;
}

/**
 * Split a chain-qualified Rarible identifier such as `ETHEREUM:0xabc…` into
 * its chain and bare address. Values without a chain qualifier are returned
 * with `chain: null`, and a qualifier is only recognised when it looks like a
 * chain name, so a bare `0x…` address is never split by accident.
 *
 * @param {unknown} value
 * @returns {{ chain: string | null, address: string | null }}
 */
export function splitChainQualified(value) {
  const raw = asString(value);
  if (!raw) return { chain: null, address: null };

  const separator = raw.indexOf(":");
  if (separator === -1) return { chain: null, address: raw };

  const prefix = raw.slice(0, separator);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(prefix)) {
    return { chain: null, address: raw };
  }
  return { chain: prefix.toLowerCase(), address: raw.slice(separator + 1) };
}

/**
 * Parse the fields this module needs out of a Rarible Order-activity payload.
 *
 * Rarible delivers the activity object either bare or wrapped in a `data`
 * envelope (`{ event: "ORDER_SALE", data: { … } }`), so both are accepted.
 * Relevant fields:
 * {
 *   id: "ETHEREUM:0xabc…:1337",          // activity id (dedup key)
 *   type: "SALE",
 *   blockchain: "ETHEREUM" | "POLYGON",
 *   contract: "ETHEREUM:0xabc…",          // chain-qualified
 *   tokenId: "1337",
 *   seller: "ETHEREUM:0xSeller…",
 *   buyer: "ETHEREUM:0xBuyer…",
 *   price: "1000000000000000000",         // base units, as a string
 * }
 *
 * As with OpenSea, the royalty contract this sale belongs to is a Soroban
 * contract id that Rarible knows nothing about, so the caller supplies it
 * (see routes/marketplaces/rarible.js).
 *
 * @param {object} payload raw parsed Rarible webhook body
 * @returns {{ eventId: string, nftId: string, salePrice: string, seller: string, buyer: string, chain: string } | null}
 *          null when a required field is missing or the chain is unsupported
 */
export function parseRariblePayload(payload) {
  const envelope = payload ?? {};
  const body = envelope.data ?? envelope.payload ?? envelope;

  const explicitChain = asString(
    body.blockchain ?? body.chain ?? body.blockChain ?? envelope.blockchain
  );

  const contractRef = splitChainQualified(
    body.contract ?? body.contractAddress ?? body.nft?.contract ?? body.item?.contract
  );
  const sellerRef = splitChainQualified(
    body.seller ?? body.maker ?? body.from ?? body.fromAccount
  );
  const buyerRef = splitChainQualified(
    body.buyer ?? body.taker ?? body.to ?? body.toAccount
  );

  const chain = (
    explicitChain ?? contractRef.chain ?? sellerRef.chain ?? buyerRef.chain ?? ""
  ).toLowerCase();

  const tokenId = asString(
    body.tokenId ?? body.token_id ?? body.nft?.tokenId ?? body.item?.token_id
  );

  const nftId =
    asString(body.nftId ?? body.nft_id ?? body.nft?.id ?? body.item?.nft_id) ??
    (contractRef.address && tokenId
      ? `${chain}/${contractRef.address}/${tokenId}`
      : null);

  const salePrice = asString(
    body.price ?? body.sale_price ?? body.salePrice ?? body.priceWei
  );

  const transactionHash = asString(body.transactionHash ?? body.txHash);
  const eventId =
    asString(body.id ?? body.event_id ?? body.activityId ?? envelope.event_id) ??
    (transactionHash && tokenId ? `${transactionHash}:${tokenId}` : null);

  const seller = sellerRef.address;
  const buyer = buyerRef.address;

  if (!eventId || !nftId || !salePrice || !seller || !buyer) {
    return null;
  }
  if (!SUPPORTED_RARIBLE_CHAINS.includes(chain)) {
    return null;
  }

  return {
    eventId,
    nftId,
    salePrice,
    seller,
    buyer,
    chain,
  };
}

/**
 * Process one Rarible sale end-to-end: dedup, calculate royalty, persist,
 * attempt the contract-call XDR build (with retry/failover), and broadcast.
 *
 * Idempotent: when `eventId` has already been recorded for the `rarible`
 * provider the existing record is returned unchanged and nothing is
 * re-processed, so a redelivered webhook (or the marketplace's own retry
 * after a 5xx) cannot double-record a royalty.
 *
 * @param {object} params
 * @param {string} params.contractId  royalty contract this event applies to
 * @param {{eventId, nftId, salePrice, seller, buyer, chain}} params.parsed
 * @param {number} [params.rateBps]
 * @param {object} [params.rawPayload] stored for the audit trail
 * @returns {Promise<{ status: "duplicate"|"recorded"|"auto_recording_disabled", royaltyAmount?: string, xdr?: string|null, chain?: string }>}
 */
export async function processRaribleSale({
  contractId,
  parsed,
  rateBps = DEFAULT_ROYALTY_RATE_BPS,
  rawPayload = null,
}) {
  const { eventId, nftId, salePrice, seller, buyer, chain } = parsed;

  const existing = getMarketplaceEvent(RARIBLE_PROVIDER, eventId);
  if (existing) {
    logger.info("Rarible event already processed, skipping duplicate", { eventId, contractId });
    return { status: "duplicate", royaltyAmount: existing.royaltyAmount };
  }

  const settings = getMarketplaceSettings(contractId);
  if (!settings.autoRecordingEnabled) {
    logger.info("Rarible auto-recording disabled for contract, skipping", { contractId, eventId });
    return { status: "auto_recording_disabled" };
  }

  const royaltyAmount = calculateRoyalty(salePrice, rateBps);

  // salePrice stays a BigInt end-to-end: Rarible prices are wei-denominated
  // strings that routinely exceed Number.MAX_SAFE_INTEGER, so converting
  // through Number() here would silently lose precision.
  try {
    recordSecondarySale(
      contractId,
      nftId,
      seller,
      buyer,
      BigInt(salePrice),
      raribleSaleTokenMarker(chain),
      royaltyAmount,
      rateBps
    );
  } catch (err) {
    if (err.code !== "SQLITE_CONSTRAINT_UNIQUE") throw err;
    // Already recorded (e.g. also submitted manually) — fall through and
    // still record the marketplace event for dedup/audit purposes.
  }

  let xdr = null;
  const relayerWallet = process.env.RARIBLE_RELAYER_WALLET;
  let contractCallStatus = "skipped_no_relayer";

  if (relayerWallet) {
    try {
      xdr = await retryWithBackoff(
        () =>
          buildTx(relayerWallet, contractId, "record_secondary_royalty", [
            i128ToScVal(BigInt(salePrice)),
          ]),
        {
          maxRetries: MAX_RETRIES,
          baseBackoffMs: BASE_BACKOFF_MS,
          onRetry: (attempt, error) => {
            logger.warn("Rarible sync: contract-call build failed, retrying", {
              eventId,
              contractId,
              chain,
              attempt,
              error: error.message,
            });
          },
        }
      );
      contractCallStatus = "recorded";
    } catch (error) {
      logger.error("Rarible sync: contract-call build failed after all retries", {
        eventId,
        contractId,
        chain,
        error: error.message,
      });
      contractCallStatus = "contract_call_failed";
    }
  } else {
    logger.warn(
      "RARIBLE_RELAYER_WALLET not configured; recording sale without building contract-call XDR",
      { eventId, contractId, chain }
    );
  }

  recordMarketplaceEvent({
    provider: RARIBLE_PROVIDER,
    eventId,
    contractId,
    nftId,
    salePrice,
    royaltyAmount: royaltyAmount.toString(),
    status: contractCallStatus,
    rawPayload,
  });

  addAuditLog(contractId, "secondary_sale_recorded", "rarible_webhook", {
    eventId,
    nftId,
    salePrice: salePrice.toString(),
    royaltyAmount: royaltyAmount.toString(),
    royaltyRateUsed: rateBps,
    source: "rarible",
    chain,
  });

  broadcastToContract(contractId, {
    type: "secondary_sale_recorded",
    contractId,
    source: "rarible",
    chain,
    nftId,
    salePrice: salePrice.toString(),
    royaltyAmount: royaltyAmount.toString(),
    royaltyStatus: "pending",
    timestamp: new Date().toISOString(),
  });

  return { status: "recorded", royaltyAmount: royaltyAmount.toString(), xdr, chain };
}
