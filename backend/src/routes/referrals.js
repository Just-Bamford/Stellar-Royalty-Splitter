/**
 * Contributor referral tracking routes — closes #603.
 *
 * Contributor endpoints (wallet address is the identity — no separate auth):
 *   POST   /api/v1/referrals/link                        — generate (or retrieve) referral link
 *   GET    /api/v1/referrals/link/:walletAddress          — get existing referral link for a wallet
 *   POST   /api/v1/referrals/register                    — register a new contributor via referral code
 *   GET    /api/v1/referrals/dashboard/:walletAddress     — referral dashboard stats for a referrer
 *   GET    /api/v1/referrals/mine/:walletAddress          — list referrals made by a wallet
 *   GET    /api/v1/referrals/status/:walletAddress        — check if this wallet was referred & by whom
 *
 * Admin endpoints (Bearer ADMIN_ROTATE_TOKEN):
 *   POST   /api/v1/referrals/admin/activate              — activate a referral and award bonus
 *   POST   /api/v1/referrals/admin/bonus                 — manually award an extra bonus
 *   GET    /api/v1/referrals/admin/all                   — paginated list of all referrals
 */

import { Router } from "express";
import logger from "../logger.js";
import { validate, parsePagination } from "../validation.js";
import { sendError } from "../error-response.js";
import {
  referralGenerateLinkSchema,
  referralRegisterSchema,
  referralActivateSchema,
  referralAwardBonusSchema,
} from "../validation.js";
import {
  generateReferralLink,
  getReferralLinkByWallet,
  registerReferral,
  activateReferral,
  getReferralByReferred,
  getReferralsByReferrer,
  countReferralsByReferrer,
  awardReferralBonus,
  getReferralDashboard,
  getAllReferrals,
  countAllReferrals,
  DEFAULT_REFERRAL_BONUS_STROOPS,
} from "../database/referrals.js";

export const referralsRouter = Router();

// ─── Admin auth middleware ────────────────────────────────────────────────────

