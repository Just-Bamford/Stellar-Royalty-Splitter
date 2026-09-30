/**
 * Compliance and regulatory reporting service — closes #997.
 *
 * Extends tax-reporting.js with additional export formats for accountants,
 * tax software, and regulatory filings (SEC, FINRA).
 *
 * Supported formats:
 *   - CSV (spreadsheet compatible)
 *   - TurboTax import format
 *   - Form 8949 (IRS capital gains/losses)
 *   - Generic ledger format
 *   - SEC Form D (private placement notice)
 *   - FINRA TRACE (trade reporting)
 */

import logger from "../logger.js";
import {
  listTaxForms,
  getTaxForm,
  getTaxYearSummary,
  IRS_1099_THRESHOLD_USD,
} from "../database/tax-forms.js";
import { getContributorTax } from "../database/contributor-tax.js";
import { getXlmUsdPrice, xlmToUsdCents } from "./price-oracle.js";
import { createComplianceReport, listComplianceReports, getComplianceReport } from "../database/compliance-reports.js";

const STROOPS_PER_XLM = 10_000_000;
const IRS_BACKUP_WITHHOLDING_RATE = 0.24;

function stroopsToXlm(stroops) {
  return Number(stroops) / STROOPS_PER_XLM;
}

export function getCurrentTaxYear() {
  return new Date().getFullYear();
}

