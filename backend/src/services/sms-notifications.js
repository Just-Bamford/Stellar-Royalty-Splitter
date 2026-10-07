/**
 * SMS notification dispatch — closes #927.
 *
 * Central place that ties together: opt-in/phone-number lookup, template
 * selection, the Twilio wrapper, and delivery-status persistence. Mirrors
 * the "resolve contact info, build template, send, never throw" shape used
 * for the existing email trigger in `src/routes/disputes.js`
 * (`notifyContributor` + `disputeSubmittedEmail`).
 *
 * Call sites (large payout, dispute opened, payment failed) call
 * `sendEventSms(walletAddress, eventType, templateParams)` alongside their
 * existing email send. It is a no-op (does not send) unless the wallet has
 * explicitly opted in with a phone number on file.
 */

import { getSmsPreferences, recordSmsSendAttempt } from "../database/sms-preferences.js";
import { sendSms } from "./twilio-sms.js";
import { SMS_TEMPLATES } from "../sms/templates/event-notifications.js";
import logger from "../logger.js";

/**
 * Send an event SMS to `walletAddress` if — and only if — they have SMS
 * notifications enabled and a phone number on file. Never throws.
 *
 * @param {string} walletAddress
 * @param {"large_payout"|"dispute_opened"|"payment_failed"} eventType
 * @param {object} templateParams  forwarded to the event's SMS template builder
 * @returns {Promise<{ attempted: boolean, sent?: boolean, reason?: string }>}
 */
export async function sendEventSms(walletAddress, eventType, templateParams = {}) {
  const template = SMS_TEMPLATES[eventType];
  if (!template) {
    logger.warn("sendEventSms: unknown event type, skipping", { eventType });
    return { attempted: false, reason: "unknown_event_type" };
  }

  let prefs;
  try {
    prefs = getSmsPreferences(walletAddress);
  } catch (err) {
    logger.error("sendEventSms: failed to load SMS preferences", { walletAddress, error: err.message });
    return { attempted: false, reason: "preferences_lookup_failed" };
  }

  if (!prefs?.smsEnabled || !prefs?.phoneNumber) {
    // Not opted in, or opted in but no phone number on file — silent no-op.
    return { attempted: false, reason: "not_opted_in" };
  }

  const body = template(templateParams);
  const result = await sendSms(prefs.phoneNumber, body);

  try {
    recordSmsSendAttempt({
      walletAddress,
      eventType,
      phoneNumber: prefs.phoneNumber,
      sent: result.sent,
      providerSid: result.sid ?? null,
      failureReason: result.sent ? null : (result.reason ?? null),
    });
  } catch (err) {
    // Delivery tracking is best-effort; never let a logging failure mask
    // the actual send result.
    logger.warn("sendEventSms: failed to record delivery status", { walletAddress, error: err.message });
  }

  return { attempted: true, sent: result.sent, reason: result.reason };
}
