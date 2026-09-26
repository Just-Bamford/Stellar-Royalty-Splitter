/**
 * Tax compliance reporting service — closes #950.
 *
 * Generates 1099-NEC (US), T4A (Canada), and EU-VAT summary forms for
 * collaborators based on their on-chain XLM distributions, converted to USD
 * via the price oracle.
 *
 * Multi-country rules implemented here:
 *   US   — IRS 1099-NEC ($600 threshold, 24% backup withholding if no tax ID)
 *   CA   — CRA T4A  (~$500 threshold, no automatic withholding in this system)
 *   EU   — Simplified VAT info summary (no automatic withholding)
 *
 * PDF generation is out of scope for this service. The route layer returns a
 * "pdf_ready" structured payload that a downstream PDF renderer (e.g. pdfkit,
 * Puppeteer, or a managed service like DocRaptor) can consume directly.
 * Set TAX_REPORTING_PROVIDER=turbotax|taxjar|avalara in env to indicate which
 * third-party will handle the final filing — this service records the value in
 * the form metadata for audit purposes.
 */

import logger from "../logger.js";
import {
  createTaxForm,
  getLatestTaxForm,
  listTaxForms,
  getTaxYearSummary,
  IRS_1099_THRESHOLD_USD,
  CRA_T4A_THRESHOLD_USD,
} from "../database/tax-forms.js";
import { getContributorTax } from "../database/contributor-tax.js";
import { getXlmUsdPrice, xlmToUsdCents } from "./price-oracle.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** IRS backup withholding rate: 24% (IRC §3406). */
const IRS_BACKUP_WITHHOLDING_RATE = 0.24;

/** XLM stroop conversion: 1 XLM = 10_000_000 stroops. */
const STROOPS_PER_XLM = 10_000_000;

/**
 * Current tax year derived from system clock. Callers may override.
 */
