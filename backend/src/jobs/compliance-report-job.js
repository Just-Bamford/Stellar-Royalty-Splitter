/**
 * Background job: Generate automated compliance reports on schedule (#601).
 *
 * Schedule:
 *   - Monthly:   1st of each month at 02:00 UTC
 *   - Quarterly: 1st of Jan, Apr, Jul, Oct at 02:00 UTC
 *   - Annual:    1st of January at 03:00 UTC
 *
 * Reports include: transaction summaries, payout totals, tax info, audit data.
 * Generated reports are stored in the database and emailed to configured recipients.
 */

import logger from "../logger.js";
import { db } from "../database/core.js";
import { saveComplianceReport, getComplianceScheduleConfig } from "../database/compliance-reports.js";
import { addAuditLog } from "../database/audit.js";
import { sendEmail, isEmailConfigured } from "../email/email-service.js";
import { parsePositiveInt } from "../utils.js";

const COMPLIANCE_CHECK_INTERVAL_MS = parsePositiveInt(
  process.env.COMPLIANCE_CHECK_INTERVAL_MS,
  60 * 60 * 1000 // 1 hour
);

// ---------------------------------------------------------------------------
// Report data assembly
// ---------------------------------------------------------------------------

/**
 * Gather all data needed for a compliance report.
 */
function gatherReportData(periodStart, periodEnd) {
  const transactions = db.prepare(`
    SELECT
      type,
      status,
      COUNT(*) AS count,
      COALESCE(SUM(CAST(requestedAmount AS REAL)), 0) AS total_amount
    FROM transactions
    WHERE timestamp BETWEEN ? AND ?
    GROUP BY type, status
    ORDER BY type, status
  `).all(periodStart, periodEnd);

  const payouts = db.prepare(`
    SELECT
      COUNT(*) AS total_payouts,
      COUNT(DISTINCT dp.collaboratorAddress) AS unique_recipients,
      COALESCE(SUM(CAST(dp.amountReceived AS REAL)), 0) AS total_distributed
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE t.status = 'confirmed'
      AND t.timestamp BETWEEN ? AND ?
  `).get(periodStart, periodEnd);

  const topRecipients = db.prepare(`
    SELECT
      dp.collaboratorAddress AS address,
      SUM(CAST(dp.amountReceived AS REAL)) AS total_received,
      COUNT(*) AS payout_count
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE t.status = 'confirmed'
      AND t.timestamp BETWEEN ? AND ?
    GROUP BY dp.collaboratorAddress
    ORDER BY total_received DESC
    LIMIT 10
  `).all(periodStart, periodEnd);

  const taxCompliance = db.prepare(`
    SELECT
      tax_status,
      COUNT(*) AS count
    FROM contributor_tax
    GROUP BY tax_status
  `).all();

  const auditSummary = db.prepare(`
    SELECT
      action,
      COUNT(*) AS count
    FROM audit_log
    WHERE timestamp BETWEEN ? AND ?
    GROUP BY action
    ORDER BY count DESC
    LIMIT 20
  `).all(periodStart, periodEnd);

  return { transactions, payouts, topRecipients, taxCompliance, auditSummary };
}

/**
 * Render an HTML email report.
 */
function renderReportHtml(reportType, periodStart, periodEnd, data) {
  const { transactions, payouts, topRecipients, taxCompliance, auditSummary } = data;

  const txRows = transactions.map(
    (t) => `<tr><td>${t.type}</td><td>${t.status}</td><td>${t.count}</td><td>${Math.round(t.total_amount * 100) / 100}</td></tr>`
  ).join("");

  const topRows = topRecipients.map(
    (r) => `<tr><td>${r.address.substring(0, 12)}...</td><td>${Math.round(r.total_received * 100) / 100}</td><td>${r.payout_count}</td></tr>`
  ).join("");

  const taxRows = taxCompliance.map(
    (t) => `<tr><td>${t.tax_status ?? "null"}</td><td>${t.count}</td></tr>`
  ).join("");

  return `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: Arial, sans-serif; color: #333; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
  th { background: #f0f4ff; }
  h2 { color: #1a237e; }
  .badge { background: #e8f5e9; color: #2e7d32; border-radius: 4px; padding: 2px 8px; font-weight: bold; }
</style></head>
<body>
  <h2>Stellar Royalty Splitter — ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Compliance Report</h2>
  <p>Period: <strong>${periodStart}</strong> to <strong>${periodEnd}</strong></p>
  <p>Generated: <strong>${new Date().toUTCString()}</strong></p>

  <h3>Distribution Summary</h3>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total Payouts</td><td>${payouts?.total_payouts ?? 0}</td></tr>
    <tr><td>Unique Recipients</td><td>${payouts?.unique_recipients ?? 0}</td></tr>
    <tr><td>Total Distributed</td><td>${Math.round((payouts?.total_distributed ?? 0) * 100) / 100}</td></tr>
  </table>

  <h3>Transaction Breakdown</h3>
  <table>
    <tr><th>Type</th><th>Status</th><th>Count</th><th>Total Amount</th></tr>
    ${txRows || "<tr><td colspan='4'>No transactions in period</td></tr>"}
  </table>

  <h3>Top 10 Recipients</h3>
  <table>
    <tr><th>Address</th><th>Total Received</th><th>Payouts</th></tr>
    ${topRows || "<tr><td colspan='3'>No payouts in period</td></tr>"}
  </table>

  <h3>Tax Compliance Status</h3>
  <table>
    <tr><th>Status</th><th>Count</th></tr>
    ${taxRows || "<tr><td colspan='2'>No tax records</td></tr>"}
  </table>

  <h3>Audit Activity Summary</h3>
  <table>
    <tr><th>Action</th><th>Count</th></tr>
    ${auditSummary.map((a) => `<tr><td>${a.action}</td><td>${a.count}</td></tr>`).join("") || "<tr><td colspan='2'>No audit events</td></tr>"}
  </table>

  <p style="color:#888;font-size:12px">This is an automated compliance report from Stellar Royalty Splitter.</p>
</body>
</html>`;
}

