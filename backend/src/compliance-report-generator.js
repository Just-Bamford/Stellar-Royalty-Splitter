/**
 * Compliance report generator — closes #601.
 *
 * Builds structured report data from the database for monthly, quarterly,
 * and annual periods, then renders HTML and plaintext versions for email delivery
 * and file archival.
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { db } from "./database/core.js";
import logger from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = process.env.COMPLIANCE_REPORTS_DIR
  ?? path.join(__dirname, "..", "compliance_reports");

// Ensure the reports directory exists
try {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
} catch { /* already exists */ }

// ─── Data queries ─────────────────────────────────────────────────────────────

/**
 * Gather all data needed for a compliance report.
 *
 * @param {string} periodStart - ISO date "YYYY-MM-DD"
 * @param {string} periodEnd   - ISO date "YYYY-MM-DD"
 * @param {string} contractId  - "ALL" or specific contract
 * @returns {object}
 */
export function gatherReportData(periodStart, periodEnd, contractId = "ALL") {
  const contractFilter = contractId !== "ALL" ? "AND t.contractId = ?" : "";
  const baseParams = contractId !== "ALL" ? [periodStart, periodEnd, contractId] : [periodStart, periodEnd];

  // Transaction summary
  const txSummary = db.prepare(`
    SELECT
      COUNT(*) AS totalTransactions,
      COUNT(CASE WHEN t.status = 'confirmed' THEN 1 END) AS confirmedTransactions,
      COUNT(CASE WHEN t.status = 'failed'    THEN 1 END) AS failedTransactions,
      COALESCE(SUM(CASE WHEN t.status = 'confirmed'
        THEN CAST(dp.amountReceived AS REAL) END), 0) AS totalDistributed
    FROM transactions t
    LEFT JOIN distribution_payouts dp ON dp.transactionId = t.id
    WHERE DATE(COALESCE(t.blockTime, t.timestamp)) BETWEEN ? AND ?
      ${contractFilter}
      AND t.type = 'distribute'
  `).get(...baseParams);

  // Per-contract breakdown
  const contractBreakdown = db.prepare(`
    SELECT
      t.contractId,
      COUNT(DISTINCT t.id) AS distributions,
      COALESCE(SUM(CAST(dp.amountReceived AS REAL)), 0) AS totalPaid,
      COUNT(DISTINCT dp.collaboratorAddress) AS uniqueRecipients
    FROM transactions t
    JOIN distribution_payouts dp ON dp.transactionId = t.id
    WHERE DATE(COALESCE(t.blockTime, t.timestamp)) BETWEEN ? AND ?
      ${contractFilter}
      AND t.status = 'confirmed'
      AND t.type = 'distribute'
    GROUP BY t.contractId
    ORDER BY totalPaid DESC
  `).all(...baseParams);

  // Top earners in period
  const topEarners = db.prepare(`
    SELECT
      dp.collaboratorAddress AS walletAddress,
      COUNT(*) AS payouts,
      SUM(CAST(dp.amountReceived AS REAL)) AS totalReceived
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE DATE(COALESCE(t.blockTime, t.timestamp)) BETWEEN ? AND ?
      ${contractFilter}
      AND t.status = 'confirmed'
      AND t.type = 'distribute'
    GROUP BY dp.collaboratorAddress
    ORDER BY totalReceived DESC
    LIMIT 20
  `).all(...baseParams);

  // Tax completeness
  const taxSummary = db.prepare(`
    SELECT
      COUNT(*) AS totalContributors,
      COUNT(CASE WHEN ct.tax_status = 'completed' THEN 1 END) AS taxCompleted,
      COUNT(CASE WHEN ct.tax_status = 'pending'   THEN 1 END) AS taxPending,
      COUNT(CASE WHEN ct.tax_status IS NULL
               OR ct.tax_status = 'not_collected' THEN 1 END) AS taxMissing
    FROM (
      SELECT DISTINCT dp.collaboratorAddress
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE DATE(COALESCE(t.blockTime, t.timestamp)) BETWEEN ? AND ?
        ${contractFilter}
        AND t.status = 'confirmed'
    ) AS active
    LEFT JOIN contributor_tax ct ON ct.walletAddress = active.collaboratorAddress
  `).get(...baseParams);

  // Monthly trend within period
  const monthlyTrend = db.prepare(`
    SELECT
      strftime('%Y-%m', COALESCE(t.blockTime, t.timestamp)) AS month,
      COUNT(*) AS distributions,
      COALESCE(SUM(CAST(dp.amountReceived AS REAL)), 0) AS amount
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE DATE(COALESCE(t.blockTime, t.timestamp)) BETWEEN ? AND ?
      ${contractFilter}
      AND t.status = 'confirmed'
      AND t.type = 'distribute'
    GROUP BY month
    ORDER BY month ASC
  `).all(...baseParams);

  return { txSummary, contractBreakdown, topEarners, taxSummary, monthlyTrend };
}

// ─── HTML renderer ────────────────────────────────────────────────────────────

/**
 * Render an HTML compliance report.
 *
 * @param {object} params
 * @returns {string} HTML string
 */
