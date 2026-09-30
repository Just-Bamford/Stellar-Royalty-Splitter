/**
 * Carbon footprint tracking and offset purchasing (#1064).
 *
 * Methodology (documented estimates, overridable via env):
 *  - Stellar uses the Federated Byzantine Agreement (SCP) consensus family,
 *    with no mining. Per-transaction energy is estimated at
 *    CARBON_WH_PER_TX watt-hours (default 0.22 Wh, SDF-published figure).
 *  - Grid intensity defaults to CARBON_GCO2_PER_KWH (default 475 gCO2/kWh,
 *    global average). Footprint per operation = Wh * gCO2/kWh / 1000.
 *  - Offsets are priced at CARBON_OFFSET_USD_PER_TONNE (default $15/tCO2e).
 *
 * Offset fulfillment is intentionally provider-agnostic: purchases are
 * recorded against a named provider (default `demo`, which settles
 * immediately). Real provider settlement is out of scope (#1064 explicitly
 * excludes partner management).
 */

import {
  recordEmission,
  getUserEmissions,
  getUserEmissionsByDay,
  getProjectEmissions,
  getProjectEmissionsByDay,
  recordOffset,
  getUserOffsets,
  listUserOffsets,
  countUserOffsets,
  getProjectOffsets,
  getCarbonSettings,
  upsertCarbonSettings,
  listAutoOffsetWallets,
} from "../database/carbon.js";
import logger from "../logger.js";

