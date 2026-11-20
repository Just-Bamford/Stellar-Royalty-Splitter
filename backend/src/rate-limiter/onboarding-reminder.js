import rateLimit from "express-rate-limit";
import { sendError } from "../error-response.js";
import logger from "../logger.js";

const REMINDER_WINDOW_MS = parseInt(
  process.env.ONBOARDING_REMINDER_RATE_LIMIT_WINDOW_MS ?? String(5 * 60 * 1000),
  10
);

export const onboardingReminderLimiter = rateLimit({
  windowMs: REMINDER_WINDOW_MS,
  max: 1,
  keyGenerator: (req) => `wallet:${req.params.walletAddress}`,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.body?.email,
  handler: (req, res) => {
    logger.warn("Onboarding reminder rate limit exceeded", {
      walletAddress: req.params.walletAddress,
      ip: req.ip,
    });
    res.set("Retry-After", String(Math.ceil(REMINDER_WINDOW_MS / 1000)));
    return sendError(
      res,
      429,
      "too_many_requests",
      "Only one onboarding reminder may be sent every 5 minutes. Please retry later."
    );
  },
});
