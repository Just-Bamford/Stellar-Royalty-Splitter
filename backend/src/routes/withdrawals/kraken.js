/**
 * Kraken withdrawal routes.
 */

import express from "express";
import { getOAuthUrl, exchangeCodeForToken, withdrawToKraken } from "../../services/kraken-integration.js";
import logger from "../../logger.js";

const router = express.Router();

router.get("/oauth/url", async (req, res) => {
  try {
    const { redirect_uri } = req.query;
    if (!redirect_uri) {
      return res.status(400).json({ error: "redirect_uri is required" });
    }

    const { authUrl, state } = await getOAuthUrl(redirect_uri);
    res.json({ authUrl, state });
  } catch (error) {
    logger.error("Kraken OAuth URL generation failed", { error: error.message });
    res.status(500).json({ error: "Failed to generate OAuth URL" });
  }
});

router.post("/oauth/callback", async (req, res) => {
  try {
    const { code, redirect_uri } = req.body;
    if (!code || !redirect_uri) {
      return res.status(400).json({ error: "code and redirect_uri are required" });
    }

    const tokenData = await exchangeCodeForToken(code, redirect_uri);
    res.json({ accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token });
  } catch (error) {
    logger.error("Kraken OAuth callback failed", { error: error.message });
    res.status(500).json({ error: "Failed to exchange OAuth code" });
  }
});

router.post("/withdraw", async (req, res) => {
  try {
    const { walletAddress, amount, accessToken } = req.body;
    if (!walletAddress || !amount || !accessToken) {
      return res.status(400).json({ error: "walletAddress, amount, and accessToken are required" });
    }

    const result = await withdrawToKraken(walletAddress, amount, accessToken);
    res.json(result);
  } catch (error) {
    logger.error("Kraken withdrawal failed", { error: error.message });
    res.status(500).json({ error: "Failed to process withdrawal" });
  }
});

export default router;
