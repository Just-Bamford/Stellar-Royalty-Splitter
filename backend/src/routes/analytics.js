import express from "express";
import { getAnalyticsData } from "../database.js";

const router = express.Router();

router.get("/analytics/:contractId", (req, res) => {
  const { contractId } = req.params;
  const { start, end } = req.query;

  try {
    // Parse date range
    const startDate = start
      ? new Date(start)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end) : new Date();

    // Validate parsed dates
    if (start && isNaN(startDate.getTime())) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid start date. Use YYYY-MM-DD." });
    }
    if (end && isNaN(endDate.getTime())) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid end date. Use YYYY-MM-DD." });
    }
    if (start && end && startDate > endDate) {
      return res
        .status(400)
        .json({ success: false, error: "start date must be before end date." });
    }

    const { summary, trends, topEarners, collaboratorStats } = getAnalyticsData(
      contractId,
      startDate.toISOString(),
      endDate.toISOString()
    );

    res.json({
      success: true,
      data: {
        totalDistributed: Math.round((summary.totalDistributed ?? 0) * 100) / 100,
        totalTransactions: summary.totalTransactions ?? 0,
        averagePayout: Math.round((summary.averagePayout ?? 0) * 100) / 100,
        topEarners: topEarners.map((e) => ({
          ...e,
          totalEarned: Math.round(e.totalEarned * 100) / 100,
        })),
        distributionTrends: trends.map((t) => ({
          ...t,
          amount: Math.round(t.amount * 100) / 100,
        })),
        collaboratorStats: collaboratorStats.map((c) => ({
          ...c,
          totalEarned: Math.round(c.totalEarned * 100) / 100,
        })),
      },
    });
  } catch (error) {
    console.error("Analytics error:", error);
    res.status(500).json({ success: false, message: "Failed to load analytics data" });
  }
});

export { router as analyticsRouter };
