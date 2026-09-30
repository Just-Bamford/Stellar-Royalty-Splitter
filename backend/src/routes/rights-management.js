/**
 * Rights Management Express API Routes
 * 
 * Endpoints for managing collaborator rights types, ownership percentages, license terms,
 * DDEX/ISO 20022 metadata standards, ownership verification proofs, historical logs, and disputes.
 */

import { Router } from "express";
import {
  validate,
  createRightSchema,
  updateRightSchema,
  setRightsMetadataSchema,
  submitProofSchema,
  verifyOwnershipSchema,
  linkRightDisputeSchema,
  validateContractId,
} from "../validation.js";

import {
  createRight,
  getRightDetails,
  getRightsByContract,
  getRightsByOwner,
  updateRight,
  deleteRight,
  setRightMetadata,
  submitVerificationProof,
  verifyOwnership,
  verifyContractDistributionEligibility,
  linkRightToDispute,
  getRightsForDispute,
  getRightsHistory,
} from "../services/rights-management.js";

import { sendError } from "../error-response.js";
import logger from "../logger.js";

export const rightsRouter = Router();

/**
 * POST /api/v1/rights
 * Create a new rights allocation record
 */
rightsRouter.post("/", validate(createRightSchema), (req, res, next) => {
  try {
    const createdBy = req.headers["x-wallet-address"] || "system";
    const right = createRight({
      ...req.body,
      createdBy,
    });
    res.status(201).json(right);
  } catch (err) {
    if (err.message.includes("Total percentage") || err.message.includes("Invalid")) {
      return sendError(res, 400, "invalid_rights_data", err.message);
    }
    next(err);
  }
});

/**
 * GET /api/v1/rights/contract/:contractId
 * Get all rights for a contract with summary breakdown
 */
rightsRouter.get("/contract/:contractId", (req, res, next) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId)) {
      return sendError(res, 400, "invalid_contract_id", "Invalid contract ID format");
    }
    const result = getRightsByContract(contractId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/rights/contract/:contractId/eligibility
 * Check if all rights for contract are verified and allocations total 100%
 */
rightsRouter.get("/contract/:contractId/eligibility", (req, res, next) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId)) {
      return sendError(res, 400, "invalid_contract_id", "Invalid contract ID format");
    }
    const eligibility = verifyContractDistributionEligibility(contractId);
    res.json(eligibility);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/rights/owner/:ownerAddress
 * Get all rights owned by a specific wallet address
 */
rightsRouter.get("/owner/:ownerAddress", (req, res, next) => {
  try {
    const { ownerAddress } = req.params;
    const rights = getRightsByOwner(ownerAddress);
    res.json({ ownerAddress, count: rights.length, rights });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/rights/dispute/:ticketId
 * Get rights associated with a dispute ticket ID
 */
rightsRouter.get("/dispute/:ticketId", (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const rights = getRightsForDispute(ticketId);
    res.json({ ticketId, count: rights.length, rights });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/rights/:id
 * Get full details for a single right record
 */
rightsRouter.get("/:id", (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 400, "invalid_id", "ID must be an integer");
    }
    const details = getRightDetails(id);
    if (!details) {
      return sendError(res, 404, "right_not_found", `Right with ID ${id} not found`);
    }
    res.json(details);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/v1/rights/:id
 * Update an existing right
 */
rightsRouter.patch("/:id", validate(updateRightSchema), (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 400, "invalid_id", "ID must be an integer");
    }
    const changedBy = req.headers["x-wallet-address"] || "system";
    const updated = updateRight(id, req.body, changedBy);
    res.json(updated);
  } catch (err) {
    if (err.message.includes("not found")) {
      return sendError(res, 404, "right_not_found", err.message);
    }
    if (err.message.includes("Total percentage") || err.message.includes("Invalid")) {
      return sendError(res, 400, "invalid_rights_data", err.message);
    }
    next(err);
  }
});

/**
 * DELETE /api/v1/rights/:id
 * Delete a right allocation
 */
rightsRouter.delete("/:id", (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 400, "invalid_id", "ID must be an integer");
    }
    const changedBy = req.headers["x-wallet-address"] || "system";
    deleteRight(id, changedBy);
    res.json({ success: true, message: `Right ${id} deleted` });
  } catch (err) {
    if (err.message.includes("not found")) {
      return sendError(res, 404, "right_not_found", err.message);
    }
    next(err);
  }
});

/**
 * POST /api/v1/rights/:id/metadata
 * Set or update DDEX, ISO 20022, or custom metadata
 */
rightsRouter.post("/:id/metadata", validate(setRightsMetadataSchema), (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 400, "invalid_id", "ID must be an integer");
    }
    const updatedBy = req.headers["x-wallet-address"] || "system";
    const metadata = setRightMetadata(id, req.body, updatedBy);
    res.json(metadata);
  } catch (err) {
    if (err.message.includes("not found")) {
      return sendError(res, 404, "right_not_found", err.message);
    }
    if (err.message.includes("validation error")) {
      return sendError(res, 400, "invalid_metadata", err.message);
    }
    next(err);
  }
});

/**
 * GET /api/v1/rights/:id/metadata
 * Get metadata for a right
 */
rightsRouter.get("/:id/metadata", (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 400, "invalid_id", "ID must be an integer");
    }
    const details = getRightDetails(id);
    if (!details) {
      return sendError(res, 404, "right_not_found", `Right with ID ${id} not found`);
    }
    res.json(details.metadata || { rightId: id, ddex: null, iso20022: null, customFields: null });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/rights/:id/proof
 * Upload / submit proof document for ownership verification
 */
rightsRouter.post("/:id/proof", validate(submitProofSchema), (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 400, "invalid_id", "ID must be an integer");
    }
    const proof = submitVerificationProof(id, req.body);
    res.status(201).json(proof);
  } catch (err) {
    if (err.message.includes("not found")) {
      return sendError(res, 404, "right_not_found", err.message);
    }
    if (err.message.includes("Invalid") || err.message.includes("required")) {
      return sendError(res, 400, "invalid_proof_data", err.message);
    }
    next(err);
  }
});

/**
 * POST /api/v1/rights/:id/verify
 * Approve or reject ownership verification
 */
rightsRouter.post("/:id/verify", validate(verifyOwnershipSchema), (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 400, "invalid_id", "ID must be an integer");
    }
    const verifierAddress = req.headers["x-wallet-address"] || req.body.verifierAddress || "admin";
    const result = verifyOwnership(id, {
      ...req.body,
      verifierAddress,
    });
    res.json(result);
  } catch (err) {
    if (err.message.includes("not found")) {
      return sendError(res, 404, "right_not_found", err.message);
    }
    next(err);
  }
});

/**
 * GET /api/v1/rights/:id/history
 * Get audit history log for a right
 */
rightsRouter.get("/:id/history", (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 400, "invalid_id", "ID must be an integer");
    }
    const right = getRightDetails(id);
    if (!right) {
      return sendError(res, 404, "right_not_found", `Right with ID ${id} not found`);
    }
    const history = getRightsHistory(right.contractId, id);
    res.json({ rightId: id, history });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/rights/:id/dispute
 * Link a dispute ticket to a right
 */
rightsRouter.post("/:id/dispute", validate(linkRightDisputeSchema), (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return sendError(res, 400, "invalid_id", "ID must be an integer");
    }
    const result = linkRightToDispute(id, req.body.ticketId, req.body.notes);
    res.status(201).json(result);
  } catch (err) {
    if (err.message.includes("not found")) {
      return sendError(res, 404, "right_not_found", err.message);
    }
    next(err);
  }
});
