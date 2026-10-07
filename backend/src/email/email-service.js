/**
 * Unified email service.
 *
 * Sends via SendGrid when SENDGRID_API_KEY is configured; falls back to
 * the existing nodemailer/SMTP path otherwise.  Callers require no changes
 * — the same sendEmail / sendAlertEmail / verifyConnection API is preserved.
 *
 * SendGrid-specific functionality (template management, webhook processing,
 * named senders for payout/dispute/alert emails) lives in
 * src/services/sendgrid.js and is re-exported here for convenience.
 */

import nodemailer from "nodemailer";
import logger from "../logger.js";
import {
  isSendGridConfigured,
  sendEmailViaSendGrid,
  sendAlertEmailViaSendGrid,
} from "../services/sendgrid.js";

// ─── SMTP path (unchanged from original) ──────────────────────────────────────

function createTransporter() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT ?? "587", 10);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost) {
    return null;
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
}

async function sendEmailViaSMTP({ to, subject, html, text }) {
  const transport = createTransporter();
  if (!transport) {
    logger.warn("Email transport not available; skipping send to", { to });
    return { sent: false, reason: "smtp_not_configured" };
  }

  const from =
    process.env.EMAIL_FROM ?? "Stellar Royalty Splitter <noreply@stellar-royalty.app>";

  try {
    const info = await transport.sendMail({ from, to, subject, html, text });
    logger.info("Email sent successfully via SMTP", { to, messageId: info.messageId });
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    logger.error("Failed to send email via SMTP", { to, error: error.message });
    return { sent: false, reason: error.message };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if any email transport is configured
 * (SendGrid API key OR SMTP host).
 */
export function isEmailConfigured() {
  return isSendGridConfigured() || !!process.env.SMTP_HOST;
}

/**
 * Returns true specifically when SendGrid is the active transport.
 */
export { isSendGridConfigured };

/**
 * Send a transactional email.
 * Uses SendGrid when SENDGRID_API_KEY is set, otherwise falls back to SMTP.
 *
 * @param {{ to: string, subject: string, html: string, text: string }} params
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string }>}
 */
export async function sendEmail({ to, subject, html, text }) {
  if (isSendGridConfigured()) {
    return sendEmailViaSendGrid({ to, subject, html, text });
  }
  return sendEmailViaSMTP({ to, subject, html, text });
}

/**
 * Send a system alert email.
 * Uses SendGrid when configured, otherwise SMTP.
 *
 * @param {{ to: string, alert: object }} params
 */
export async function sendAlertEmail({ to, alert }) {
  if (isSendGridConfigured()) {
    return sendAlertEmailViaSendGrid({ to, alert });
  }

  // SMTP path (original implementation preserved)
  const severity = alert.severity ?? "warning";
  const subject = `[${severity.toUpperCase()}] Distribution failure detected for contract ${alert.contract}`;
  const timestamp = new Date(alert.timestamp ?? Date.now()).toISOString();
  const html = `
  "<h2>Distribution Alert</h2>"
  "<p><strong>Contract:</strong> ${alert.contract}</p>"
  "<p><strong>Error count:</strong> ${alert.errorCount}</p>"
  "<p><strong>Threshold:</strong> ${alert.threshold}</p>"
  "<p><strong>Severity:</strong> ${severity}</p>"
  "<p><strong>Time:</strong> ${timestamp}</p>"
  "<p><strong>Remediation steps:</strong></p>"
  "<pre>${alert.remedy ?? "Investigate distribution logs for the contract."}</pre>"

`;
  const text = `Distribution alert for ${alert.contract}: ${alert.errorCount} errors (threshold ${alert.threshold}). Remedy: ${alert.remedy ?? "Investigate distribution logs for the contract."}`;
  return sendEmailViaSMTP({ to, subject, html, text });
}

/**
 * Verify that the configured email transport is working.
 * For SendGrid: checks that SENDGRID_API_KEY is non-empty (no live call).
 * For SMTP: uses nodemailer's transport.verify().
 */
export async function verifyConnection() {
  if (isSendGridConfigured()) {
    logger.info("SendGrid is configured as the email transport");
    return true;
  }

  const transport = createTransporter();
  if (!transport) return false;

  try {
    await transport.verify();
    logger.info("SMTP connection verified successfully");
    return true;
  } catch (error) {
    logger.error("SMTP connection verification failed", { error: error.message });
    return false;
  }
}
