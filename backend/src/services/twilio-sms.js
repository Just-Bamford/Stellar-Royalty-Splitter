/**
 * Twilio SMS wrapper — closes #927.
 *
 * Thin wrapper around the `twilio` npm package, mirroring the error-handling
 * style of `src/email/email-service.js`: never throws synchronously, always
 * resolves to a result object indicating success/failure so callers can
 * persist delivery status without a try/catch at every call site.
 *
 * Configuration (env):
 *   TWILIO_ACCOUNT_SID — Twilio account SID
 *   TWILIO_AUTH_TOKEN  — Twilio auth token
 *   TWILIO_PHONE       — Twilio sender phone number (E.164, e.g. +15551234567)
 */

import twilio from "twilio";
import logger from "../logger.js";

function createClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return null;
  }

  return twilio(accountSid, authToken);
}

/**
 * True when Twilio credentials + sender number are present in the environment.
 */
export function isSmsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE);
}

/**
 * Send an SMS via Twilio. Never throws — resolves to a result object.
 *
 * @param {string} to    E.164 destination phone number, e.g. "+15551234567"
 * @param {string} body  Message text
 * @returns {Promise<{ sent: boolean, sid?: string, status?: string, reason?: string }>}
 */
export async function sendSms(to, body) {
  const client = createClient();
  const from = process.env.TWILIO_PHONE;

  if (!client || !from) {
    logger.warn("SMS transport not available; skipping send to", { to });
    return { sent: false, reason: "twilio_not_configured" };
  }

  if (!to) {
    return { sent: false, reason: "missing_recipient" };
  }

  try {
    const message = await client.messages.create({ to, from, body });
    logger.info("SMS sent successfully", { to, sid: message.sid, status: message.status });
    return { sent: true, sid: message.sid, status: message.status };
  } catch (error) {
    logger.error("Failed to send SMS", { to, error: error.message });
    return { sent: false, reason: error.message };
  }
}
