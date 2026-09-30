/**
 * Compound Finance yield routes.
 */

import express from "express";
import { getCurrentAPY, depositToCompound, withdrawFromCompound, getYieldBalance } from "../../services/compound-integration.js";
import logger from "../../logger.js";

const router = express.Router();

router.get("/apy", async (req, res) => {
  try {
    const apy = await getCurrentAPY();
    res.json({ apy });
  } catch (error) {
    logger.error("Failed to get Compound APY", { error: error.message });
    res.status(500).json({ error: "Failed to get APY" });
  }
});

router.post("/deposit", async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const result = await depositToCompound(amount);
    res.json(result);
  } catch (error) {
    logger.error("Compound deposit failed", { error: error.message });
    res.status(500).json({ error: "Failed to deposit" });
  }
});

router.post("/withdraw", async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const result = await withdrawFromCompound(amount);
    res.json(result);
  } catch (error) {
    logger.error("Compound withdrawal failed", { error: error.message });
    res.status(500).json({ error: "Failed to withdraw" });
  }
});

router.get("/balance", async (req, res) => {
  try {
    const balance = await getYieldBalance();
    res.json(balance);
  } catch (error) {
    logger.error("Failed to get yield balance", { error: error.message });
    res.status(500).json({ error: "Failed to get balance" });
  }
});

export default router;
