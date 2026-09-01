/**
 * Automated compliance report scheduler — closes #601.
 *
 * Runs on a configurable interval and checks whether monthly, quarterly,
 * or annual reports are due. Generates and emails them automatically.
 *
 * Schedule logic:
 *   monthly  — first day of each month
 *   quarterly — first day of Jan, Apr, Jul, Oct
 *   annual    — first day of January
 *
 * Reports are emailed to COMPLIANCE_REPORT_RECIPIENTS (comma-separated) and
 * saved to disk for audit archival.
 */

import { createComplianceReport, markReportGenerating, markReportCompleted, markReportFailed, reportExistsForPeriod } from "../database/compliance-reports.js";
import { addAuditLog } from "../database/index.js";
import { gatherReportData, renderReportHtml, renderReportText, saveReportFile } from "../compliance-report-generator.js";
import { sendEmail, isEmailConfigured } from "../email/email-service.js";
import logger from "../logger.js";

// ─── Period calculators ────────────────────────────────────────────────────────

/**
 * Get the previous month period.
 * e.g. called in February → { periodStart: "2026-01-01", periodEnd: "2026-01-31" }
 *
 * @param {Date} now
 * @returns {{ periodStart: string, periodEnd: string }}
 */
export function previousMonthPeriod(now) {
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0)); // last day of month
  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

/**
 * Get the previous quarter period.
 *
 * @param {Date} now
 * @returns {{ periodStart: string, periodEnd: string }}
 */
export function previousQuarterPeriod(now) {
  const d = new Date(now);
  const currentMonth = d.getUTCMonth(); // 0-indexed
  // Quarter starts: 0=Jan, 3=Apr, 6=Jul, 9=Oct
  const currentQuarterStart = Math.floor(currentMonth / 3) * 3;
  const prevQuarterStart = currentQuarterStart - 3;
  const year = prevQuarterStart < 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const startMonth = ((prevQuarterStart % 12) + 12) % 12;
  const endMonth = startMonth + 2;

  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, endMonth + 1, 0)); // last day of last month in quarter
  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

/**
 * Get the previous calendar year period.
 *
 * @param {Date} now
 * @returns {{ periodStart: string, periodEnd: string }}
 */
export function previousYearPeriod(now) {
  const year = new Date(now).getUTCFullYear() - 1;
  return {
    periodStart: `${year}-01-01`,
    periodEnd: `${year}-12-31`,
  };
}

// ─── Due-check logic ──────────────────────────────────────────────────────────

/**
 * Determine which report types are due based on the current UTC date.
 *
 * Monthly  → due on day 1 of any month
 * Quarterly → due on day 1 of Jan, Apr, Jul, Oct
 * Annual   → due on Jan 1
 *
 * @param {Date} now
 * @returns {string[]} Array of report types due
 */
export function getReportTypesDue(now) {
  const day = now.getUTCDate();
  const month = now.getUTCMonth(); // 0-indexed
  const due = [];

  if (day === 1) {
    due.push("monthly");
    if ([0, 3, 6, 9].includes(month)) due.push("quarterly");
    if (month === 0) due.push("annual");
  }

  return due;
}

// ─── Core report generator ────────────────────────────────────────────────────

/**
 * Generate a single compliance report, email it, and archive to disk.
 *
 * @param {string} type        - "monthly" | "quarterly" | "annual"
 * @param {string} periodStart
 * @param {string} periodEnd
 * @param {string} contractId  - "ALL" for global
 * @returns {{ reportId: number, sent: boolean }}
 */
