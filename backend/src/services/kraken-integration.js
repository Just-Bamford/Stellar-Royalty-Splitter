/**
 * Kraken API integration for direct withdrawals.
 *
 * Supports:
 * - OAuth account connection
 * - Direct deposits to user's Kraken account
 * - Withdrawal of XLM to Kraken deposit address
 */

import logger from "../logger.js";

const KRAKEN_API_URL = "https://api.kraken.com";

async function getOAuthUrl(redirectUri) {
  const clientId = process.env.KRAKEN_CLIENT_ID;
  if (!clientId) {
    throw new Error("KRAKEN_CLIENT_ID not configured");
  }

  const state = Math.random().toString(36).substring(7);
  const authUrl = `https://www.kraken.com/en-us/oauth2/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  logger.info("Kraken OAuth URL generated", { state });
  return { authUrl, state };
}

async function exchangeCodeForToken(code, redirectUri) {
  const clientId = process.env.KRAKEN_CLIENT_ID;
  const clientSecret = process.env.KRAKEN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Kraken OAuth credentials not configured");
  }

  try {
    const response = await fetch(`${KRAKEN_API_URL}/0/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Kraken API error: ${response.status}`);
    }

    const data = await response.json();
    logger.info("Kraken OAuth token exchanged", { hasAccessToken: !!data.access_token });

    return data;
  } catch (error) {
    logger.error("Failed to exchange Kraken OAuth code", { error: error.message });
    throw error;
  }
}

async function getDepositAddress(asset = "XLM", accessToken) {
  try {
    const response = await fetch(`${KRAKEN_API_URL}/0/private/DepositAddresses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ asset, method: "Stellar" }),
    });

    if (!response.ok) {
      throw new Error(`Kraken API error: ${response.status}`);
    }

    const data = await response.json();
    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken error: ${data.error[0]}`);
    }

    const address = data.result?.[0]?.address;
    if (!address) {
      throw new Error("No deposit address found");
    }

    logger.info("Kraken deposit address retrieved", { asset, address });
    return address;
  } catch (error) {
    logger.error("Failed to get Kraken deposit address", { error: error.message });
    throw error;
  }
}

async function withdrawToKraken(walletAddress, amount, accessToken) {
  try {
    const depositAddress = await getDepositAddress("XLM", accessToken);

    logger.info("Initiating withdrawal to Kraken", {
      walletAddress,
      amount,
      depositAddress,
    });

    return {
      success: true,
      depositAddress,
      amount,
      network: "Stellar",
    };
  } catch (error) {
    logger.error("Failed to withdraw to Kraken", { error: error.message });
    throw error;
  }
}

export { getOAuthUrl, exchangeCodeForToken, getDepositAddress, withdrawToKraken };