function requireAdminToken(req, res, next) {
  const envToken = process.env.ADMIN_ROTATE_TOKEN;
  if (!envToken) {
    return sendError(
      res,
      503,
      "service_unavailable",
      "Admin operations are not configured on this server"
    );
  }
  const header = req.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (!token || token !== envToken) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function validateWalletParam(walletAddress, res) {
  if (!walletAddress || !STELLAR_ADDRESS_RE.test(walletAddress)) {
    sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
    return false;
  }
  return true;
}

/**
 * Translate db-layer structured errors into HTTP responses.
 * Returns true if the error was handled (caller should return), false otherwise.
 */
function handleDbError(err, res, next) {
  if (err.status && err.code) {
    sendError(res, err.status, err.code, err.message, err.data ? { data: err.data } : undefined);
    return true;
  }
  next(err);
  return true;
}

// ─── Contributor: generate (or retrieve) a referral link ─────────────────────

/**
 * POST /api/v1/referrals/link
 * Body: { walletAddress }
 *
 * Idempotent — returns the existing code if the wallet already has one.
 * Response includes a ready-to-share `referralUrl` built from FRONTEND_ORIGIN.
 */
referralsRouter.post("/link", validate(referralGenerateLinkSchema), (req, res, next) => {
  try {
    const { walletAddress } = req.body;
    const record = generateReferralLink(walletAddress);

    const baseUrl = process.env.FRONTEND_ORIGIN ?? "";
    const referralUrl = baseUrl
      ? `${baseUrl}/join?ref=${record.referralCode}`
      : `/join?ref=${record.referralCode}`;

    logger.info("Referral link generated", { walletAddress, referralCode: record.referralCode });

    return res.status(201).json({
      success: true,
      data: { ...record, referralUrl },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Contributor: retrieve an existing referral link ─────────────────────────

/**
 * GET /api/v1/referrals/link/:walletAddress
 */
referralsRouter.get("/link/:walletAddress", (req, res, next) => {
  try {
    const { walletAddress } = req.params;
    if (!validateWalletParam(walletAddress, res)) return;

    const record = getReferralLinkByWallet(walletAddress);
    if (!record) {
      return sendError(
        res,
        404,
        "referral_link_not_found",
        "No referral link found for this wallet. Use POST /referrals/link to generate one."
      );
    }

    const baseUrl = process.env.FRONTEND_ORIGIN ?? "";
    const referralUrl = baseUrl
      ? `${baseUrl}/join?ref=${record.referralCode}`
      : `/join?ref=${record.referralCode}`;

    return res.json({ success: true, data: { ...record, referralUrl } });
  } catch (err) {
    next(err);
  }
});

// ─── Contributor: register via referral code ──────────────────────────────────

/**
 * POST /api/v1/referrals/register
 * Body: { referralCode, referredAddress }
 *
 * Records the referral in `pending` status. The referrer is identified via the
 * code; no token is required from the referring wallet.
 */
referralsRouter.post("/register", validate(referralRegisterSchema), (req, res, next) => {
  try {
    const { referralCode, referredAddress } = req.body;
    const referral = registerReferral({ referralCode, referredAddress });

    logger.info("Referral registered", {
      referrerAddress: referral.referrerAddress,
      referredAddress,
      referralCode,
    });

    return res.status(201).json({ success: true, data: referral });
  } catch (err) {
    if (handleDbError(err, res, next)) return;
  }
});

// ─── Contributor: referral dashboard ─────────────────────────────────────────

/**
 * GET /api/v1/referrals/dashboard/:walletAddress
 *
 * Returns aggregated stats: referral counts by status, total bonus earned,
 * the referral code/link, and a paginated list of referrals.
 */
referralsRouter.get("/dashboard/:walletAddress", (req, res, next) => {
  try {
    const { walletAddress } = req.params;
    if (!validateWalletParam(walletAddress, res)) return;

    const pagination = parsePagination(req.query, res);
    if (!pagination) return;

    const dashboard = getReferralDashboard(walletAddress, pagination);

    const baseUrl = process.env.FRONTEND_ORIGIN ?? "";
    const referralUrl =
      dashboard.referralCode
        ? baseUrl
          ? `${baseUrl}/join?ref=${dashboard.referralCode}`
          : `/join?ref=${dashboard.referralCode}`
        : null;

    return res.json({
      success: true,
      data: {
        ...dashboard,
        referralUrl,
        defaultBonusStroops: DEFAULT_REFERRAL_BONUS_STROOPS,
        defaultBonusXlm: (DEFAULT_REFERRAL_BONUS_STROOPS / 10_000_000).toFixed(7),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Contributor: list my referrals ──────────────────────────────────────────

/**
 * GET /api/v1/referrals/mine/:walletAddress
 */
referralsRouter.get("/mine/:walletAddress", (req, res, next) => {
  try {
    const { walletAddress } = req.params;
    if (!validateWalletParam(walletAddress, res)) return;

    const pagination = parsePagination(req.query, res);
    if (!pagination) return;

    const items = getReferralsByReferrer(walletAddress, pagination);
    const total = countReferralsByReferrer(walletAddress);

    return res.json({
      success: true,
      data: items,
      pagination: { total, limit: pagination.limit, offset: pagination.offset },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Contributor: check referral status for a wallet ─────────────────────────

/**
 * GET /api/v1/referrals/status/:walletAddress
 *
 * Returns whether this wallet was referred, and if so the referral record.
 * Useful for a "you were referred by X" onboarding message.
 */
referralsRouter.get("/status/:walletAddress", (req, res, next) => {
  try {
    const { walletAddress } = req.params;
    if (!validateWalletParam(walletAddress, res)) return;

    const referral = getReferralByReferred(walletAddress);

    return res.json({
      success: true,
      data: {
        wasReferred: referral !== null,
        referral: referral ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Admin: activate a referral and award the default bonus ──────────────────

/**
 * POST /api/v1/referrals/admin/activate
 * Body: { referredAddress, bonusAmountStroops?, reason? }
 *
 * Marks the referral `active` and writes a bonus record. Idempotent — if the
 * referral is already active no duplicate bonus is awarded.
 */
referralsRouter.post(
  "/admin/activate",
  requireAdminToken,
  validate(referralActivateSchema),
  (req, res, next) => {
    try {
      const { referredAddress, bonusAmountStroops, reason } = req.body;

      const result = activateReferral({ referredAddress, bonusAmountStroops, reason });

      logger.info("Referral activated", {
        referredAddress,
        referrerAddress: result.referral.referrerAddress,
        bonusAwarded: result.bonus !== null,
      });

      return res.json({ success: true, data: result });
    } catch (err) {
      if (handleDbError(err, res, next)) return;
    }
  }
);

// ─── Admin: manually award an extra bonus ────────────────────────────────────

/**
 * POST /api/v1/referrals/admin/bonus
 * Body: { referralId, referrerAddress, bonusAmountStroops, reason }
 */
referralsRouter.post(
  "/admin/bonus",
  requireAdminToken,
  validate(referralAwardBonusSchema),
  (req, res, next) => {
    try {
      const { referralId, referrerAddress, bonusAmountStroops, reason } = req.body;

      const bonus = awardReferralBonus({ referralId, referrerAddress, bonusAmountStroops, reason });

      logger.info("Referral bonus awarded manually", {
        referralId,
        referrerAddress,
        bonusAmountStroops,
      });

      return res.status(201).json({ success: true, data: bonus });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Admin: list all referrals ────────────────────────────────────────────────

/**
 * GET /api/v1/referrals/admin/all
 * Query: status?, limit?, offset?
 */
referralsRouter.get("/admin/all", requireAdminToken, (req, res, next) => {
  try {
    const { status } = req.query;

    const VALID_STATUSES = ["pending", "active", "bonus_paid"];
    if (status && !VALID_STATUSES.includes(status)) {
      return sendError(
        res,
        400,
        "invalid_status",
        `status must be one of: ${VALID_STATUSES.join(", ")}`
      );
    }

    const pagination = parsePagination(req.query, res);
    if (!pagination) return;

    const items = getAllReferrals({ status, ...pagination });
    const total = countAllReferrals({ status });

    return res.json({
      success: true,
      data: items,
      pagination: { total, limit: pagination.limit, offset: pagination.offset },
    });
  } catch (err) {
    next(err);
  }
});
