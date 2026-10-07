/**
 * Rights Management Service
 * 
 * Handles business logic for:
 *   - Defining and managing rights (composition, performance, mechanical, sync)
 *   - Ownership allocation and license terms (commercial, personal, non-commercial)
 *   - Metadata standards (DDEX music industry standard, ISO 20022 financial data, custom fields)
 *   - Ownership verification workflow (document proof uploads, verification checks before distribution)
 *   - Historical tracking of ownership changes
 *   - Linking disputes to rights records
 */

import {
  createRightRecord,
  getRightById as dbGetRightById,
  getRightsByContract as dbGetRightsByContract,
  getRightsByOwner as dbGetRightsByOwner,
  updateRightRecord as dbUpdateRightRecord,
  deleteRightRecord as dbDeleteRightRecord,
  upsertRightMetadataRecord,
  getRightMetadataRecord,
  createVerificationProofRecord,
  getVerificationProofsRecord,
  updateVerificationProofStatusRecord,
  addRightHistoryRecord,
  getRightHistoryRecord,
  linkRightToDisputeRecord,
  getRightsForDisputeRecord,
  getDisputesForRightRecord,
} from "../database/rights-schema.js";

import logger from "../logger.js";

// Constants
export const RIGHT_TYPES = ["composition", "performance", "mechanical", "sync"];
export const LICENSE_TERMS = ["commercial", "personal", "non-commercial"];
export const VERIFICATION_STATUSES = ["unverified", "pending", "verified", "rejected"];
export const DOCUMENT_TYPES = ["contract", "copyright_cert", "split_sheet", "other"];

/**
 * Helper: Validate right type
 */
export function isValidRightType(rightType) {
  return RIGHT_TYPES.includes(rightType);
}

/**
 * Helper: Validate license terms
 */
export function isValidLicenseTerms(terms) {
  return LICENSE_TERMS.includes(terms);
}

/**
 * Validate DDEX Metadata Standard Fields
 */