export async function generateComplianceReport(type, periodStart, periodEnd, contractId = "ALL") {
  // Idempotency — skip if already generated for this period
  if (reportExistsForPeriod(type, periodStart, periodEnd, contractId)) {
    logger.info("Compliance report already exists for period; skipping", { type, periodStart, periodEnd });
    return { reportId: null, sent: false, skipped: true };
  }

  const reportRecord = createComplianceReport({ type, periodStart, periodEnd, contractId });
  markReportGenerating(reportRecord.id);

  const generatedAt = new Date().toUTCString();

  try {
    const data = gatherReportData(periodStart, periodEnd, contractId);

    const html = renderReportHtml({ type, periodStart, periodEnd, contractId, data, generatedAt });
    const text = renderReportText({ type, periodStart, periodEnd, contractId, data, generatedAt });

    // Save to disk
    const filePath = saveReportFile(reportRecord.id, type, periodStart, html);

    // Email to configured recipients
    const recipientsRaw = process.env.COMPLIANCE_REPORT_RECIPIENTS ?? "";
    const recipients = recipientsRaw.split(",").map((r) => r.trim()).filter(Boolean);

    let emailSent = false;
    const emailedTo = [];

    if (recipients.length > 0 && isEmailConfigured()) {
      for (const recipient of recipients) {
        const result = await sendEmail({
          to: recipient,
          subject: `[Compliance Report] ${type.charAt(0).toUpperCase() + type.slice(1)} — ${periodStart} to ${periodEnd}`,
          html,
          text,
        });
        if (result.sent) {
          emailedTo.push(recipient);
          emailSent = true;
        }
      }
    } else if (recipients.length === 0) {
      logger.info("No COMPLIANCE_REPORT_RECIPIENTS configured; skipping email delivery");
    } else {
      logger.info("Email not configured; compliance report saved to disk only", { filePath });
    }

    markReportCompleted(reportRecord.id, {
      filePath,
      emailedTo,
      metadata: {
        totalTransactions: data.txSummary.totalTransactions,
        confirmedTransactions: data.txSummary.confirmedTransactions,
        totalDistributed: data.txSummary.totalDistributed,
        taxCompleted: data.taxSummary.taxCompleted,
        taxMissing: data.taxSummary.taxMissing,
      },
    });

    addAuditLog(contractId, "compliance_report_generated", "scheduler", {
      reportId: reportRecord.id,
      type,
      periodStart,
      periodEnd,
      filePath,
      emailedTo,
    });

    logger.info("Compliance report generated", {
      reportId: reportRecord.id,
      type,
      periodStart,
      periodEnd,
      emailSent,
      recipients: emailedTo,
    });

    return { reportId: reportRecord.id, sent: emailSent, skipped: false };
  } catch (err) {
    markReportFailed(reportRecord.id, err.message);
    logger.error("Compliance report generation failed", {
      reportId: reportRecord.id,
      type,
      error: err.message,
    });
    throw err;
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Run one pass of the compliance report scheduler.
 * Called periodically by the background interval.
 *
 * @param {Date} [now]
 * @returns {{ generated: number, skipped: number, failed: number }}
 */
export async function runComplianceReportScheduler(now = new Date()) {
  const dueTypes = getReportTypesDue(now);

  if (dueTypes.length === 0) {
    return { generated: 0, skipped: 0, failed: 0 };
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const type of dueTypes) {
    let period;
    if (type === "monthly")   period = previousMonthPeriod(now);
    if (type === "quarterly") period = previousQuarterPeriod(now);
    if (type === "annual")    period = previousYearPeriod(now);

    try {
      const result = await generateComplianceReport(type, period.periodStart, period.periodEnd);
      if (result.skipped) skipped++;
      else generated++;
    } catch {
      failed++;
    }
  }

  return { generated, skipped, failed };
}

/**
 * Start the compliance report background scheduler.
 *
 * @returns {{ stop: () => void }}
 */
export function startComplianceReportScheduler() {
  // Check every hour by default (reports only run on day 1 of periods)
  const intervalMs = parseInt(process.env.COMPLIANCE_REPORT_CHECK_INTERVAL_MS ?? "3600000", 10);

  const timer = setInterval(async () => {
    try {
      const result = await runComplianceReportScheduler();
      if (result.generated > 0 || result.failed > 0) {
        logger.info("Compliance report scheduler run completed", result);
      }
    } catch (err) {
      logger.error("Compliance report scheduler error", { error: err.message });
    }
  }, intervalMs);

  timer.unref();
  logger.info("Compliance report scheduler started", { intervalMs });

  return { stop: () => clearInterval(timer) };
}
