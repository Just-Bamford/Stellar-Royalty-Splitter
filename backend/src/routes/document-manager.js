/**
 * Document Manager Express Routes
 * Issue #1060 - Advanced document management system with IPFS
 */

import express from "express";
import { documentManager, DOCUMENT_TYPES, PERMISSION_LEVELS, SIGNATURE_STATUSES } from "../services/document-manager.js";
import { ipfsIntegration } from "../services/ipfs-integration.js";
import { sendError } from "../error-response.js";
import logger from "../logger.js";

const router = express.Router();

function getUserAddress(req) {
  return req.user?.address || req.headers["x-user-id"] || req.query.userAddress || req.body?.userAddress || null;
}

/**
 * POST /api/v1/documents
 * Create and upload a new document to IPFS
 */
router.post("/", async (req, res) => {
  try {
    const {
      title,
      docType,
      contractId,
      description,
      tags,
      fileContent,
      fileName,
      mimeType,
      signers,
      initialPermissions,
      pinToIpfs,
    } = req.body || {};

    const ownerAddress = req.body.ownerAddress || getUserAddress(req);

    if (!title || !ownerAddress || fileContent === undefined) {
      return sendError(res, 400, "invalid_request", "title, ownerAddress, and fileContent are required");
    }

    const result = await documentManager.createDocument({
      title,
      docType,
      ownerAddress,
      contractId,
      description,
      tags,
      fileContent,
      fileName,
      mimeType,
      signers,
      initialPermissions,
      pinToIpfs,
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    logger.error("Failed to create document", { error: err.message });
    const status = err.message.startsWith("Invalid document type") ? 400 : 500;
    sendError(res, status, "document_creation_failed", err.message);
  }
});

/**
 * GET /api/v1/documents
 * Search & catalog listing
 */
router.get("/", (req, res) => {
  try {
    const {
      query,
      docType,
      signatureStatus,
      collaborator,
      owner,
      contractId,
      startDate,
      endDate,
      limit,
      offset,
    } = req.query;

    const results = documentManager.searchCatalog({
      query,
      docType,
      signatureStatus,
      collaborator,
      owner,
      contractId,
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });

    res.json({
      success: true,
      data: results,
      types: DOCUMENT_TYPES,
      statuses: SIGNATURE_STATUSES,
      permissions: PERMISSION_LEVELS,
    });
  } catch (err) {
    logger.error("Failed to search documents catalog", { error: err.message });
    sendError(res, 500, "catalog_search_failed", err.message);
  }
});

/**
 * POST /api/v1/documents/ipfs/verify
 * Verify content against IPFS CID
 */
router.post("/ipfs/verify", (req, res) => {
  try {
    const { cid, content } = req.body || {};
    if (!cid || content === undefined) {
      return sendError(res, 400, "invalid_request", "cid and content are required");
    }

    const verified = ipfsIntegration.verifyContent(cid, content);
    res.json({
      success: true,
      cid,
      verified,
    });
  } catch (err) {
    sendError(res, 400, "ipfs_verification_failed", err.message);
  }
});

/**
 * GET /api/v1/documents/:id
 * Get single document details
 */
router.get("/:id", async (req, res) => {
  try {
    const userAddress = getUserAddress(req);
    const doc = await documentManager.getDocument(req.params.id, userAddress);
    res.json({
      success: true,
      data: doc,
    });
  } catch (err) {
    const is404 = err.message.includes("not found");
    const is403 = err.message.startsWith("Forbidden");
    const status = is404 ? 404 : is403 ? 403 : 500;
    sendError(res, status, is404 ? "not_found" : is403 ? "forbidden" : "document_fetch_failed", err.message);
  }
});

/**
 * GET /api/v1/documents/:id/download
 * Download document file with view-only vs download permission enforcement
 */
router.get("/:id/download", async (req, res) => {
  try {
    const userAddress = getUserAddress(req);
    if (!userAddress) {
      return sendError(res, 401, "unauthorized", "User address header or parameter required for download");
    }

    const { version } = req.query;
    const downloadData = await documentManager.downloadDocument(req.params.id, {
      versionNumber: version,
      userAddress,
    });

    res.setHeader("Content-Type", downloadData.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadData.fileName}"`);
    res.setHeader("X-IPFS-CID", downloadData.cid);
    res.setHeader("X-Checksum-SHA256", downloadData.checksum);

    res.send(downloadData.content);
  } catch (err) {
    const is403 = err.message.startsWith("Forbidden");
    const is404 = err.message.includes("not found");
    const status = is403 ? 403 : is404 ? 404 : 500;
    sendError(res, status, is403 ? "forbidden" : is404 ? "not_found" : "download_failed", err.message);
  }
});

/**
 * POST /api/v1/documents/:id/versions
 * Upload a new version for an existing document
 */
router.post("/:id/versions", async (req, res) => {
  try {
    const createdBy = req.body.createdBy || getUserAddress(req);
    const { fileContent, fileName, mimeType, changeSummary, signers, pinToIpfs } = req.body || {};

    if (!createdBy || fileContent === undefined) {
      return sendError(res, 400, "invalid_request", "createdBy and fileContent are required");
    }

    const result = await documentManager.uploadNewVersion(req.params.id, {
      fileContent,
      fileName,
      mimeType,
      createdBy,
      changeSummary,
      signers,
      pinToIpfs,
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    const is403 = err.message.startsWith("Forbidden");
    const is404 = err.message.includes("not found");
    const status = is403 ? 403 : is404 ? 404 : 500;
    sendError(res, status, is403 ? "forbidden" : is404 ? "not_found" : "version_upload_failed", err.message);
  }
});

/**
 * POST /api/v1/documents/:id/share
 * Share document with a collaborator
 */
router.post("/:id/share", async (req, res) => {
  try {
    const grantedBy = req.body.grantedBy || getUserAddress(req);
    const { collaboratorAddress, permissionLevel, expiresAt } = req.body || {};

    if (!grantedBy || !collaboratorAddress) {
      return sendError(res, 400, "invalid_request", "grantedBy and collaboratorAddress are required");
    }

    const permission = await documentManager.shareDocument(req.params.id, {
      collaboratorAddress,
      permissionLevel,
      grantedBy,
      expiresAt,
    });

    res.json({
      success: true,
      data: permission,
    });
  } catch (err) {
    const is403 = err.message.startsWith("Forbidden");
    const status = is403 ? 403 : 400;
    sendError(res, status, is403 ? "forbidden" : "share_failed", err.message);
  }
});

/**
 * DELETE /api/v1/documents/:id/share/:collaboratorAddress
 * Revoke collaborator permission
 */
router.delete("/:id/share/:collaboratorAddress", async (req, res) => {
  try {
    const revokedBy = req.query.revokedBy || getUserAddress(req);
    if (!revokedBy) {
      return sendError(res, 400, "invalid_request", "revokedBy address is required");
    }

    const result = await documentManager.revokeAccess(req.params.id, {
      collaboratorAddress: req.params.collaboratorAddress,
      revokedBy,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    const is403 = err.message.startsWith("Forbidden");
    const status = is403 ? 403 : 400;
    sendError(res, status, is403 ? "forbidden" : "revoke_failed", err.message);
  }
});

/**
 * POST /api/v1/documents/:id/signatures/request
 * Request signatures
 */
router.post("/:id/signatures/request", async (req, res) => {
  try {
    const requestedBy = req.body.requestedBy || getUserAddress(req);
    const { versionNumber, signers } = req.body || {};

    if (!requestedBy || !signers) {
      return sendError(res, 400, "invalid_request", "requestedBy and signers list are required");
    }

    const signatures = await documentManager.requestSignatures(req.params.id, {
      versionNumber,
      signers,
      requestedBy,
    });

    res.json({
      success: true,
      data: signatures,
    });
  } catch (err) {
    const is403 = err.message.startsWith("Forbidden");
    const status = is403 ? 403 : 400;
    sendError(res, status, is403 ? "forbidden" : "request_signature_failed", err.message);
  }
});

/**
 * POST /api/v1/documents/:id/sign
 * Digitally sign document version
 */
router.post("/:id/sign", async (req, res) => {
  try {
    const signerAddress = req.body.signerAddress || getUserAddress(req);
    const { versionNumber, signature, metadata } = req.body || {};

    if (!signerAddress || !signature) {
      return sendError(res, 400, "invalid_request", "signerAddress and signature are required");
    }

    const result = await documentManager.signDocument(req.params.id, {
      versionNumber,
      signerAddress,
      signature,
      metadata,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    logger.error("Failed to sign document", { error: err.message });
    sendError(res, 400, "sign_failed", err.message);
  }
});

/**
 * POST /api/v1/documents/:id/reject
 * Reject a signature request
 */
router.post("/:id/reject", async (req, res) => {
  try {
    const signerAddress = req.body.signerAddress || getUserAddress(req);
    const { versionNumber, reason } = req.body || {};

    if (!signerAddress) {
      return sendError(res, 400, "invalid_request", "signerAddress is required");
    }

    const result = await documentManager.rejectSignature(req.params.id, {
      versionNumber,
      signerAddress,
      reason,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    sendError(res, 400, "reject_signature_failed", err.message);
  }
});

/**
 * GET /api/v1/documents/:id/audit-trail
 * Get document audit trail
 */
router.get("/:id/audit-trail", (req, res) => {
  try {
    const userAddress = getUserAddress(req);
    const auditData = documentManager.getAuditTrail(req.params.id, userAddress);
    res.json({
      success: true,
      data: auditData,
    });
  } catch (err) {
    const is403 = err.message.startsWith("Forbidden");
    const is404 = err.message.includes("not found");
    const status = is403 ? 403 : is404 ? 404 : 500;
    sendError(res, status, is403 ? "forbidden" : is404 ? "not_found" : "audit_fetch_failed", err.message);
  }
});

/**
 * GET /api/v1/documents/:id/audit-trail/export
 * Export audit trail as CSV or JSON
 */
router.get("/:id/audit-trail/export", (req, res) => {
  try {
    const userAddress = getUserAddress(req);
    const { format = "json" } = req.query;

    const exported = documentManager.exportAuditTrail(req.params.id, {
      format,
      userAddress,
    });

    res.setHeader("Content-Type", exported.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${exported.fileName}"`);
    res.setHeader("X-Audit-Verified", String(exported.verified));

    if (format === "csv") {
      res.send(exported.data);
    } else {
      res.json(exported.data);
    }
  } catch (err) {
    const is403 = err.message.startsWith("Forbidden");
    const status = is403 ? 403 : 500;
    sendError(res, status, is403 ? "forbidden" : "export_failed", err.message);
  }
});

export { router as documentManagerRouter, router as documentsRouter };
export default router;
