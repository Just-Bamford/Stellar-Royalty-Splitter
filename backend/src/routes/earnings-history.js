import express from "express";
import logger from "../logger.js";
import { sendError } from "../error-response.js";
import { validateStellarAddress } from "../validation.js";
import {
  getContributorContracts,
  getContributorEarningsEvents,
  getContributorEarningsHistory,
} from "../database/analytics.js";

const router = express.Router();

function parseDate(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

router.get("/earnings-history/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;
  const { start, end, contracts } = req.query;

  if (!validateStellarAddress(walletAddress, res)) return;

  try {
    const endDate = parseDate(end, new Date());
    const startDate = parseDate(start, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));

    if (!endDate || !startDate) {
      return sendError(res, 400, "invalid_query_parameter", "Invalid date range. Use YYYY-MM-DD.");
    }
    if (startDate > endDate) {
      return sendError(res, 400, "invalid_query_parameter", "start date must be before end date.");
    }

    const contractIds = typeof contracts === "string"
      ? contracts.split(",").map((id) => id.trim()).filter(Boolean)
      : null;

    const snapshots = getContributorEarningsHistory(
      walletAddress,
      startDate.toISOString(),
      endDate.toISOString(),
      contractIds,
    );
    const events = getContributorEarningsEvents(walletAddress);
    const availableContracts = getContributorContracts(walletAddress);

    res.json({
      success: true,
      data: {
        walletAddress,
        snapshots,
        events,
        contracts: availableContracts,
      },
    });
  } catch (error) {
    logger.error("Earnings history error:", error);
    sendError(res, 500, "earnings_history_failed", "Failed to load earnings history");
  }
});

export { router as earningsHistoryRouter };
