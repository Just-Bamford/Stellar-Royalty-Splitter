/**
 * Carbon footprint tracking and offset routes (#1064).
 *
 *   GET    /api/v1/carbon/footprint/:walletAddress  — personal footprint + offsets + daily series
 *   GET    /api/v1/carbon/project/:contractId       — project-wide impact
 *   POST   /api/v1/carbon/record                   — manually record a transaction footprint
 *   POST   /api/v1/carbon/offsets                  — purchase offsets
 *   GET    /api/v1/carbon/offsets/:walletAddress   — offset purchase history
 *   GET    /api/v1/carbon/settings/:walletAddress  — auto-offset settings
 *   POST   /api/v1/carbon/settings/:walletAddress  — save auto-offset settings
 *   GET    /api/v1/carbon/projects                 — forest/ocean project catalog
 *   GET    /api/v1/carbon/share/:walletAddress     — social-media share payload
 */

import { Router } from "express";
import logger from "../logger.js";
import { sendError } from "../error-response.js";
import {
  validate,
  validateContractId,
  validateContractIdMiddleware,
  validateStellarAddress,
  parsePagination,
  carbonRecordSchema,
  carbonOffsetSchema,
  carbonSettingsSchema,
} from "../validation.js";
import {
  OFFSET_PROJECTS,
  getUserFootprint,
  getProjectFootprint,
  recordTransactionFootprint,
  purchaseOffsets,
  getOffsetHistory,
  getAutoOffsetSettings,
  saveAutoOffsetSettings,
  buildSharePayload,
} from "../services/carbon-tracker.js";

export const carbonRouter = Router();

function parseDateRange(req, res) {
  const { start, end } = req.query;
  for (const [name, value] of [
    ["start", start],
    ["end", end],
  ]) {
    if (value !== undefined && Number.isNaN(new Date(value).getTime())) {
      sendError(res, 400, "invalid_date", `${name} must be an ISO 8601 date string`);
      return null;
    }
  }
  if (start && end && new Date(start).getTime() > new Date(end).getTime()) {
    sendError(res, 400, "invalid_date_range", "start date must be before end date");
    return null;
  }
  return { start: start ?? null, end: end ?? null };
}

carbonRouter.get("/carbon/projects", (_req, res) => {
  res.json({ success: true, data: [...OFFSET_PROJECTS] });
});

carbonRouter.get("/carbon/footprint/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;
  if (!validateStellarAddress(walletAddress, res)) return;
  const range = parseDateRange(req, res);
  if (!range) return;

  try {
    res.json({ success: true, data: getUserFootprint(walletAddress, range) });
  } catch (error) {
    logger.error("Error fetching carbon footprint:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch footprint");
  }
});

carbonRouter.get("/carbon/project/:contractId", validateContractIdMiddleware, (req, res) => {
  const { contractId } = req.params;
  if (!validateContractId(contractId, res)) return;
  const range = parseDateRange(req, res);
  if (!range) return;

  try {
    res.json({ success: true, data: getProjectFootprint(contractId, range) });
  } catch (error) {
    logger.error("Error fetching project carbon footprint:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch footprint");
  }
});

carbonRouter.post("/carbon/record", validate(carbonRecordSchema), (req, res, next) => {
  try {
    const result = recordTransactionFootprint(req.body);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

carbonRouter.post("/carbon/offsets", validate(carbonOffsetSchema), (req, res, next) => {
  try {
    const result = purchaseOffsets(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (err?.message?.startsWith("Unsupported offset project") || err?.message?.startsWith("Provide tonnes")) {
      return sendError(res, 400, "invalid_offset_request", err.message);
    }
    next(err);
  }
});

carbonRouter.get("/carbon/offsets/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;
  if (!validateStellarAddress(walletAddress, res)) return;
  const pagination = parsePagination(req.query, res);
  if (!pagination) return;

  try {
    const { data, total } = getOffsetHistory(walletAddress, pagination);
    res.json({ success: true, data, pagination: { total, ...pagination } });
  } catch (error) {
    logger.error("Error listing carbon offsets:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to list offsets");
  }
});

carbonRouter.get("/carbon/settings/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;
  if (!validateStellarAddress(walletAddress, res)) return;

  try {
    res.json({ success: true, data: getAutoOffsetSettings(walletAddress) });
  } catch (error) {
    logger.error("Error fetching carbon settings:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch settings");
  }
});

carbonRouter.post(
  "/carbon/settings/:walletAddress",
  validate(carbonSettingsSchema),
  (req, res, next) => {
    try {
      const { walletAddress } = req.params;
      if (!validateStellarAddress(walletAddress, res)) return;
      const data = saveAutoOffsetSettings(walletAddress, req.body);
      res.json({ success: true, data });
    } catch (err) {
      if (err?.message?.includes("autoOffsetEnabled") || err?.message?.includes("offsetPercentage")) {
        return sendError(res, 400, "invalid_settings", err.message);
      }
      next(err);
    }
  }
);

carbonRouter.get("/carbon/share/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;
  if (!validateStellarAddress(walletAddress, res)) return;

  try {
    res.json({ success: true, data: buildSharePayload(walletAddress) });
  } catch (error) {
    logger.error("Error building carbon share payload:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to build share payload");
  }
});
