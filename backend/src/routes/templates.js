/**
 * Reusable royalty split templates — closes #652
 *
 * GET    /api/v1/templates?walletAddress=G...
 *   List templates owned by the wallet.
 *
 * POST   /api/v1/templates
 *   Body: { walletAddress, name, allocations: [{ address, percentage }] }
 *   Validates allocations (valid addresses, no duplicates, percentages sum
 *   to 100) and saves a new template. Templates are an application-level
 *   convenience only — they never modify an on-chain contract.
 *
 * DELETE /api/v1/templates/:id?walletAddress=G...
 *   Deletes a template owned by the wallet.
 */

import { Router } from "express";
import { z } from "zod";
import { stellarAddress } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";
import { createTemplate, listTemplates, deleteTemplate } from "../database/index.js";

export const templatesRouter = Router();

const MAX_ALLOCATIONS = 20;

const allocationSchema = z.object({
  address: stellarAddress,
  percentage: z.number().min(0).max(100),
});

const createTemplateSchema = z.object({
  walletAddress: stellarAddress,
  name: z.string().trim().min(1, "name is required").max(100),
  allocations: z
    .array(allocationSchema)
    .min(1, "allocations must be non-empty")
    .max(MAX_ALLOCATIONS, `allocations cannot exceed ${MAX_ALLOCATIONS} entries`),
});

/**
 * Shared allocation validation used both when saving and when a client
 * wants to re-validate a template before applying it (#652 AC: "Validate
 * allocations before saving or applying a template").
 */
export function validateAllocations(allocations) {
  const addresses = allocations.map((a) => a.address);
  if (new Set(addresses).size !== addresses.length) {
    return "Duplicate collaborator addresses are not allowed.";
  }

  const total = allocations.reduce((sum, a) => sum + a.percentage, 0);
  if (Math.round(total * 100) !== 10_000) {
    return `Percentages must sum to 100% (got ${total.toFixed(2)}%).`;
  }

  return null;
}

// ─── GET /api/v1/templates ──────────────────────────────────────────────

templatesRouter.get("/", (req, res) => {
  const { walletAddress } = req.query;

  if (!walletAddress || typeof walletAddress !== "string") {
    return sendError(res, 400, "missing_wallet_address", "walletAddress query parameter is required");
  }
  if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
  }

  const templates = listTemplates(walletAddress);
  res.json({ success: true, data: templates });
});

// ─── POST /api/v1/templates ─────────────────────────────────────────────

templatesRouter.post("/", (req, res) => {
  const result = createTemplateSchema.safeParse(req.body);

  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { walletAddress, name, allocations } = result.data;

  const allocationError = validateAllocations(allocations);
  if (allocationError) {
    return sendError(res, 400, "invalid_allocations", allocationError);
  }

  const template = createTemplate(walletAddress, name, allocations);
  res.status(201).json({ success: true, data: template });
});

// ─── DELETE /api/v1/templates/:id ───────────────────────────────────────

templatesRouter.delete("/:id", (req, res) => {
  const { walletAddress } = req.query;
  const id = Number.parseInt(req.params.id, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, "invalid_template_id", "Invalid template id");
  }
  if (!walletAddress || typeof walletAddress !== "string" || !/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
  }

  const deleted = deleteTemplate(id, walletAddress);
  if (!deleted) {
    return sendError(res, 404, "not_found", "Template not found");
  }

  res.json({ success: true });
});
