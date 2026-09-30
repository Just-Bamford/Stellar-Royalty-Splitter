import { cleanupExpiredSessions } from "../database/index.js";
import logger from "../logger.js";

/**
 * #959: Cleanup expired edit sessions periodically
 * Runs every 5 minutes to remove expired sessions from the database
 */

export function startEditSessionCleanup() {
  const interval = setInterval(
    () => {
      try {
        const cleaned = cleanupExpiredSessions();
        if (cleaned > 0) {
          logger.info("Edit session cleanup completed", { expiredSessions: cleaned });
        }
      } catch (err) {
        logger.error("Edit session cleanup failed", { error: err.message });
      }
    },
    5 * 60 * 1000 // Run every 5 minutes
  );

  interval.unref(); // Don't keep process alive for this interval

  logger.info("Edit session cleanup scheduler started (5-minute interval)");

  return interval;
}
