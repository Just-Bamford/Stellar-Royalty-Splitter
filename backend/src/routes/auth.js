import express from "express";
import rateLimit from "express-rate-limit";
import logger from "../logger.js";
import { sendError } from "../error-response.js";
import { validateStellarAddress } from "../validation.js";
import {
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  consumeBackupCode,
  createVerifiedSession,
  decryptTwoFactorSecret,
  disableTwoFactor,
  getTwoFactorStatus,
  isSessionValid,
  revokeSessions,
} from "../database/two-factor.js";
import {
  buildOtpAuthUri,
  generateBackupCodes,
  generateTotpSecret,
  isExpiredTotp,
  verifyTotp,
} from "../services/totp.js";

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_2FA_MAX ?? "10", 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendError(res, 429, "too_many_requests", "Too many 2FA attempts. Try again shortly.");
  },
});

function requireWallet(req, res) {
  const walletAddress = req.body?.walletAddress ?? req.params?.walletAddress;
  if (!validateStellarAddress(walletAddress, res)) return null;
  return walletAddress;
}

router.get("/2fa/status/:walletAddress", (req, res) => {
  const walletAddress = requireWallet(req, res);
  if (!walletAddress) return;

  try {
    const status = getTwoFactorStatus(walletAddress);
    const sessionToken = req.headers["x-2fa-session"];
    res.json({
      success: true,
      data: {
        ...status,
        sessionVerified: status.enabled
          ? isSessionValid(walletAddress, sessionToken)
          : true,
      },
    });
  } catch (error) {
    logger.error("2FA status error", error);
    sendError(res, 500, "two_factor_status_failed", "Failed to load 2FA status");
  }
});

/**
 * Start enrollment: returns otpauth URI + one-time backup codes.
 * Secret is stored encrypted; 2FA remains disabled until confirm.
 */
router.post("/2fa/setup", (req, res) => {
  const walletAddress = requireWallet(req, res);
  if (!walletAddress) return;

  try {
    const secret = generateTotpSecret();
    const backupCodes = generateBackupCodes(10);
    beginTwoFactorSetup(walletAddress, secret, backupCodes);

    const otpauthUrl = buildOtpAuthUri({
      secret,
      accountName: walletAddress,
    });

    res.status(201).json({
      success: true,
      data: {
        secret,
        otpauthUrl,
        backupCodes,
        message:
          "Scan the QR code with Google Authenticator or Authy, then confirm with a 6-digit code.",
      },
    });
  } catch (error) {
    if (error.status) {
      return sendError(res, error.status, error.code, error.message);
    }
    logger.error("2FA setup error", error);
    sendError(res, 500, "two_factor_setup_failed", "Failed to start 2FA setup");
  }
});

router.post("/2fa/confirm", verifyLimiter, (req, res) => {
  const walletAddress = requireWallet(req, res);
  if (!walletAddress) return;

  const { code } = req.body ?? {};
  try {
    const secret = decryptTwoFactorSecret(walletAddress);
    if (!secret) {
      return sendError(res, 404, "two_factor_not_found", "2FA setup not started");
    }

    if (!verifyTotp({ secret, token: code })) {
      return sendError(res, 401, "invalid_totp", "Invalid authentication code");
    }

    confirmTwoFactorSetup(walletAddress);
    const session = createVerifiedSession(walletAddress);

    res.json({
      success: true,
      data: {
        enabled: true,
        sessionToken: session.token,
        expiresAt: session.expiresAt,
      },
    });
  } catch (error) {
    if (error.status) {
      return sendError(res, error.status, error.code, error.message);
    }
    logger.error("2FA confirm error", error);
    sendError(res, 500, "two_factor_confirm_failed", "Failed to confirm 2FA");
  }
});

/**
 * Login challenge — required when admin 2FA is enabled.
 */
router.post("/2fa/verify", verifyLimiter, (req, res) => {
  const walletAddress = requireWallet(req, res);
  if (!walletAddress) return;

  const { code, atMs } = req.body ?? {};
  try {
    const status = getTwoFactorStatus(walletAddress);
    if (!status.enabled) {
      return sendError(res, 400, "two_factor_not_enabled", "2FA is not enabled for this account");
    }

    const secret = decryptTwoFactorSecret(walletAddress);
    const now = typeof atMs === "number" ? atMs : Date.now();

    if (isExpiredTotp({ secret, token: code, atMs: now })) {
      return sendError(res, 401, "expired_totp", "Authentication code has expired");
    }

    if (!verifyTotp({ secret, token: code, atMs: now })) {
      return sendError(res, 401, "invalid_totp", "Invalid authentication code");
    }

    const session = createVerifiedSession(walletAddress);
    res.json({
      success: true,
      data: {
        verified: true,
        sessionToken: session.token,
        expiresAt: session.expiresAt,
      },
    });
  } catch (error) {
    logger.error("2FA verify error", error);
    sendError(res, 500, "two_factor_verify_failed", "Failed to verify 2FA code");
  }
});

router.post("/2fa/recover", verifyLimiter, (req, res) => {
  const walletAddress = requireWallet(req, res);
  if (!walletAddress) return;

  const { backupCode } = req.body ?? {};
  try {
    const status = getTwoFactorStatus(walletAddress);
    if (!status.enabled) {
      return sendError(res, 400, "two_factor_not_enabled", "2FA is not enabled for this account");
    }

    if (!consumeBackupCode(walletAddress, backupCode)) {
      return sendError(res, 401, "invalid_backup_code", "Invalid or already used backup code");
    }

    const session = createVerifiedSession(walletAddress);
    res.json({
      success: true,
      data: {
        recovered: true,
        sessionToken: session.token,
        expiresAt: session.expiresAt,
        message: "Backup code accepted. This code cannot be reused.",
      },
    });
  } catch (error) {
    logger.error("2FA recover error", error);
    sendError(res, 500, "two_factor_recover_failed", "Failed to recover with backup code");
  }
});

router.post("/2fa/disable", verifyLimiter, (req, res) => {
  const walletAddress = requireWallet(req, res);
  if (!walletAddress) return;

  const { code, backupCode } = req.body ?? {};
  try {
    const status = getTwoFactorStatus(walletAddress);
    if (!status.enabled && !status.pending) {
      return sendError(res, 404, "two_factor_not_found", "2FA is not configured");
    }

    let authorized = false;
    if (status.enabled) {
      const secret = decryptTwoFactorSecret(walletAddress);
      if (code && verifyTotp({ secret, token: code })) {
        authorized = true;
      } else if (backupCode && consumeBackupCode(walletAddress, backupCode)) {
        authorized = true;
      }
    } else {
      // Allow cancelling an incomplete enrollment without a code.
      authorized = true;
    }

    if (!authorized) {
      return sendError(res, 401, "invalid_totp", "Provide a valid TOTP or backup code to disable 2FA");
    }

    disableTwoFactor(walletAddress);
    revokeSessions(walletAddress);

    res.json({
      success: true,
      data: { enabled: false },
    });
  } catch (error) {
    logger.error("2FA disable error", error);
    sendError(res, 500, "two_factor_disable_failed", "Failed to disable 2FA");
  }
});

export { router as authRouter };