/**
 * Generate and save a compliance report for the given type and period.
 */
export async function generateComplianceReport(reportType, periodStart, periodEnd) {
  logger.info("Generating compliance report", { reportType, periodStart, periodEnd });

  const data = gatherReportData(periodStart, periodEnd);
  const summary = {
    total_payouts: data.payouts?.total_payouts ?? 0,
    total_distributed: Math.round((data.payouts?.total_distributed ?? 0) * 100) / 100,
    unique_recipients: data.payouts?.unique_recipients ?? 0,
    transaction_count: data.transactions.reduce((s, t) => s + t.count, 0),
  };

  const report = saveComplianceReport({
    report_type: reportType,
    period_start: periodStart,
    period_end: periodEnd,
    generated_by: "system",
    status: "generated",
    summary,
  });

  addAuditLog("system", "compliance_report_generated", "system", {
    reportId: report.id,
    reportType,
    periodStart,
    periodEnd,
    summary,
  });

  // Email report to configured recipients
  const config = getComplianceScheduleConfig();
  let recipients = [];
  try {
    recipients = JSON.parse(config?.email_recipients ?? "[]");
  } catch (_) {}

  // Also include ADMIN_ALERT_EMAIL if set
  const adminEmail = process.env.COMPLIANCE_REPORT_EMAIL ?? process.env.ADMIN_ALERT_EMAIL;
  if (adminEmail && !recipients.includes(adminEmail)) {
    recipients.push(adminEmail);
  }

  if (recipients.length > 0 && isEmailConfigured()) {
    const subject = `[Compliance Report] ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} — ${periodStart} to ${periodEnd}`;
    const html = renderReportHtml(reportType, periodStart, periodEnd, data);
    const text = `Compliance Report: ${reportType}\nPeriod: ${periodStart} to ${periodEnd}\nTotal Payouts: ${summary.total_payouts}\nTotal Distributed: ${summary.total_distributed}\nUnique Recipients: ${summary.unique_recipients}`;

    const emailResult = await sendEmail({
      to: recipients.join(", "),
      subject,
      html,
      text,
    });

    if (emailResult.sent) {
      // Update report status to emailed
      saveComplianceReport({
        ...report,
        summary,
        status: "emailed",
        emailed_to: recipients.join(", "),
      });
      logger.info("Compliance report emailed", { reportId: report.id, recipients });
    }
  }

  return report;
}

/**
 * Determine which reports should be generated for the current time.
 */
export function getReportsDue(now = new Date()) {
  const config = getComplianceScheduleConfig();
  const due = [];

  const month = now.getUTCMonth(); // 0-11
  const day = now.getUTCDate();
  const hour = now.getUTCHours();

  // Monthly: on the 1st of each month at 02:00 UTC
  if (config?.monthly_enabled && day === 1 && hour === 2) {
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), month - 1, 1));
    const prevMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), month, 0, 23, 59, 59));
    due.push({
      type: "monthly",
      periodStart: prevMonthStart.toISOString().split("T")[0],
      periodEnd: prevMonthEnd.toISOString().split("T")[0],
    });
  }

  // Quarterly: 1st of Jan(0), Apr(3), Jul(6), Oct(9) at 02:00 UTC
  if (config?.quarterly_enabled && [0, 3, 6, 9].includes(month) && day === 1 && hour === 2) {
    const qStart = new Date(Date.UTC(now.getUTCFullYear(), month - 3, 1));
    const qEnd = new Date(Date.UTC(now.getUTCFullYear(), month, 0, 23, 59, 59));
    due.push({
      type: "quarterly",
      periodStart: qStart.toISOString().split("T")[0],
      periodEnd: qEnd.toISOString().split("T")[0],
    });
  }

  // Annual: 1st of January at 03:00 UTC
  if (config?.annual_enabled && month === 0 && day === 1 && hour === 3) {
    const yearStart = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
    const yearEnd = new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 31, 23, 59, 59));
    due.push({
      type: "annual",
      periodStart: yearStart.toISOString().split("T")[0],
      periodEnd: yearEnd.toISOString().split("T")[0],
    });
  }

  return due;
}

/**
 * Main compliance report job — run on schedule.
 */
export async function runComplianceReportJob(now = new Date()) {
  const due = getReportsDue(now);

  if (due.length === 0) return { generated: 0 };

  logger.info("Compliance reports due", { count: due.length });

  let generated = 0;
  for (const { type, periodStart, periodEnd } of due) {
    try {
      await generateComplianceReport(type, periodStart, periodEnd);
      generated++;
    } catch (err) {
      logger.error("Failed to generate compliance report", { type, periodStart, periodEnd, error: err.message });
    }
  }

  return { generated };
}

/**
 * Start the compliance report scheduler. Returns a stop function.
 */
export function startComplianceReportScheduler() {
  logger.info("Starting compliance report scheduler", { intervalMs: COMPLIANCE_CHECK_INTERVAL_MS });

  const interval = setInterval(async () => {
    try {
      await runComplianceReportJob();
    } catch (err) {
      logger.error("Compliance report scheduler error", { error: err.message });
    }
  }, COMPLIANCE_CHECK_INTERVAL_MS);

  interval.unref();

  return {
    stop() {
      clearInterval(interval);
      logger.info("Compliance report scheduler stopped");
    },
  };
}
