import express from "express";
import { getDatabase } from "./database.js";

const router = express.Router();

router.get("/analytics/:contractId", (req, res) => {
  const { contractId } = req.params;
  const { start, end } = req.query;

  try {
    const db = getDatabase();

    // Parse date range
    let startDate = start ? new Date(start) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    let endDate = end ? new Date(end) : new Date();

    // Get all transactions for the contract in the date range
    const transactions = db
      .prepare(
        `SELECT * FROM transactions 
         WHERE contractId = ? AND status = 'confirmed' AND timestamp BETWEEN ? AND ?
         ORDER BY timestamp ASC`
      )
      .all(contractId, startDate.toISOString(), endDate.toISOString());

    // Get all payouts for the contract
    const payouts = db
      .prepare(
        `SELECT * FROM distribution_payouts 
         WHERE contractId = ? AND timestamp BETWEEN ? AND ?
         ORDER BY timestamp ASC`
      )
      .all(contractId, startDate.toISOString(), endDate.toISOString());

    // Calculate total distributed
    const totalDistributed = payouts.reduce((sum, payout) => {
      return sum + parseFloat(payout.amount);
    }, 0);

    // Calculate average payout
    const averagePayout =
      payouts.length > 0 ? totalDistributed / payouts.length : 0;

    // Calculate distribution trends (daily aggregates)
    const trendsMap = new Map();

    payouts.forEach((payout) => {
      const date = new Date(payout.timestamp).toISOString().split("T")[0];
      const current = trendsMap.get(date) || { amount: 0, count: 0 };
      current.amount += parseFloat(payout.amount);
      current.count += 1;
      trendsMap.set(date, current);
    });

    const distributionTrends = Array.from(trendsMap.entries())
      .map(([date, data]) => ({
        date,
        amount: Math.round(data.amount * 100) / 100,
        count: data.count,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Calculate top earners
    const earnerMap = new Map();

    payouts.forEach((payout) => {
      const address = payout.collaboratorAddress;
      const current = earnerMap.get(address) || {
        totalEarned: 0,
        payouts: 0,
      };
      current.totalEarned += parseFloat(payout.amount);
      current.payouts += 1;
      earnerMap.set(address, current);
    });

    const topEarners = Array.from(earnerMap.entries())
      .map(([address, data]) => ({
        address,
        totalEarned: Math.round(data.totalEarned * 100) / 100,
        payouts: data.payouts,
      }))
      .sort((a, b) => b.totalEarned - a.totalEarned)
      .slice(0, 10);

    // Calculate collaborator stats
    const collaboratorStats = Array.from(earnerMap.entries())
      .map(([address, data]) => ({
        address,
        totalEarned: Math.round(data.totalEarned * 100) / 100,
        payoutCount: data.payouts,
      }))
      .sort((a, b) => b.totalEarned - a.totalEarned);

    res.json({
      success: true,
      data: {
        totalDistributed: Math.round(totalDistributed * 100) / 100,
        totalTransactions: transactions.length,
        averagePayout: Math.round(averagePayout * 100) / 100,
        topEarners,
        distributionTrends,
        collaboratorStats,
      },
    });
  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export { router as analyticsRouter };