export function validateDDEXMetadata(ddex) {
  if (!ddex || typeof ddex !== "object") {
    return { valid: false, errors: ["DDEX metadata must be an object"] };
  }
  const errors = [];
  // ISWC (International Standard Musical Work Code) format check if provided (e.g. T-123456789-C or T123456789C)
  if (ddex.iswc && typeof ddex.iswc === "string") {
    const iswcClean = ddex.iswc.replace(/[-.\s]/g, "");
    if (!/^T\d{9}[0-9A-Z]$/i.test(iswcClean)) {
      errors.push("Invalid ISWC format. Must be formatted like T-123456789-C");
    }
  }
  // ISRC (International Standard Recording Code) format check if provided (e.g. US-S1Z-22-00001)
  if (ddex.isrc && typeof ddex.isrc === "string") {
    const isrcClean = ddex.isrc.replace(/[-.\s]/g, "");
    if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(isrcClean)) {
      errors.push("Invalid ISRC format. Must be formatted like US-S1Z-22-00001");
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate ISO 20022 Metadata Standard Fields
 */
export function validateISO20022Metadata(iso) {
  if (!iso || typeof iso !== "object") {
    return { valid: false, errors: ["ISO 20022 metadata must be an object"] };
  }
  const errors = [];
  if (iso.messageIdentifier && typeof iso.messageIdentifier !== "string") {
    errors.push("messageIdentifier must be a string");
  }
  if (iso.businessService && typeof iso.businessService !== "string") {
    errors.push("businessService must be a string");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Create a new Right entry
 */
export function createRight({
  contractId,
  rightType,
  ownerAddress,
  percentage,
  licenseTerms = "commercial",
  effectiveDate = null,
  expirationDate = null,
  createdBy = "system",
}) {
  if (!contractId) throw new Error("contractId is required");
  if (!isValidRightType(rightType)) {
    throw new Error(`Invalid rightType. Must be one of: ${RIGHT_TYPES.join(", ")}`);
  }
  if (!ownerAddress) throw new Error("ownerAddress is required");
  if (typeof percentage !== "number" || percentage < 0 || percentage > 100) {
    throw new Error("percentage must be a number between 0 and 100");
  }
  if (!isValidLicenseTerms(licenseTerms)) {
    throw new Error(`Invalid licenseTerms. Must be one of: ${LICENSE_TERMS.join(", ")}`);
  }

  // Check existing allocations for contract & rightType to prevent total exceeding 100%
  const existingRights = dbGetRightsByContract(contractId).filter((r) => r.rightType === rightType);
  const currentTotal = existingRights.reduce((sum, r) => sum + r.percentage, 0);

  if (currentTotal + percentage > 100.0001) {
    throw new Error(`Total percentage for right type '${rightType}' cannot exceed 100%. Current total: ${currentTotal}%`);
  }

  const right = createRightRecord({
    contractId,
    rightType,
    ownerAddress,
    percentage,
    licenseTerms,
    effectiveDate,
    expirationDate,
  });

  // Log history
  addRightHistoryRecord({
    rightId: right.id,
    contractId,
    action: "create",
    changedBy: createdBy,
    newValues: right,
    reason: "Initial right creation",
  });

  logger.info("Right created successfully", { rightId: right.id, contractId, rightType, ownerAddress });
  return right;
}

/**
 * Get full details of a right including metadata, proof documents, and dispute links
 */
export function getRightDetails(id) {
  const right = dbGetRightById(id);
  if (!right) return null;

  const metadata = getRightMetadataRecord(id);
  const verifications = getVerificationProofsRecord(id);
  const disputes = getDisputesForRightRecord(id);
  const history = getRightHistoryRecord(right.contractId, id);

  return {
    ...right,
    metadata,
    verifications,
    disputes,
    history,
  };
}

/**
 * Get all rights for a contract with summary breakdown
 */
export function getRightsByContract(contractId) {
  const rights = dbGetRightsByContract(contractId);

  // Group by right type and calculate totals & verification status
  const breakdown = {};
  for (const type of RIGHT_TYPES) {
    const matching = rights.filter((r) => r.rightType === type);
    const totalPercentage = matching.reduce((acc, r) => acc + r.percentage, 0);
    const allVerified = matching.length > 0 && matching.every((r) => r.isVerified);
    breakdown[type] = {
      rights: matching,
      totalPercentage,
      isFullyAllocated: Math.abs(totalPercentage - 100) < 0.001,
      isFullyVerified: allVerified,
    };
  }

  return {
    contractId,
    totalRightsCount: rights.length,
    rights,
    breakdown,
  };
}

/**
 * Get rights for owner
 */
export function getRightsByOwner(ownerAddress) {
  return dbGetRightsByOwner(ownerAddress);
}

/**
 * Update an existing right
 */
export function updateRight(id, updates, changedBy = "system", reason = "Updated right details") {
  const existing = dbGetRightById(id);
  if (!existing) throw new Error(`Right with ID ${id} not found`);

  if (updates.rightType && !isValidRightType(updates.rightType)) {
    throw new Error(`Invalid rightType. Must be one of: ${RIGHT_TYPES.join(", ")}`);
  }
  if (updates.licenseTerms && !isValidLicenseTerms(updates.licenseTerms)) {
    throw new Error(`Invalid licenseTerms. Must be one of: ${LICENSE_TERMS.join(", ")}`);
  }

  if (updates.percentage !== undefined && typeof updates.percentage === "number") {
    if (updates.percentage < 0 || updates.percentage > 100) {
      throw new Error("percentage must be between 0 and 100");
    }
    // Check totals
    const existingRights = dbGetRightsByContract(existing.contractId).filter(
      (r) => r.rightType === (updates.rightType || existing.rightType) && r.id !== id
    );
    const currentTotal = existingRights.reduce((sum, r) => sum + r.percentage, 0);
    if (currentTotal + updates.percentage > 100.0001) {
      throw new Error(`Total percentage for right type cannot exceed 100%. Other allocations sum to: ${currentTotal}%`);
    }
  }

  const updated = dbUpdateRightRecord(id, updates);

  addRightHistoryRecord({
    rightId: id,
    contractId: existing.contractId,
    action: "update",
    changedBy,
    oldValues: existing,
    newValues: updated,
    reason,
  });

  return updated;
}

/**
 * Delete a right
 */
export function deleteRight(id, changedBy = "system", reason = "Deleted right") {
  const existing = dbGetRightById(id);
  if (!existing) throw new Error(`Right with ID ${id} not found`);

  dbDeleteRightRecord(id);

  addRightHistoryRecord({
    rightId: id,
    contractId: existing.contractId,
    action: "delete",
    changedBy,
    oldValues: existing,
    newValues: null,
    reason,
  });

  return true;
}

/**
 * Set or update metadata (DDEX, ISO 20022, Custom) for a right
 */
export function setRightMetadata(rightId, { ddex = null, iso20022 = null, customFields = null }, updatedBy = "system") {
  const right = dbGetRightById(rightId);
  if (!right) throw new Error(`Right with ID ${rightId} not found`);

  if (ddex) {
    const ddexVal = validateDDEXMetadata(ddex);
    if (!ddexVal.valid) {
      throw new Error(`DDEX validation error: ${ddexVal.errors.join(", ")}`);
    }
  }

  if (iso20022) {
    const isoVal = validateISO20022Metadata(iso20022);
    if (!isoVal.valid) {
      throw new Error(`ISO 20022 validation error: ${isoVal.errors.join(", ")}`);
    }
  }

  const oldMetadata = getRightMetadataRecord(rightId);
  const newMetadata = upsertRightMetadataRecord(rightId, right.contractId, { ddex, iso20022, customFields });

  addRightHistoryRecord({
    rightId,
    contractId: right.contractId,
    action: "metadata_update",
    changedBy: updatedBy,
    oldValues: oldMetadata,
    newValues: newMetadata,
    reason: "Metadata updated",
  });

  return newMetadata;
}

/**
 * Submit proof document for ownership verification
 */
export function submitVerificationProof(
  rightId,
  { documentName, documentType, documentUrl, documentHash = null, ownerAddress = null }
) {
  const right = dbGetRightById(rightId);
  if (!right) throw new Error(`Right with ID ${rightId} not found`);

  if (!documentName || typeof documentName !== "string") {
    throw new Error("documentName is required");
  }
  if (!DOCUMENT_TYPES.includes(documentType)) {
    throw new Error(`Invalid documentType. Must be one of: ${DOCUMENT_TYPES.join(", ")}`);
  }
  if (!documentUrl || typeof documentUrl !== "string") {
    throw new Error("documentUrl is required");
  }

  const proof = createVerificationProofRecord({
    rightId,
    contractId: right.contractId,
    ownerAddress: ownerAddress || right.ownerAddress,
    documentName,
    documentType,
    documentUrl,
    documentHash,
  });

  addRightHistoryRecord({
    rightId,
    contractId: right.contractId,
    action: "update",
    changedBy: ownerAddress || right.ownerAddress,
    oldValues: { status: right.status },
    newValues: { status: "pending", proofId: proof.id },
    reason: "Submitted verification proof document",
  });

  return proof;
}

/**
 * Verify or reject ownership of a right based on proof review
 */
export function verifyOwnership(rightId, { proofId = null, approved, verifierAddress = "admin", verifierNotes = "" }) {
  const right = dbGetRightById(rightId);
  if (!right) throw new Error(`Right with ID ${rightId} not found`);

  let updatedProof = null;
  if (proofId) {
    updatedProof = updateVerificationProofStatusRecord(proofId, {
      status: approved ? "verified" : "rejected",
      verifierAddress,
      verifierNotes,
    });
  }

  const newStatus = approved ? "verified" : "rejected";
  const updatedRight = dbUpdateRightRecord(rightId, {
    status: newStatus,
    isVerified: approved,
  });

  addRightHistoryRecord({
    rightId,
    contractId: right.contractId,
    action: approved ? "verify" : "reject",
    changedBy: verifierAddress,
    oldValues: { status: right.status, isVerified: right.isVerified },
    newValues: { status: newStatus, isVerified: approved, verifierNotes },
    reason: verifierNotes || (approved ? "Ownership verified" : "Ownership proof rejected"),
  });

  return {
    right: updatedRight,
    proof: updatedProof,
  };
}

/**
 * Check if a contract's rights are verified and complete before allowing distribution
 */
export function verifyContractDistributionEligibility(contractId) {
  const rights = dbGetRightsByContract(contractId);
  const reasons = [];

  if (rights.length === 0) {
    return {
      eligible: false,
      reasons: ["No rights entries configured for this contract"],
      summary: { totalRights: 0 },
    };
  }

  let allVerified = true;
  const typeBreakdown = {};

  for (const type of RIGHT_TYPES) {
    const matching = rights.filter((r) => r.rightType === type);
    const sumPercentage = matching.reduce((acc, r) => acc + r.percentage, 0);
    const verifiedCount = matching.filter((r) => r.isVerified).length;

    if (matching.length > 0) {
      if (Math.abs(sumPercentage - 100) > 0.001) {
        reasons.push(`Right type '${type}' allocations sum to ${sumPercentage}%, expected 100%`);
      }
      if (verifiedCount < matching.length) {
        allVerified = false;
        reasons.push(`Right type '${type}' has ${matching.length - verifiedCount} unverified ownership allocation(s)`);
      }
    }

    typeBreakdown[type] = {
      count: matching.length,
      sumPercentage,
      verifiedCount,
    };
  }

  const eligible = reasons.length === 0;

  return {
    eligible,
    reasons,
    summary: {
      totalRights: rights.length,
      allVerified,
      typeBreakdown,
    },
  };
}

/**
 * Link a dispute to a right record
 */
export function linkRightToDispute(rightId, ticketId, notes = null) {
  const right = dbGetRightById(rightId);
  if (!right) throw new Error(`Right with ID ${rightId} not found`);

  return linkRightToDisputeRecord(rightId, ticketId, notes);
}

/**
 * Get rights for dispute ticket
 */
export function getRightsForDispute(ticketId) {
  return getRightsForDisputeRecord(ticketId);
}

/**
 * Get change history for contract or right
 */
export function getRightsHistory(contractId, rightId = null) {
  return getRightHistoryRecord(contractId, rightId);
}