export function renderReportHtml({ type, periodStart, periodEnd, contractId, data, generatedAt }) {
  const { txSummary, contractBreakdown, topEarners, taxSummary, monthlyTrend } = data;
  const title = `${type.charAt(0).toUpperCase() + type.slice(1)} Compliance Report`;

  const contractRows = contractBreakdown.map((c) => `
    <tr>
      <td>${c.contractId}</td>
      <td>${c.distributions}</td>
      <td>${c.uniqueRecipients}</td>
      <td>${Number(c.totalPaid).toFixed(2)}</td>
    </tr>`).join("");

  const earnerRows = topEarners.slice(0, 10).map((e, i) => `
    <tr>
      <td>${i + 1}</td>
      <td style="font-family:monospace;font-size:12px">${e.walletAddress}</td>
      <td>${e.payouts}</td>
      <td>${Number(e.totalReceived).toFixed(2)}</td>
    </tr>`).join("");

  const trendRows = monthlyTrend.map((m) => `
    <tr>
      <td>${m.month}</td>
      <td>${m.distributions}</td>
      <td>${Number(m.amount).toFixed(2)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
  body { font-family: Arial, sans-serif; color: #222; max-width: 900px; margin: 0 auto; padding: 24px; }
  h1 { color: #1a1a2e; border-bottom: 2px solid #e0e0e0; padding-bottom: 8px; }
  h2 { color: #374151; margin-top: 32px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 16px 0; }
  .metric-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .metric-card .value { font-size: 28px; font-weight: bold; color: #1a1a2e; }
  .metric-card .label { font-size: 12px; color: #6b7280; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { background: #f1f5f9; text-align: left; padding: 8px 12px; font-size: 13px; color: #374151; }
  td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e0e0e0; color: #9ca3af; font-size: 12px; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="meta">
  Period: <strong>${periodStart}</strong> to <strong>${periodEnd}</strong>
  &nbsp;|&nbsp; Contract: <strong>${contractId}</strong>
  &nbsp;|&nbsp; Generated: <strong>${generatedAt}</strong>
</div>

<h2>Transaction Summary</h2>
<div class="summary-grid">
  <div class="metric-card">
    <div class="value">${txSummary.totalTransactions}</div>
    <div class="label">Total Transactions</div>
  </div>
  <div class="metric-card">
    <div class="value">${txSummary.confirmedTransactions}</div>
    <div class="label">Confirmed</div>
  </div>
  <div class="metric-card">
    <div class="value">${txSummary.failedTransactions}</div>
    <div class="label">Failed</div>
  </div>
  <div class="metric-card">
    <div class="value">${Number(txSummary.totalDistributed).toFixed(2)}</div>
    <div class="label">Total Distributed</div>
  </div>
</div>

<h2>Monthly Trend</h2>
<table>
  <thead><tr><th>Month</th><th>Distributions</th><th>Amount</th></tr></thead>
  <tbody>${trendRows}</tbody>
</table>

<h2>Contract Breakdown</h2>
<table>
  <thead><tr><th>Contract</th><th>Distributions</th><th>Recipients</th><th>Total Paid</th></tr></thead>
  <tbody>${contractRows}</tbody>
</table>

<h2>Top Recipients (Top 10)</h2>
<table>
  <thead><tr><th>#</th><th>Wallet Address</th><th>Payouts</th><th>Total Received</th></tr></thead>
  <tbody>${earnerRows}</tbody>
</table>

<h2>Tax Compliance</h2>
<table>
  <thead><tr><th>Status</th><th>Count</th></tr></thead>
  <tbody>
    <tr><td>Tax Info Completed</td><td>${taxSummary.taxCompleted}</td></tr>
    <tr><td>Tax Info Pending</td><td>${taxSummary.taxPending}</td></tr>
    <tr><td>Tax Info Missing</td><td>${taxSummary.taxMissing}</td></tr>
    <tr><td><strong>Total Contributors</strong></td><td><strong>${taxSummary.totalContributors}</strong></td></tr>
  </tbody>
</table>

<div class="footer">
  Generated by Stellar Royalty Splitter Compliance Module &bull; ${generatedAt}
</div>
</body>
</html>`;
}

/**
 * Render a plain-text compliance report for email fallback.
 */
export function renderReportText({ type, periodStart, periodEnd, contractId, data, generatedAt }) {
  const { txSummary, topEarners, taxSummary } = data;
  const title = `${type.toUpperCase()} COMPLIANCE REPORT`;
  const sep = "=".repeat(60);

  return `${sep}
${title}
${sep}
Period  : ${periodStart} to ${periodEnd}
Contract: ${contractId}
Generated: ${generatedAt}

TRANSACTION SUMMARY
-------------------
Total Transactions : ${txSummary.totalTransactions}
Confirmed          : ${txSummary.confirmedTransactions}
Failed             : ${txSummary.failedTransactions}
Total Distributed  : ${Number(txSummary.totalDistributed).toFixed(2)}

TAX COMPLIANCE
--------------
Tax Completed : ${taxSummary.taxCompleted}
Tax Pending   : ${taxSummary.taxPending}
Tax Missing   : ${taxSummary.taxMissing}
Total Active  : ${taxSummary.totalContributors}

TOP 5 RECIPIENTS
----------------
${topEarners.slice(0, 5).map((e, i) => `${i + 1}. ${e.walletAddress} — ${e.payouts} payouts, ${Number(e.totalReceived).toFixed(2)} received`).join("\n")}

${sep}
Stellar Royalty Splitter — ${generatedAt}
`;
}

// ─── File archival ────────────────────────────────────────────────────────────

/**
 * Save the HTML report to disk and return the file path.
 *
 * @param {number} reportId
 * @param {string} type
 * @param {string} periodStart
 * @param {string} html
 * @returns {string} absolute file path
 */
export function saveReportFile(reportId, type, periodStart, html) {
  const fileName = `compliance-${type}-${periodStart}-id${reportId}.html`;
  const filePath = path.join(REPORTS_DIR, fileName);
  fs.writeFileSync(filePath, html, "utf8");
  logger.info("Compliance report saved to disk", { filePath });
  return filePath;
}
