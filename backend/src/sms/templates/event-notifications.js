/**
 * SMS templates for time-sensitive notification events — closes #927.
 *
 * Condensed counterparts of the email templates for the same events
 * (see `src/email/templates/dispute-notification.js` for the dispute tone).
 * Kept short on purpose: Twilio/carriers split SMS into ~153-char GSM-7
 * segments, so every template here targets ~300 characters (1-2 segments)
 * including the detail link.
 *
 * Each builder returns a plain string ready to hand to `sendSms(to, body)`.
 */

const DEFAULT_BASE_URL = "https://app.stellar-royalty.app";

function detailsUrl(base, path) {
  return `${base ?? DEFAULT_BASE_URL}${path}`;
}

/**
 * Large payout notification — sent when a distribution to a contributor
 * exceeds the configured large-payout threshold.
 *
 * @param {object} params
 * @param {string} params.amount        formatted amount, e.g. "1,250.0000000 XLM"
 * @param {string} params.contractId
 * @param {string} [params.baseUrl]     override for the details link host
 * @returns {string}
 */
export function largePayoutSms({ amount, contractId, baseUrl }) {
  return (
    `Stellar Royalty Splitter: A payout of ${amount} has been recorded for your contract. ` +
    `Details: ${detailsUrl(baseUrl, `/contracts/${contractId}/history`)}`
  );
}

/**
 * Dispute opened — sent to the contributor right after they submit a dispute.
 * Condensed version of `disputeSubmittedEmail`.
 *
 * @param {object} params
 * @param {string} params.ticketId
 * @param {string} [params.baseUrl]
 * @returns {string}
 */
export function disputeOpenedSms({ ticketId, baseUrl }) {
  return (
    `Stellar Royalty Splitter: Your dispute ticket ${ticketId} was received and is now Open. ` +
    `Track it: ${detailsUrl(baseUrl, `/disputes/${ticketId}`)}`
  );
}

/**
 * Payment failed — sent when a distribution/payment attempt fails.
 *
 * @param {object} params
 * @param {string} params.contractId
 * @param {string} [params.reason]     short failure reason, omitted if not provided
 * @param {string} [params.baseUrl]
 * @returns {string}
 */
export function paymentFailedSms({ contractId, reason, baseUrl }) {
  const reasonPart = reason ? ` (${reason})` : "";
  return (
    `Stellar Royalty Splitter: A payment on your contract failed${reasonPart}. Please review. ` +
    `Details: ${detailsUrl(baseUrl, `/contracts/${contractId}/history`)}`
  );
}

/**
 * Map of event type -> SMS builder, used by the notification dispatch path
 * so callers can trigger by event type without importing each builder.
 */
export const SMS_TEMPLATES = {
  large_payout: largePayoutSms,
  dispute_opened: disputeOpenedSms,
  payment_failed: paymentFailedSms,
};