export function getCurrentTaxYear() {
  return new Date().getFullYear();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a stroop amount to XLM.
 *
 * @param {string|number} stroops
 * @returns {number}
 */
function stroopsToXlm(stroops) {
  return Number(stroops) / STROOPS_PER_XLM;
}

/**
 * Determine whether a collaborator is subject to US backup withholding.
 * Backup withholding applies when no valid tax ID (TIN/EIN/SSN) is on file
 * and the payment meets the $600 threshold.
 *
 * @param {object|null} taxInfo - Row from contributor_tax table
 * @param {number}      totalIncomeUsdCents
 * @returns {boolean}
 */
function requiresBackupWithholding(taxInfo, totalIncomeUsdCents) {
  if (totalIncomeUsdCents < IRS_1099_THRESHOLD_USD * 100) return false;
  if (!taxInfo) return true;
  if (!taxInfo.tax_id || taxInfo.tax_status !== "completed") return true;
  return false;
}

/**
 * Build the structured 1099-NEC form payload.
 *
 * Fields align with IRS Form 1099-NEC (tax year 2024+):
 *   Box 1 — Nonemployee compensation
 *   Box 4 — Federal income tax withheld
 *
 * @param {object} params
 * @returns {object}
 */
function build1099Nec({
  walletAddress,
  taxYear,
  totalIncomeUsdCents,
  withheldUsdCents,
  paymentBreakdown,
  taxInfo,
  xlmUsdRate,
  provider,
}) {
  const incomeUsd = totalIncomeUsdCents / 100;
  const withheldUsd = withheldUsdCents / 100;
  const tin = taxInfo?.tax_id ?? null;

  return {
    formType: "1099-NEC",
    taxYear: String(taxYear),
    country: "US",
    // Payer info (the platform / royalty splitter)
    payerName: process.env.PAYER_NAME ?? "Stellar Royalty Splitter",
    payerTin: process.env.PAYER_TIN ?? null,
    payerAddress: process.env.PAYER_ADDRESS ?? null,
    // Recipient info
    recipientAddress: walletAddress,
    recipientTin: tin,
    recipientTinMasked: tin ? `XXX-XX-${tin.slice(-4)}` : null,
    // IRS boxes
    box1NonemployeeCompensation: incomeUsd.toFixed(2),
    box4FederalIncomeTaxWithheld: withheldUsd.toFixed(2),
    // Summary
    totalIncomeUsd: incomeUsd.toFixed(2),
    totalIncomeUsdCents,
    withheldUsd: withheldUsd.toFixed(2),
    withheldUsdCents,
    xlmUsdRateUsed: xlmUsdRate,
    paymentBreakdown,
    meetsFilingThreshold: totalIncomeUsdCents >= IRS_1099_THRESHOLD_USD * 100,
    backupWithholdingApplied: withheldUsdCents > 0,
    filingProvider: provider,
    generatedAt: new Date().toISOString(),
    pdfReady: true,
    pdfNote:
      "Render this payload with a PDF library (e.g. pdfkit) or a managed service " +
      "(TAX_REPORTING_PROVIDER=turbotax|taxjar|avalara) to produce the IRS-ready document.",
  };
}

/**
 * Build the structured T4A (Canada) form payload.
 *
 * CRA T4A Box 048 — Fees for services.
 *
 * @param {object} params
 * @returns {object}
 */
function buildT4A({
  walletAddress,
  taxYear,
  totalIncomeUsdCents,
  paymentBreakdown,
  taxInfo,
  xlmUsdRate,
  provider,
}) {
  const incomeUsd = totalIncomeUsdCents / 100;
  const sin = taxInfo?.tax_id ?? null;

  return {
    formType: "T4A",
    taxYear: String(taxYear),
    country: "CA",
    payerName: process.env.PAYER_NAME ?? "Stellar Royalty Splitter",
    payerBusinessNumber: process.env.PAYER_BN ?? null,
    recipientAddress: walletAddress,
    recipientSin: sin,
    recipientSinMasked: sin ? `XXX-XXX-${sin.slice(-3)}` : null,
    // CRA boxes
    box048FeesForServices: incomeUsd.toFixed(2),
    totalIncomeUsd: incomeUsd.toFixed(2),
    totalIncomeUsdCents,
    withheldUsdCents: 0,
    xlmUsdRateUsed: xlmUsdRate,
    paymentBreakdown,
    meetsFilingThreshold: totalIncomeUsdCents >= CRA_T4A_THRESHOLD_USD * 100,
    filingProvider: provider,
    generatedAt: new Date().toISOString(),
    pdfReady: true,
    pdfNote:
      "Render with a T4A-compatible PDF template. CRA requires original/amended XML slip submission " +
      "through CRA My Business Account or EFILE-certified software.",
  };
}

/**
 * Build the simplified EU VAT info payload.
 * No automatic withholding — the platform reports income for VAT purposes.
 *
 * @param {object} params
 * @returns {object}
 */
function buildEuVat({
  walletAddress,
  taxYear,
  totalIncomeUsdCents,
  paymentBreakdown,
  xlmUsdRate,
  provider,
}) {
  const incomeUsd = totalIncomeUsdCents / 100;

  return {
    formType: "EU-VAT",
    taxYear: String(taxYear),
    country: "EU",
    payerName: process.env.PAYER_NAME ?? "Stellar Royalty Splitter",
    recipientAddress: walletAddress,
    totalIncomeUsd: incomeUsd.toFixed(2),
    totalIncomeUsdCents,
    withheldUsdCents: 0,
    xlmUsdRateUsed: xlmUsdRate,
    paymentBreakdown,
    vatNote:
      "SEPA payments. VAT treatment depends on recipient's member state registration. " +
      "Please consult a local tax advisor for OSS/MOSS obligations.",
    filingProvider: provider,
    generatedAt: new Date().toISOString(),
    pdfReady: true,
    pdfNote: "Render with an EU-compliant invoice / VAT summary template.",
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate (or return cached) 1099-NEC for a collaborator.
 *
 * Resolves to a typed result object — never throws.
 *
 * @param {object}  options
 * @param {string}  options.walletAddress
 * @param {string|number} options.taxYear
 * @param {object[]} options.distributions - Array of distribution records: { amountXlm, timestamp, txHash? }
 * @param {boolean} [options.force]        - Re-generate even if a cached form exists
 * @param {typeof getXlmUsdPrice} [options.priceOracleFn] - Injected for tests
 * @returns {Promise<{ ok: true, form: object, cached: boolean } | { ok: false, reason: string }>}
 */
export async function generate1099Nec({
  walletAddress,
  taxYear = getCurrentTaxYear() - 1,
  distributions = [],
  force = false,
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  if (!walletAddress) return { ok: false, reason: "missing_wallet_address" };
  if (!taxYear) return { ok: false, reason: "missing_tax_year" };

  const year = String(taxYear);
  const provider = process.env.TAX_REPORTING_PROVIDER ?? null;

  // Return cached form if already generated for this year
  if (!force) {
    const cached = getLatestTaxForm(walletAddress, year, "1099-NEC");
    if (cached) {
      logger.info("Returning cached 1099-NEC", { walletAddress, taxYear: year });
      return { ok: true, form: cached.formData, cached: true, id: cached.id };
    }
  }

  // Get XLM/USD rate
  const priceResult = await priceOracleFn();
  if (!priceResult.ok) {
    logger.error("Price oracle unavailable for 1099 generation", { reason: priceResult.reason });
    return { ok: false, reason: `price_oracle_unavailable: ${priceResult.reason}` };
  }
  const { rate } = priceResult;

  // Aggregate payments
  let totalXlm = 0;
  const paymentBreakdown = [];

  for (const dist of distributions) {
    const xlm = typeof dist.amountXlm !== "undefined"
      ? Number(dist.amountXlm)
      : stroopsToXlm(dist.amountStroops ?? 0);

    const usdCents = xlmToUsdCents(xlm, rate);
    totalXlm += xlm;
    paymentBreakdown.push({
      timestamp: dist.timestamp ?? null,
      txHash: dist.txHash ?? null,
      xlmAmount: xlm.toFixed(7),
      usdCents,
      usdAmount: (usdCents / 100).toFixed(2),
    });
  }

  const totalIncomeUsdCents = xlmToUsdCents(totalXlm, rate);

  // Check $600 threshold
  if (totalIncomeUsdCents < IRS_1099_THRESHOLD_USD * 100) {
    logger.info("1099-NEC below $600 threshold — form not required", {
      walletAddress,
      taxYear: year,
      totalIncomeUsdCents,
    });
    return {
      ok: true,
      form: {
        formType: "1099-NEC",
        taxYear: year,
        walletAddress,
        belowThreshold: true,
        totalIncomeUsd: (totalIncomeUsdCents / 100).toFixed(2),
        thresholdUsd: IRS_1099_THRESHOLD_USD.toFixed(2),
        message: `Income of $${(totalIncomeUsdCents / 100).toFixed(2)} is below the $${IRS_1099_THRESHOLD_USD} IRS filing threshold.`,
      },
      cached: false,
    };
  }

  // Lookup contributor tax info for TIN + withholding decision
  let taxInfo = null;
  try {
    taxInfo = getContributorTax(walletAddress);
  } catch (err) {
    logger.warn("Could not fetch contributor tax info", { walletAddress, error: err.message });
  }

  // Calculate backup withholding
  const withhold = requiresBackupWithholding(taxInfo, totalIncomeUsdCents);
  const withheldUsdCents = withhold ? Math.round(totalIncomeUsdCents * IRS_BACKUP_WITHHOLDING_RATE) : 0;

  const formData = build1099Nec({
    walletAddress,
    taxYear: year,
    totalIncomeUsdCents,
    withheldUsdCents,
    paymentBreakdown,
    taxInfo,
    xlmUsdRate: rate,
    provider,
  });

  // Persist
  const record = createTaxForm({
    walletAddress,
    taxYear: year,
    formType: "1099-NEC",
    country: "US",
    totalIncomeUsd: totalIncomeUsdCents,
    withheldUsd: withheldUsdCents,
    formData,
    paymentBreakdown,
    generatedBy: "system",
  });

  logger.info("1099-NEC generated", {
    walletAddress,
    taxYear: year,
    totalIncomeUsd: (totalIncomeUsdCents / 100).toFixed(2),
    withheld: (withheldUsdCents / 100).toFixed(2),
    formId: record.id,
  });

  return { ok: true, form: formData, cached: false, id: record.id };
}

/**
 * Generate (or return cached) T4A for a Canadian collaborator.
 *
 * @param {object}  options
 * @param {string}  options.walletAddress
 * @param {string|number} options.taxYear
 * @param {object[]} options.distributions
 * @param {boolean} [options.force]
 * @param {typeof getXlmUsdPrice} [options.priceOracleFn]
 * @returns {Promise<{ ok: true, form: object, cached: boolean } | { ok: false, reason: string }>}
 */
export async function generateT4A({
  walletAddress,
  taxYear = getCurrentTaxYear() - 1,
  distributions = [],
  force = false,
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  if (!walletAddress) return { ok: false, reason: "missing_wallet_address" };

  const year = String(taxYear);
  const provider = process.env.TAX_REPORTING_PROVIDER ?? null;

  if (!force) {
    const cached = getLatestTaxForm(walletAddress, year, "T4A");
    if (cached) return { ok: true, form: cached.formData, cached: true, id: cached.id };
  }

  const priceResult = await priceOracleFn();
  if (!priceResult.ok) return { ok: false, reason: `price_oracle_unavailable: ${priceResult.reason}` };
  const { rate } = priceResult;

  let totalXlm = 0;
  const paymentBreakdown = [];

  for (const dist of distributions) {
    const xlm = typeof dist.amountXlm !== "undefined"
      ? Number(dist.amountXlm)
      : stroopsToXlm(dist.amountStroops ?? 0);

    const usdCents = xlmToUsdCents(xlm, rate);
    totalXlm += xlm;
    paymentBreakdown.push({
      timestamp: dist.timestamp ?? null,
      txHash: dist.txHash ?? null,
      xlmAmount: xlm.toFixed(7),
      usdCents,
      usdAmount: (usdCents / 100).toFixed(2),
    });
  }

  const totalIncomeUsdCents = xlmToUsdCents(totalXlm, rate);

  let taxInfo = null;
  try {
    taxInfo = getContributorTax(walletAddress);
  } catch {
    /* non-fatal */
  }

  const formData = buildT4A({
    walletAddress,
    taxYear: year,
    totalIncomeUsdCents,
    paymentBreakdown,
    taxInfo,
    xlmUsdRate: rate,
    provider,
  });

  const record = createTaxForm({
    walletAddress,
    taxYear: year,
    formType: "T4A",
    country: "CA",
    totalIncomeUsd: totalIncomeUsdCents,
    withheldUsd: 0,
    formData,
    paymentBreakdown,
    generatedBy: "system",
  });

  return { ok: true, form: formData, cached: false, id: record.id };
}

/**
 * Generate (or return cached) EU-VAT summary for a European collaborator.
 *
 * @param {object}  options
 * @param {string}  options.walletAddress
 * @param {string|number} options.taxYear
 * @param {object[]} options.distributions
 * @param {boolean} [options.force]
 * @param {typeof getXlmUsdPrice} [options.priceOracleFn]
 * @returns {Promise<{ ok: true, form: object, cached: boolean } | { ok: false, reason: string }>}
 */
export async function generateEuVat({
  walletAddress,
  taxYear = getCurrentTaxYear() - 1,
  distributions = [],
  force = false,
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  if (!walletAddress) return { ok: false, reason: "missing_wallet_address" };

  const year = String(taxYear);
  const provider = process.env.TAX_REPORTING_PROVIDER ?? null;

  if (!force) {
    const cached = getLatestTaxForm(walletAddress, year, "EU-VAT");
    if (cached) return { ok: true, form: cached.formData, cached: true, id: cached.id };
  }

  const priceResult = await priceOracleFn();
  if (!priceResult.ok) return { ok: false, reason: `price_oracle_unavailable: ${priceResult.reason}` };
  const { rate } = priceResult;

  let totalXlm = 0;
  const paymentBreakdown = [];

  for (const dist of distributions) {
    const xlm = typeof dist.amountXlm !== "undefined"
      ? Number(dist.amountXlm)
      : stroopsToXlm(dist.amountStroops ?? 0);

    const usdCents = xlmToUsdCents(xlm, rate);
    totalXlm += xlm;
    paymentBreakdown.push({
      timestamp: dist.timestamp ?? null,
      txHash: dist.txHash ?? null,
      xlmAmount: xlm.toFixed(7),
      usdCents,
      usdAmount: (usdCents / 100).toFixed(2),
    });
  }

  const totalIncomeUsdCents = xlmToUsdCents(totalXlm, rate);

  const formData = buildEuVat({
    walletAddress,
    taxYear: year,
    totalIncomeUsdCents,
    paymentBreakdown,
    xlmUsdRate: rate,
    provider,
  });

  const record = createTaxForm({
    walletAddress,
    taxYear: year,
    formType: "EU-VAT",
    country: "EU",
    totalIncomeUsd: totalIncomeUsdCents,
    withheldUsd: 0,
    formData,
    paymentBreakdown,
    generatedBy: "system",
  });

  return { ok: true, form: formData, cached: false, id: record.id };
}

/**
 * Export a full tax-year summary across all collaborators for accountant use.
 *
 * Returns an aggregated CSV-ready payload plus a list of individual records.
 *
 * @param {object} options
 * @param {string|number} options.taxYear
 * @param {string} [options.country] - Filter to a specific country
 * @returns {{ taxYear: string, summary: object[], forms: object[], generatedAt: string }}
 */
export function exportTaxSummary({ taxYear = getCurrentTaxYear() - 1, country = null } = {}) {
  const year = String(taxYear);

  const summary = getTaxYearSummary(year);
  const forms = listTaxForms({ taxYear: year, status: "generated", country }, 500, 0);

  const filteredSummary = country
    ? summary.filter((r) => r.country === country)
    : summary;

  const totalIncome = filteredSummary.reduce((acc, r) => acc + (r.totalIncomeUsd ?? 0), 0);
  const totalWithheld = filteredSummary.reduce((acc, r) => acc + (r.totalWithheldUsd ?? 0), 0);

  return {
    taxYear: year,
    country: country ?? "ALL",
    summary: filteredSummary,
    forms: forms.map((f) => ({
      id: f.id,
      walletAddress: f.walletAddress,
      formType: f.formType,
      country: f.country,
      totalIncomeUsd: (f.totalIncomeUsd / 100).toFixed(2),
      withheldUsd: (f.withheldUsd / 100).toFixed(2),
      status: f.status,
      createdAt: f.createdAt,
    })),
    totals: {
      totalIncomeUsdCents: totalIncome,
      totalIncomeUsd: (totalIncome / 100).toFixed(2),
      totalWithheldUsdCents: totalWithheld,
      totalWithheldUsd: (totalWithheld / 100).toFixed(2),
      collaboratorCount: filteredSummary.length,
      formCount: forms.length,
    },
    generatedAt: new Date().toISOString(),
    pdfReady: true,
    provider: process.env.TAX_REPORTING_PROVIDER ?? null,
  };
}