function parsePositiveFloat(value, fallback) {
  const parsed = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export const CARBON_WH_PER_TX = parsePositiveFloat(process.env.CARBON_WH_PER_TX, 0.22);
export const CARBON_GCO2_PER_KWH = parsePositiveFloat(process.env.CARBON_GCO2_PER_KWH, 475);
export const CARBON_OFFSET_USD_PER_TONNE = parsePositiveFloat(
  process.env.CARBON_OFFSET_USD_PER_TONNE,
  15
);
export const CARBON_OFFSET_PROVIDER = process.env.CARBON_OFFSET_PROVIDER ?? "demo";

export const GRAMS_PER_TONNE = 1_000_000;
export const STROOPS_PER_XLM = 10_000_000;

export const OFFSET_PROJECTS = Object.freeze([
  {
    id: "amazon-reforestation",
    name: "Amazon Reforestation Collective",
    type: "forest",
    location: "Brazil",
    description: "Native-species reforestation across degraded Amazon frontier land.",
  },
  {
    id: "congo-basin-conservation",
    name: "Congo Basin Conservation",
    type: "forest",
    location: "DR Congo",
    description: "Protecting primary rainforest through community-led stewardship.",
  },
  {
    id: "pacific-blue-carbon",
    name: "Pacific Blue Carbon",
    type: "ocean",
    location: "Fiji",
    description: "Mangrove restoration storing blue carbon and shielding coastlines.",
  },
  {
    id: "kelp-restoration",
    name: "Kelp Forest Restoration",
    type: "ocean",
    location: "California, USA",
    description: "Rebuilding giant kelp forests that sequester carbon offshore.",
  },
]);

export const OFFSET_PROJECT_TYPES = Object.freeze(["forest", "ocean", "mixed"]);

export function isSupportedProject(project) {
  if (OFFSET_PROJECT_TYPES.includes(project)) return true;
  return OFFSET_PROJECTS.some((p) => p.id === project);
}

export function gramsToTonnes(grams) {
  return grams / GRAMS_PER_TONNE;
}

export function tonnesToUsdCents(tonnes, usdPerTonne = CARBON_OFFSET_USD_PER_TONNE) {
  return Math.round(tonnes * usdPerTonne * 100);
}

/**
 * Estimate the CO2 footprint of a transaction in grams.
 * operationCount scales linearly (batch/multi-op transactions).
 */
export function estimateTxFootprintGrams({ operationCount = 1 } = {}) {
  const ops = Number.isFinite(Number(operationCount)) && Number(operationCount) > 0
    ? Math.floor(Number(operationCount))
    : 1;
  return ((CARBON_WH_PER_TX * CARBON_GCO2_PER_KWH) / 1000) * ops;
}

/**
 * Record the footprint of a confirmed transaction, attributed to the
 * initiating wallet. Idempotent per (contractId, txHash, walletAddress).
 */
export function recordTransactionFootprint({
  contractId,
  walletAddress,
  txHash = null,
  transactionId = null,
  operationCount = 1,
}) {
  if (!contractId || !walletAddress) {
    throw new Error("contractId and walletAddress are required");
  }
  const gramsCo2 = estimateTxFootprintGrams({ operationCount });
  return {
    emissionId: recordEmission({
      walletAddress,
      contractId,
      txHash,
      transactionId,
      operationCount,
      gramsCo2,
    }),
    gramsCo2,
  };
}

export function getUserFootprint(walletAddress, { start = null, end = null } = {}) {
  const { txCount, totalGrams } = getUserEmissions(walletAddress, { start, end });
  const byDay = getUserEmissionsByDay(walletAddress, { start, end });
  const { totalTonnes, purchaseCount, totalUsdCents } = getUserOffsets(walletAddress);
  const offsetGrams = totalTonnes * GRAMS_PER_TONNE;
  return {
    walletAddress,
    txCount,
    totalGrams,
    totalKg: totalGrams / 1000,
    offsetGrams,
    offsetTonnes: totalTonnes,
    offsetPurchases: purchaseCount,
    offsetUsdCents: totalUsdCents,
    netGrams: totalGrams - offsetGrams,
    // % of emissions covered by completed offsets (0 when nothing emitted).
    offsetCoveragePercent: totalGrams > 0 ? Math.min(100, (offsetGrams / totalGrams) * 100) : 100,
    byDay: byDay.map((row) => ({ date: row.date, txCount: row.txCount, grams: row.grams })),
  };
}

export function getProjectFootprint(contractId, { start = null, end = null } = {}) {
  const { txCount, totalGrams, contributorCount } = getProjectEmissions(contractId, { start, end });
  const byDay = getProjectEmissionsByDay(contractId, { start, end });
  const offsets = getProjectOffsets(contractId);
  return {
    contractId,
    txCount,
    totalGrams,
    totalKg: totalGrams / 1000,
    contributorCount,
    offsetTonnes: offsets.totalTonnes,
    offsetPurchases: offsets.purchaseCount,
    offsetContributors: offsets.contributorCount,
    byDay: byDay.map((row) => ({ date: row.date, txCount: row.txCount, grams: row.grams })),
  };
}

/**
 * Purchase carbon offsets for a wallet. Accepts either tonnes or
 * amountUsdCents (tonnes wins when both are given). The `demo` provider
 * settles immediately; any other provider records a pending purchase for
 * asynchronous settlement by the (out-of-scope) partner integration.
 */
export function purchaseOffsets({
  walletAddress,
  contractId = null,
  tonnes = null,
  amountUsdCents = null,
  project = "mixed",
  provider = CARBON_OFFSET_PROVIDER,
  autoPurchase = false,
  txHash = null,
}) {
  if (!walletAddress) throw new Error("walletAddress is required");
  if (!isSupportedProject(project)) throw new Error(`Unsupported offset project: ${project}`);

  let resolvedTonnes = tonnes;
  let resolvedCents = amountUsdCents ?? 0;
  if (resolvedTonnes == null) {
    if (resolvedCents == null || resolvedCents <= 0) {
      throw new Error("Provide tonnes or a positive amountUsdCents");
    }
    resolvedTonnes = resolvedCents / 100 / CARBON_OFFSET_USD_PER_TONNE;
  } else {
    if (!(resolvedTonnes > 0)) throw new Error("tonnes must be positive");
    resolvedCents = amountUsdCents ?? tonnesToUsdCents(resolvedTonnes);
  }

  const status = provider === "demo" ? "completed" : "pending";
  const offsetId = recordOffset({
    walletAddress,
    contractId,
    tonnes: resolvedTonnes,
    amountUsdCents: Math.round(resolvedCents),
    provider,
    project,
    status,
    autoPurchase,
    txHash,
  });

  logger.info("Carbon offsets purchased", {
    walletAddress,
    tonnes: resolvedTonnes,
    provider,
    project,
    status,
    autoPurchase,
  });

  return {
    offsetId,
    walletAddress,
    tonnes: resolvedTonnes,
    amountUsdCents: Math.round(resolvedCents),
    provider,
    project,
    status,
  };
}

/**
 * Auto-purchase offsets for distribution recipients that opted in
 * (`offsetPercentage` of each payout's USD value). Price lookup is
 * fail-open: recipients are skipped when the oracle is unavailable.
 *
 * @param {object} params
 * @param {string} params.contractId
 * @param {Array<{address:string, amountStroops:string|number}>} params.payouts
 * @param {string|null} params.txHash
 * @returns {Promise<{attempted:number, purchased:number, skipped:number, tonnes:number}>}
 */
export async function runAutoOffset({ contractId, payouts = [], txHash = null }) {
  const optedIn = new Map(listAutoOffsetWallets().map((s) => [s.walletAddress, s.offsetPercentage]));
  const eligible = payouts.filter((p) => optedIn.has(p.address));
  if (eligible.length === 0) return { attempted: 0, purchased: 0, skipped: 0, tonnes: 0 };

  let rate = null;
  try {
    const { getXlmUsdPrice } = await import("./price-oracle.js");
    const quote = await getXlmUsdPrice();
    if (quote?.ok) rate = quote.rate;
  } catch (err) {
    logger.warn("Auto-offset skipped: price oracle unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (rate == null) {
    return { attempted: eligible.length, purchased: 0, skipped: eligible.length, tonnes: 0 };
  }

  const { xlmToUsdCents } = await import("./price-oracle.js");
  let purchased = 0;
  let skipped = 0;
  let tonnes = 0;

  for (const payout of eligible) {
    try {
      const amountXlm = Number(payout.amountStroops) / STROOPS_PER_XLM;
      if (!Number.isFinite(amountXlm) || amountXlm <= 0) {
        skipped++;
        continue;
      }
      const usdCents = xlmToUsdCents(amountXlm, rate);
      const spendCents = Math.floor(usdCents * (optedIn.get(payout.address) / 100));
      if (spendCents < 1) {
        skipped++;
        continue;
      }
      const result = purchaseOffsets({
        walletAddress: payout.address,
        contractId,
        amountUsdCents: spendCents,
        project: "mixed",
        autoPurchase: true,
        txHash,
      });
      tonnes += result.tonnes;
      purchased++;
    } catch (err) {
      logger.warn("Auto-offset purchase failed for recipient", {
        address: payout.address,
        error: err instanceof Error ? err.message : String(err),
      });
      skipped++;
    }
  }

  return { attempted: eligible.length, purchased, skipped, tonnes };
}

export function getOffsetHistory(walletAddress, { limit = 50, offset = 0 } = {}) {
  return {
    data: listUserOffsets(walletAddress, { limit, offset }),
    total: countUserOffsets(walletAddress),
  };
}

export function getAutoOffsetSettings(walletAddress) {
  return getCarbonSettings(walletAddress);
}

export function saveAutoOffsetSettings(walletAddress, { autoOffsetEnabled, offsetPercentage }) {
  if (typeof autoOffsetEnabled !== "boolean") {
    throw new Error("autoOffsetEnabled must be a boolean");
  }
  if (!Number.isFinite(offsetPercentage) || offsetPercentage < 0 || offsetPercentage > 100) {
    throw new Error("offsetPercentage must be between 0 and 100");
  }
  return upsertCarbonSettings(walletAddress, { autoOffsetEnabled, offsetPercentage });
}

/**
 * Build a shareable impact summary for social media. Returns text +
 * per-network intent URLs (opened client-side; no server-side posting).
 */
export function buildSharePayload(walletAddress) {
  const footprint = getUserFootprint(walletAddress);
  const kg = footprint.totalKg;
  const coverage = Math.round(footprint.offsetCoveragePercent);
  const text =
    `My Stellar royalty footprint: ${kg.toFixed(3)} kg CO2 across ${footprint.txCount} ` +
    `transactions — ${coverage}% offset. Track yours with Stellar Royalty Splitter.`;
  const url = "https://github.com/Just-Bamford/Stellar-Royalty-Splitter";
  const encodedText = encodeURIComponent(text);
  const encodedUrl = encodeURIComponent(url);
  return {
    text,
    stats: {
      totalKg: kg,
      txCount: footprint.txCount,
      offsetCoveragePercent: coverage,
      netGrams: footprint.netGrams,
    },
    shareUrls: {
      x: `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}&quote=${encodedText}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
    },
  };
}

export const _carbonConfig = {
  CARBON_WH_PER_TX,
  CARBON_GCO2_PER_KWH,
  CARBON_OFFSET_USD_PER_TONNE,
  CARBON_OFFSET_PROVIDER,
  GRAMS_PER_TONNE,
};
