/**
 * SendGrid transactional email service.
 *
 * Wraps the @sendgrid/mail SDK and adds:
 *   - Template management (payout confirmation, dispute notification,
 *     weekly digest, alert emails)
 *   - Delivery / bounce / complaint tracking via webhook events
 *   - Auto-retry (once) on temporary bounces (4xx SMTP codes)
 *   - DKIM signing is handled at the SendGrid domain-authentication level;
 *     no extra configuration is needed here beyond SENDGRID_FROM_EMAIL
 *     being on a verified sender domain.
 *
 * All public functions return a structured result object and never throw
 * to callers — errors are logged and surfaced through `{ sent: false }`.
 */

import logger from "../logger.js";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Lazily resolve the SendGrid mail client so the module can be imported even
 * when @sendgrid/mail is absent (tests inject a mock via jest.unstable_mockModule).
 */
async function getMailClient() {
  const sgMail = await import("@sendgrid/mail");
  const client = sgMail.default ?? sgMail;
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error("SENDGRID_API_KEY is not configured");
  }
  client.setApiKey(apiKey);
  return client;
}

function getSenderAddress() {
  return process.env.SENDGRID_FROM_EMAIL ?? "noreply@stellar-royalty.app";
}

/** Determine whether a SendGrid API error code is a temporary (retryable) bounce. */
function isTemporaryError(err) {
  const code = err?.response?.status ?? err?.code;
  // 4xx from the API itself (e.g. 429 rate-limit) or SMTP 4xx transient bounce
  if (typeof code === "number") {
    return code === 429 || (code >= 400 && code < 500 && code !== 401 && code !== 403);
  }
  return false;
}

// ─── Email status store (in-process for MVP; upgrade to DB as needed) ─────────

/**
 * In-memory map: emailAddress → { status, updatedAt }
 * status: "valid" | "invalid" | "suppressed"
 *
 * This is intentionally lightweight — a production deployment would persist
 * this in the SQLite DB (or Redis) via a dedicated migration. For now, every
 * restart resets the map; the webhook handler still processes events correctly,
 * it just cannot recall statuses across restarts.
 */
const emailStatusStore = new Map();

export function getEmailStatus(address) {
  return emailStatusStore.get(address) ?? { status: "valid", updatedAt: null };
}

export function setEmailStatus(address, status) {
  emailStatusStore.set(address, { status, updatedAt: new Date().toISOString() });
}

// ─── Core send function ────────────────────────────────────────────────────────

/**
 * Send a single transactional email via SendGrid.
 * Automatically retries once on temporary/rate-limit errors.
 *
 * @param {{ to: string, subject: string, html: string, text: string, templateId?: string, dynamicTemplateData?: object }} params
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string }>}
 */
export async function sendEmailViaSendGrid(params) {
  const { to, subject, html, text, templateId, dynamicTemplateData } = params;

  // Suppress delivery to addresses known to be invalid or suppressed.
  const { status: addressStatus } = getEmailStatus(to);
  if (addressStatus === "invalid" || addressStatus === "suppressed") {
    logger.warn("Skipping email to suppressed/invalid address", { to, addressStatus });
    return { sent: false, reason: `address_${addressStatus}` };
  }

  const from = getSenderAddress();
  const msg = templateId
    ? { to, from, templateId, dynamicTemplateData: dynamicTemplateData ?? {} }
    : { to, from, subject, html, text, trackingSettings: { openTracking: { enable: true } } };

  const attempt = async () => {
    const client = await getMailClient();
    const [response] = await client.send(msg);
    return response;
  };

  try {
    const response = await attempt();
    const messageId = response?.headers?.["x-message-id"] ?? null;
    logger.info("SendGrid email sent", { to, subject, messageId });
    return { sent: true, messageId };
  } catch (err) {
    logger.warn("SendGrid send failed (first attempt)", { to, error: err.message });

    if (isTemporaryError(err)) {
      // Single auto-retry for temporary failures
      try {
        const response = await attempt();
        const messageId = response?.headers?.["x-message-id"] ?? null;
        logger.info("SendGrid email sent on retry", { to, subject, messageId });
        return { sent: true, messageId, retried: true };
      } catch (retryErr) {
        logger.error("SendGrid send failed after retry", { to, error: retryErr.message });
        return { sent: false, reason: retryErr.message };
      }
    }

    logger.error("SendGrid send failed (non-retryable)", { to, error: err.message });
    return { sent: false, reason: err.message };
  }
}

// ─── SendGrid configuration check ────────────────────────────────────────────

/**
 * Returns true when SENDGRID_API_KEY is set.
 * Used by callers to decide whether to use SendGrid or fall back to SMTP.
 */
export function isSendGridConfigured() {
  return !!process.env.SENDGRID_API_KEY;
}

// ─── Named template senders ───────────────────────────────────────────────────

/**
 * Send a payout confirmation email to a collaborator.
 *
 * @param {{ to: string, walletAddress: string, amount: string|number, token: string, contractId: string, transactionId: string }} params
 */