function escapeCsvField(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function getPriceRate(priceOracleFn = getXlmUsdPrice) {
  const result = await priceOracleFn();
  if (!result.ok) {
    throw new Error(`price_oracle_unavailable: ${result.reason}`);
  }
  return result.rate;
}

function buildPaymentBreakdown(distributions, rate) {
  const breakdown = [];
  for (const dist of distributions) {
    const xlm = typeof dist.amountXlm !== "undefined"
      ? Number(dist.amountXlm)
      : stroopsToXlm(dist.amountStroops ?? 0);

    const usdCents = xlmToUsdCents(xlm, rate);
    breakdown.push({
      timestamp: dist.timestamp ?? null,
      txHash: dist.txHash ?? null,
      xlmAmount: xlm.toFixed(7),
      usdCents,
      usdAmount: (usdCents / 100).toFixed(2),
    });
  }
  return breakdown;
}

function calculateGainsLosses(paymentBreakdown, costBasisUsdPerXlm = 0) {
  const results = [];
  for (const p of paymentBreakdown) {
    const proceeds = p.usdCents / 100;
    const costBasis = costBasisUsdPerXlm > 0
      ? (parseFloat(p.xlmAmount) * costBasisUsdPerXlm)
      : proceeds;
    const gainLoss = proceeds - costBasis;
    results.push({
      ...p,
      proceedsUsd: proceeds.toFixed(2),
      costBasisUsd: costBasis.toFixed(2),
      gainLossUsd: gainLoss.toFixed(2),
      gainLossType: gainLoss >= 0 ? "gain" : "loss",
    });
  }
  return results;
}

export async function generateForm8949({
  walletAddress,
  taxYear = getCurrentTaxYear() - 1,
  distributions = [],
  costBasisUsdPerXlm = 0,
  shortTerm = true,
  force = false,
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  if (!walletAddress) return { ok: false, reason: "missing_wallet_address" };
  if (!taxYear) return { ok: false, reason: "missing_tax_year" };

  const year = String(taxYear);
  const rate = await getPriceRate(priceOracleFn);

  const paymentBreakdown = buildPaymentBreakdown(distributions, rate);
  const gainsLosses = calculateGainsLosses(paymentBreakdown, costBasisUsdPerXlm);

  const shortTermGains = gainsLosses.filter(g => g.gainLossType === "gain");
  const shortTermLosses = gainsLosses.filter(g => g.gainLossType === "loss");

  const totalProceeds = gainsLosses.reduce((sum, g) => sum + parseFloat(g.proceedsUsd), 0);
  const totalCostBasis = gainsLosses.reduce((sum, g) => sum + parseFloat(g.costBasisUsd), 0);
  const netGainLoss = totalProceeds - totalCostBasis;

  const formData = {
    formType: "Form 8949",
    taxYear: year,
    country: "US",
    walletAddress,
    shortTerm,
    part: shortTerm ? "I" : "II",
    totals: {
      proceeds: totalProceeds.toFixed(2),
      costBasis: totalCostBasis.toFixed(2),
      netGainLoss: netGainLoss.toFixed(2),
      transactionCount: gainsLosses.length,
    },
    transactions: gainsLosses.map((g, i) => ({
      line: i + 1,
      description: `XLM Distribution ${g.txHash ? `(tx: ${g.txHash.slice(0, 8)}...)` : ""}`,
      dateAcquired: "Various",
      dateSold: g.timestamp ? new Date(g.timestamp).toISOString().slice(0, 10) : "Various",
      proceeds: g.proceedsUsd,
      costBasis: g.costBasisUsd,
      gainLoss: g.gainLossUsd,
      adjustmentCode: "",
      adjustmentAmount: "0.00",
    })),
    generatedAt: new Date().toISOString(),
    pdfReady: true,
    note: "Render with IRS Form 8949 template. Attach to Schedule D (Form 1040).",
  };

  return { ok: true, form: formData };
}

export async function generateTurboTaxImport({
  walletAddress,
  taxYear = getCurrentTaxYear() - 1,
  distributions = [],
  costBasisUsdPerXlm = 0,
  force = false,
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  if (!walletAddress) return { ok: false, reason: "missing_wallet_address" };
  if (!taxYear) return { ok: false, reason: "missing_tax_year" };

  const year = String(taxYear);
  const rate = await getPriceRate(priceOracleFn);

  const paymentBreakdown = buildPaymentBreakdown(distributions, rate);
  const gainsLosses = calculateGainsLosses(paymentBreakdown, costBasisUsdPerXlm);

  const rows = gainsLosses.map(g => ({
    "Transaction Type": "Sale",
    "Date Acquired": "Various",
    "Date Sold": g.timestamp ? new Date(g.timestamp).toISOString().slice(0, 10) : "Various",
    "Proceeds": g.proceedsUsd,
    "Cost Basis": g.costBasisUsd,
    "Gain/Loss": g.gainLossUsd,
    "Description": `XLM Distribution ${g.txHash ? `(tx: ${g.txHash.slice(0, 8)}...)` : ""}`,
    "Symbol": "XLM",
    "Quantity": g.xlmAmount,
    "Unit Price": (g.usdCents / 100 / parseFloat(g.xlmAmount)).toFixed(4),
    "Exchange": "Stellar Network",
    "Category": "Cryptocurrency",
  }));

  return {
    ok: true,
    format: "TurboTax",
    taxYear: year,
    walletAddress,
    rows,
    headers: Object.keys(rows[0] || {}),
    generatedAt: new Date().toISOString(),
    importNote: "Import as CSV in TurboTax > Investment Income > Stocks, Bonds, Mutual Funds",
  };
}

export async function generateCsvExport({
  walletAddress = null,
  taxYear = getCurrentTaxYear() - 1,
  country = null,
  format = "detailed",
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  const year = String(taxYear);
  const rate = await getPriceRate(priceOracleFn);

  const forms = listTaxForms({ taxYear: year, country, status: "generated" });

  if (walletAddress) {
    const filtered = forms.filter(f => f.walletAddress === walletAddress);
    if (filtered.length === 0) return { ok: false, reason: "no_forms_found" };
  }

  const headers = [
    "Wallet Address",
    "Form Type",
    "Country",
    "Tax Year",
    "Total Income (USD)",
    "Withheld (USD)",
    "Status",
    "Generated At",
    "XLM/USD Rate Used",
    "Meets Filing Threshold",
    "Backup Withholding Applied",
  ];

  const rows = [headers.map(escapeCsvField).join(",")];

  for (const form of forms) {
    const fd = form.formData || {};
    rows.push([
      escapeCsvField(form.walletAddress),
      escapeCsvField(form.formType),
      escapeCsvField(form.country),
      escapeCsvField(form.taxYear),
      escapeCsvField((form.totalIncomeUsd / 100).toFixed(2)),
      escapeCsvField((form.withheldUsd / 100).toFixed(2)),
      escapeCsvField(form.status),
      escapeCsvField(form.createdAt),
      escapeCsvField(fd.xlmUsdRateUsed ?? rate),
      escapeCsvField(fd.meetsFilingThreshold ?? false),
      escapeCsvField(fd.backupWithholdingApplied ?? false),
    ].join(","));
  }

  const csv = rows.join("\n");
  return {
    ok: true,
    format: "CSV",
    taxYear: year,
    csv,
    rowCount: forms.length,
    generatedAt: new Date().toISOString(),
  };
}

export async function generateGenericLedger({
  walletAddress = null,
  startDate,
  endDate,
  contractId = "ALL",
  format = "json",
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  if (!startDate || !endDate) {
    return { ok: false, reason: "missing_date_range" };
  }

  const rate = await getPriceRate(priceOracleFn);

  const forms = listTaxForms({
    status: "generated",
    ...(walletAddress && { walletAddress }),
  });

  const filtered = forms.filter(f => {
    const created = new Date(f.createdAt);
    return created >= new Date(startDate) && created <= new Date(endDate);
  });

  const entries = filtered.map(form => {
    const fd = form.formData || {};
    const breakdown = fd.paymentBreakdown || [];
    return breakdown.map(p => ({
      date: p.timestamp ? new Date(p.timestamp).toISOString().slice(0, 10) : form.createdAt.slice(0, 10),
      walletAddress: form.walletAddress,
      formType: form.formType,
      country: form.country,
      txHash: p.txHash,
      xlmAmount: parseFloat(p.xlmAmount),
      usdAmount: parseFloat(p.usdAmount),
      xlmUsdRate: fd.xlmUsdRateUsed ?? rate,
      description: `Royalty distribution ${p.txHash ? `(${p.txHash.slice(0, 8)})` : ""}`,
      category: "royalty_income",
    }));
  }).flat();

  if (format === "csv") {
    const headers = [
      "Date",
      "Wallet Address",
      "Form Type",
      "Country",
      "Transaction Hash",
      "XLM Amount",
      "USD Amount",
      "XLM/USD Rate",
      "Description",
      "Category",
    ];
    const rows = [headers.map(escapeCsvField).join(",")];
    for (const e of entries) {
      rows.push([
        escapeCsvField(e.date),
        escapeCsvField(e.walletAddress),
        escapeCsvField(e.formType),
        escapeCsvField(e.country),
        escapeCsvField(e.txHash),
        escapeCsvField(e.xlmAmount.toFixed(7)),
        escapeCsvField(e.usdAmount.toFixed(2)),
        escapeCsvField(e.xlmUsdRate),
        escapeCsvField(e.description),
        escapeCsvField(e.category),
      ].join(","));
    }
    return {
      ok: true,
      format: "CSV",
      csv: rows.join("\n"),
      entryCount: entries.length,
      generatedAt: new Date().toISOString(),
    };
  }

  return {
    ok: true,
    format: "JSON",
    entries,
    summary: {
      totalEntries: entries.length,
      totalXlm: entries.reduce((sum, e) => sum + e.xlmAmount, 0),
      totalUsd: entries.reduce((sum, e) => sum + e.usdAmount, 0),
      dateRange: { start: startDate, end: endDate },
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function generateSecFormD({
  walletAddress,
  taxYear = getCurrentTaxYear() - 1,
  distributions = [],
  issuerInfo = {},
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  if (!walletAddress) return { ok: false, reason: "missing_wallet_address" };

  const year = String(taxYear);
  const rate = await getPriceRate(priceOracleFn);

  const paymentBreakdown = buildPaymentBreakdown(distributions, rate);
  const totalUsd = paymentBreakdown.reduce((sum, p) => sum + p.usdCents / 100, 0);
  const totalXlm = paymentBreakdown.reduce((sum, p) => sum + parseFloat(p.xlmAmount), 0);

  const formData = {
    formType: "SEC Form D",
    taxYear: year,
    country: "US",
    walletAddress,
    issuer: {
      name: issuerInfo.name || "Stellar Royalty Splitter",
      cik: issuerInfo.cik || null,
      address: issuerInfo.address || null,
      stateOfIncorporation: issuerInfo.stateOfIncorporation || "DE",
    },
    offering: {
      type: "Rule 506(c)",
      totalOfferingAmount: totalUsd.toFixed(2),
      amountSold: totalUsd.toFixed(2),
      remainingAmount: "0.00",
      minInvestment: "0.00",
      investors: {
        accredited: 1,
        nonAccredited: 0,
        total: 1,
      },
    },
    securities: {
      type: "Digital Asset (XLM)",
      totalUnits: totalXlm.toFixed(7),
      pricePerUnit: rate.toFixed(4),
    },
    useOfProceeds: "Royalty distributions to collaborators",
    generatedAt: new Date().toISOString(),
    pdfReady: true,
    note: "File electronically via SEC EDGAR within 15 days of first sale. Consult securities counsel.",
  };

  return { ok: true, form: formData };
}

export async function generateFinraTrace({
  walletAddress,
  startDate,
  endDate,
  contractId = "ALL",
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  if (!startDate || !endDate) {
    return { ok: false, reason: "missing_date_range" };
  }

  const rate = await getPriceRate(priceOracleFn);

  const forms = listTaxForms({
    status: "generated",
    ...(walletAddress && { walletAddress }),
  });

  const filtered = forms.filter(f => {
    const created = new Date(f.createdAt);
    return created >= new Date(startDate) && created <= new Date(endDate);
  });

  const trades = filtered.map(form => {
    const fd = form.formData || {};
    const breakdown = fd.paymentBreakdown || [];
    return breakdown.map(p => ({
      tradeDate: p.timestamp ? new Date(p.timestamp).toISOString().slice(0, 10) : form.createdAt.slice(0, 10),
      tradeTime: p.timestamp ? new Date(p.timestamp).toISOString().slice(11, 19) : "00:00:00",
      symbol: "XLM",
      securityType: "DIGITAL_ASSET",
      buySell: "SELL",
      quantity: parseFloat(p.xlmAmount),
      price: rate,
      proceeds: p.usdCents / 100,
      counterparty: form.walletAddress,
      executingBroker: "Stellar Royalty Splitter",
      clearingFirm: null,
      venue: "STELLAR_NETWORK",
      capacity: "AGENCY",
    }));
  }).flat();

  return {
    ok: true,
    format: "FINRA TRACE",
    trades,
    summary: {
      totalTrades: trades.length,
      totalQuantity: trades.reduce((sum, t) => sum + t.quantity, 0),
      totalProceeds: trades.reduce((sum, t) => sum + t.proceeds, 0),
      dateRange: { start: startDate, end: endDate },
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function exportComplianceReport({
  taxYear = getCurrentTaxYear() - 1,
  format = "json",
  walletAddress = null,
  country = null,
  startDate = null,
  endDate = null,
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  const year = String(taxYear);
  const rate = await getPriceRate(priceOracleFn);

  const summary = getTaxYearSummary(year);
  const forms = listTaxForms({ taxYear: year, country, status: "generated" });

  const filteredSummary = country
    ? summary.filter(r => r.country === country)
    : summary;

  const totalIncome = filteredSummary.reduce((acc, r) => acc + (r.totalIncomeUsd ?? 0), 0);
  const totalWithheld = filteredSummary.reduce((acc, r) => acc + (r.totalWithheldUsd ?? 0), 0);

  const report = {
    taxYear: year,
    country: country ?? "ALL",
    walletAddress: walletAddress ?? "ALL",
    summary: filteredSummary,
    forms: forms.map(f => ({
      id: f.id,
      walletAddress: f.walletAddress,
      formType: f.formType,
      country: f.country,
      totalIncomeUsd: (f.totalIncomeUsd / 100).toFixed(2),
      withheldUsd: (f.withheldUsd / 100).toFixed(2),
      status: f.status,
      createdAt: f.createdAt,
      xlmUsdRateUsed: f.formData?.xlmUsdRateUsed ?? rate,
      meetsFilingThreshold: f.formData?.meetsFilingThreshold ?? false,
      backupWithholdingApplied: f.formData?.backupWithholdingApplied ?? false,
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
  };

  if (format === "csv") {
    const headers = [
      "Wallet Address",
      "Form Type",
      "Country",
      "Tax Year",
      "Total Income (USD)",
      "Withheld (USD)",
      "Status",
      "Generated At",
      "XLM/USD Rate",
      "Meets Threshold",
      "Backup Withholding",
    ];
    const rows = [headers.map(escapeCsvField).join(",")];
    for (const form of report.forms) {
      rows.push([
        escapeCsvField(form.walletAddress),
        escapeCsvField(form.formType),
        escapeCsvField(form.country),
        escapeCsvField(year),
        escapeCsvField(form.totalIncomeUsd),
        escapeCsvField(form.withheldUsd),
        escapeCsvField(form.status),
        escapeCsvField(form.createdAt),
        escapeCsvField(form.xlmUsdRateUsed),
        escapeCsvField(form.meetsFilingThreshold),
        escapeCsvField(form.backupWithholdingApplied),
      ].join(","));
    }
    return { ok: true, format: "CSV", csv: rows.join("\n"), ...report };
  }

  return { ok: true, format: "JSON", ...report };
}

export async function getAuditTrail({
  walletAddress = null,
  startDate = null,
  endDate = null,
  limit = 100,
  offset = 0,
} = {}) {
  const reports = listComplianceReports({}, limit, offset);

  const filtered = reports.filter(r => {
    if (walletAddress && r.metadata?.walletAddress && r.metadata.walletAddress !== walletAddress) {
      return false;
    }
    if (startDate && new Date(r.createdAt) < new Date(startDate)) return false;
    if (endDate && new Date(r.createdAt) > new Date(endDate)) return false;
    return true;
  });

  return {
    reports: filtered,
    total: filtered.length,
    generatedAt: new Date().toISOString(),
  };
}

export async function verifyReportAccuracy({
  reportId,
  walletAddress,
  taxYear,
  distributions,
  priceOracleFn = getXlmUsdPrice,
} = {}) {
  const report = getComplianceReport(reportId);
  if (!report) return { ok: false, reason: "report_not_found" };

  if (report.status !== "completed") {
    return { ok: false, reason: "report_not_completed" };
  }

  const rate = await getPriceRate(priceOracleFn);
  const paymentBreakdown = buildPaymentBreakdown(distributions, rate);
  const calculatedTotal = paymentBreakdown.reduce((sum, p) => sum + p.usdCents / 100, 0);
  const storedTotal = report.metadata?.totalDistributed ?? 0;

  const tolerance = 0.01;
  const matches = Math.abs(calculatedTotal - storedTotal) <= tolerance;

  return {
    ok: true,
    verified: matches,
    calculatedTotal: calculatedTotal.toFixed(2),
    storedTotal: storedTotal.toFixed(2),
    difference: (calculatedTotal - storedTotal).toFixed(2),
    tolerance,
    checkedAt: new Date().toISOString(),
  };
}