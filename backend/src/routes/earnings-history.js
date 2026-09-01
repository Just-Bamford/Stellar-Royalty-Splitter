import express from "express";
import logger from "../logger.js";
import { sendError } from "../error-response.js";
import { validateStellarAddress } from "../validation.js";
import {
  getContributorContracts,
  getContributorEarningsEvents,
  getContributorEarningsHistory,
  getContributorPayoutRecords,
} from "../database/analytics.js";

const router = express.Router();

function parseDate(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function escapeCSVField(str) {
  if (str === null || str === undefined) return '""';
  const val = String(str);
  return `"${val.replace(/"/g, '""')}"`;
}

router.get("/earnings-history/:walletAddress/export", (req, res) => {
  const { walletAddress } = req.params;
  const { start, end, contracts, royaltyType } = req.query;

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

    let records = getContributorPayoutRecords(
      walletAddress,
      startDate.toISOString(),
      endDate.toISOString(),
      contractIds
    );

    if (royaltyType && typeof royaltyType === "string") {
      records = records.filter(
        (r) => r.royaltyType?.toLowerCase() === royaltyType.toLowerCase()
      );
    }

    const headers = ["Payout Date", "Transaction ID", "Royalty Type", "Amount"];
    const filename = `royalty-earnings-${walletAddress.substring(0, 8)}.csv`;

    // #766: stream rows instead of buffering the whole CSV in memory so
    // large exports don't hold the full payload as one string. Compression
    // middleware (gzip) applies transparently on top of this stream.
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200);

    res.write(headers.map(escapeCSVField).join(",") + "\n");
    for (const row of records) {
      res.write(
        [
          escapeCSVField(row.payoutDate),
          escapeCSVField(row.transactionId),
          escapeCSVField(row.royaltyType),
          escapeCSVField(row.amount),
        ].join(",") + "\n"
      );
    }
    return res.end();
  } catch (error) {
    logger.error("Earnings export error:", error);
    sendError(res, 500, "export_generation_failed", "Failed to generate earnings export");
  }
});

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