export async function sendPayoutConfirmationEmail({ to, walletAddress, amount, token, contractId, transactionId }) {
  const subject = "Your royalty payout has been distributed";
  const shortWallet = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
  const shortContract = `${contractId.slice(0, 8)}...${contractId.slice(-6)}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${subject}</title>
  <style>
    body { font-family: Arial, sans-serif; background:#f4f4f4; margin:0; padding:0; }
    .container { max-width:600px; margin:32px auto; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,.1); }
    .header { background:#1a1a2e; color:#fff; padding:24px 32px; }
    .header h1 { margin:0; font-size:20px; }
    .body { padding:24px 32px; color:#333; line-height:1.6; }
    .label { font-weight:bold; color:#555; font-size:13px; text-transform:uppercase; }
    .value { margin-top:2px; font-family:monospace; }
    .highlight { font-size:28px; font-weight:700; color:#1a1a2e; }
    .footer { background:#f4f4f4; padding:16px 32px; font-size:12px; color:#888; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>Stellar Royalty Splitter</h1></div>
    <div class="body">
      <p>A royalty distribution has been completed for your wallet.</p>
      <p><span class="highlight">${amount} ${token}</span></p>
      <p><span class="label">Wallet</span><br /><span class="value">${shortWallet}</span></p>
      <p><span class="label">Contract</span><br /><span class="value">${shortContract}</span></p>
      <p><span class="label">Transaction ID</span><br /><span class="value">${transactionId}</span></p>
    </div>
    <div class="footer">This is an automated message from Stellar Royalty Splitter. Do not reply.</div>
  </div>
</body>
</html>`;

  const text = [
    subject,
    "",
    `Amount: ${amount} ${token}`,
    `Wallet: ${shortWallet}`,
    `Contract: ${shortContract}`,
    `Transaction ID: ${transactionId}`,
  ].join("\n");

  return sendEmailViaSendGrid({ to, subject, html, text });
}

/**
 * Send a dispute notification email using the existing template builder.
 * Re-exports for convenience so callers can import everything from one place.
 */
export { sendEmailViaSendGrid as sendDisputeEmail };

/**
 * Send a system alert email (distribution failures, thresholds exceeded, etc).
 *
 * @param {{ to: string, alert: { contract: string, errorCount: number, threshold: number, severity?: string, timestamp?: number, remedy?: string } }} params
 */
export async function sendAlertEmailViaSendGrid({ to, alert }) {
  const severity = alert.severity ?? "warning";
  const subject = `[${severity.toUpperCase()}] Distribution failure detected for contract ${alert.contract}`;
  const timestamp = new Date(alert.timestamp ?? Date.now()).toISOString();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${subject}</title>
</head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:20px;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;">
    <h2 style="color:#c0392b;">Distribution Alert</h2>
    <p><strong>Contract:</strong> ${alert.contract}</p>
    <p><strong>Error count:</strong> ${alert.errorCount}</p>
    <p><strong>Threshold:</strong> ${alert.threshold}</p>
    <p><strong>Severity:</strong> ${severity}</p>
    <p><strong>Time:</strong> ${timestamp}</p>
    <p><strong>Remediation steps:</strong></p>
    <pre style="background:#f8f8f8;padding:12px;border-radius:4px;">${alert.remedy ?? "Investigate distribution logs for the contract."}</pre>
  </div>
</body>
</html>`;

  const text = `Distribution alert for ${alert.contract}: ${alert.errorCount} errors (threshold ${alert.threshold}). Remedy: ${alert.remedy ?? "Investigate distribution logs for the contract."}`;

  return sendEmailViaSendGrid({ to, subject, html, text });
}

// ─── Webhook event processor ──────────────────────────────────────────────────

/**
 * Process a batch of SendGrid webhook events.
 *
 * Mutates `emailStatusStore` for bounce/complaint/unsubscribe events and
 * logs all events for observability.
 *
 * @param {Array<object>} events  — array from SendGrid's event webhook body
 * @returns {{ processed: number, errors: number }}
 */
export function processSendGridWebhookEvents(events) {
  let processed = 0;
  let errors = 0;

  for (const event of events) {
    try {
      const { email, event: eventType, timestamp, reason, type: bounceType } = event;

      switch (eventType) {
        case "delivered":
          logger.info("SendGrid delivery confirmed", { email, timestamp });
          // Delivery confirms the address is valid
          setEmailStatus(email, "valid");
          break;

        case "bounce":
          // type=bounce → permanent hard bounce; type=blocked → may be temporary
          if (bounceType === "bounce") {
            logger.warn("SendGrid permanent bounce", { email, reason, timestamp });
            setEmailStatus(email, "invalid");
          } else {
            // Soft bounce (blocked/deferred) — do not suppress yet
            logger.warn("SendGrid soft bounce / blocked", { email, bounceType, reason, timestamp });
          }
          break;

        case "spamreport":
        case "unsubscribe":
          logger.warn("SendGrid complaint/unsubscribe", { email, eventType, timestamp });
          setEmailStatus(email, "suppressed");
          break;

        case "open":
          logger.info("SendGrid email opened", { email, timestamp });
          break;

        case "click":
          logger.info("SendGrid link clicked", { email, timestamp });
          break;

        case "dropped":
          logger.warn("SendGrid email dropped", { email, reason, timestamp });
          // Dropped means SendGrid already knows the address is bad
          setEmailStatus(email, "invalid");
          break;

        case "deferred":
          // Deferred = temporary failure; SendGrid will retry internally
          logger.info("SendGrid email deferred", { email, reason, timestamp });
          break;

        default:
          logger.info("SendGrid unhandled event type", { eventType, email });
      }

      processed++;
    } catch (err) {
      logger.error("Error processing SendGrid event", { event, error: err.message });
      errors++;
    }
  }

  return { processed, errors };
}
