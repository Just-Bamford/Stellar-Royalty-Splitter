import { getSubscribersDueForDigest, getEarningsForWeek, wasDigestSentThisWeek, logDigestSent, logDigestFailed } from "../database/email-digest.js";
import { sendEmail, isEmailConfigured } from "../email/email-service.js";
import { renderWeeklyDigestHtml, renderWeeklyDigestText } from "../email/templates/weekly-digest.js";
import logger from "../logger.js";

function getWeekRange(date) {
  const d = new Date(date);
  const dayOfWeek = d.getUTCDay();
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - dayOfWeek);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  return {
    weekStart: start.toISOString().slice(0, 10),
    weekEnd: end.toISOString().slice(0, 10),
  };
}

function formatWeekDate(isoDate) {
  const d = new Date(isoDate + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export async function sendWeeklyDigests() {
  if (!isEmailConfigured()) {
    return { sent: 0, skipped: 0, failed: 0, reason: "smtp_not_configured" };
  }

  const now = new Date();
  const currentDayOfWeek = now.getUTCDay();
  const currentHourOfDay = now.getUTCHours();

  const subscribers = getSubscribersDueForDigest(currentDayOfWeek, currentHourOfDay);

  if (subscribers.length === 0) {
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
  const { weekStart, weekEnd } = getWeekRange(now);
  const weekStartFormatted = formatWeekDate(weekStart);
  const weekEndFormatted = formatWeekDate(weekEnd);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const subscriber of subscribers) {
    try {
      if (wasDigestSentThisWeek(subscriber.id, weekStart, weekEnd)) {
        skipped++;
        continue;
      }

      const earnings = getEarningsForWeek(subscriber.walletAddress, weekStart, weekEnd);

      if (earnings.payoutCount === 0) {
        logDigestSent(subscriber.id, weekStart, weekEnd, earnings);
        skipped++;
        continue;
      }

      const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${subscriber.unsubscribeToken}`;

      const html = renderWeeklyDigestHtml({
        walletAddress: subscriber.walletAddress,
        earnings,
        weekStart: weekStartFormatted,
        weekEnd: weekEndFormatted,
        unsubscribeUrl,
      });

      const text = renderWeeklyDigestText({
        walletAddress: subscriber.walletAddress,
        earnings,
        weekStart: weekStartFormatted,
        weekEnd: weekEndFormatted,
        unsubscribeUrl,
      });

      const result = await sendEmail({
        to: subscriber.email,
        subject: `Weekly Earnings Summary - ${weekStartFormatted} to ${weekEndFormatted}`,
        html,
        text,
      });

      if (result.sent) {
        logDigestSent(subscriber.id, weekStart, weekEnd, earnings);
        sent++;
      } else {
        logDigestFailed(subscriber.id, weekStart, weekEnd, earnings);
        failed++;
      }
    } catch (error) {
      logger.error("Error sending digest to subscriber", {
        subscriberId: subscriber.id,
        walletAddress: subscriber.walletAddress,
        error: error.message,
      });
      logDigestFailed(subscriber.id, weekStart, weekEnd, { totalEarned: 0, payoutCount: 0, contracts: [], topContract: null });
      failed++;
    }
  }

  return { sent, skipped, failed };
}
