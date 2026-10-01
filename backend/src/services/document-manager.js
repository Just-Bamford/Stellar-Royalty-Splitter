/**
 * Document Manager Service
 * Issue #1060 - Advanced document management system with IPFS
 *
 * Implements business logic for:
 * - Document uploads and immutable IPFS storage
 * - Multi-stage version control and change tracking
 * - Role-based and collaborator-specific access control (view-only vs download)
 * - Cryptographic digital signature workflows
 * - Catalog querying, filtering, and searching
 * - Immutable hash-chained audit trail export
 */

import { ipfsIntegration } from "./ipfs-integration.js";
import {
  insertDocument,
  insertDocumentVersion,
  getDocumentById,
  updateDocument,
  listDocuments,
  getDocumentVersions,
  getDocumentVersion,
  setCollaboratorPermission,
  revokeCollaboratorPermission,
  getDocumentPermissions,
  getUserPermission,
  requestSignatures as dbRequestSignatures,
  recordSignature as dbRecordSignature,
  rejectSignature as dbRejectSignature,
  getDocumentSignatures,
  recordDocumentAudit,
  getDocumentAuditTrail,
  exportDocumentAuditTrail,
} from "../database/document-manager.js";
import logger from "../logger.js";

export const DOCUMENT_TYPES = [
  "contract",
  "agreement",
  "proof",
  "tax_form",
  "amendment",
  "other",
];

export const PERMISSION_LEVELS = ["view", "download", "sign", "admin"];

export const SIGNATURE_STATUSES = [
  "unsigned",
  "pending",
  "partially_signed",
  "signed",
  "rejected",
];

export class DocumentManagerService {
  constructor(options = {}) {
    this.ipfs = options.ipfs || ipfsIntegration;
  }

  /**
   * Create and upload a new document to IPFS
   */
  async createDocument({
    title,
    docType = "contract",
    ownerAddress,
    contractId = null,
    description = "",
    tags = [],
    fileContent,
    fileName,
    mimeType = "application/pdf",
    signers = [],
    initialPermissions = [],
    pinToIpfs = true,
  }) {
    if (!title || !title.trim()) {
      throw new Error("Document title is required");
    }
    if (!ownerAddress || !ownerAddress.trim()) {
      throw new Error("Owner wallet address is required");
    }
    if (fileContent === undefined || fileContent === null) {
      throw new Error("Document file content is required");
    }
    if (!DOCUMENT_TYPES.includes(docType)) {
      throw new Error(`Invalid document type: ${docType}. Must be one of: ${DOCUMENT_TYPES.join(", ")}`);
    }

    // 1. Upload initial file to IPFS
    const safeFileName = fileName || `${title.replace(/\s+/g, "_").toLowerCase()}.${mimeType.includes("json") ? "json" : "pdf"}`;
    const ipfsResult = await this.ipfs.uploadContent(fileContent, {
      fileName: safeFileName,
      mimeType,
      pin: pinToIpfs,
      metadata: { title, ownerAddress, contractId, docType },
    });

    // 2. Determine initial signature status
    const hasSigners = Array.isArray(signers) && signers.length > 0;
    const initialSigStatus = hasSigners ? "pending" : "unsigned";

    // 3. Create document record in DB
    const doc = insertDocument({
      title: title.trim(),
      docType,
      ownerAddress,
      contractId,
      description: description ? description.trim() : "",
      currentVersion: 1,
      currentCid: ipfsResult.cid,
      signatureStatus: initialSigStatus,
      tags: Array.isArray(tags) ? tags : [],
    });

    // 4. Record Version 1 in DB
    const version = insertDocumentVersion({
      documentId: doc.id,
      versionNumber: 1,
      cid: ipfsResult.cid,
      fileName: safeFileName,
      fileSize: ipfsResult.size,
      mimeType,
      checksum: ipfsResult.checksum,
      createdBy: ownerAddress,
      changeSummary: "Initial version upload",
      metadata: { ipfsPinned: ipfsResult.pinned },
    });

    // 5. Add initial collaborator permissions if provided
    if (Array.isArray(initialPermissions)) {
      for (const p of initialPermissions) {
        if (p.collaboratorAddress && PERMISSION_LEVELS.includes(p.permissionLevel || "view")) {
          setCollaboratorPermission({
            documentId: doc.id,
            collaboratorAddress: p.collaboratorAddress,
            permissionLevel: p.permissionLevel || "view",
            grantedBy: ownerAddress,
            expiresAt: p.expiresAt || null,
          });
          recordDocumentAudit({
            documentId: doc.id,
            action: "grant_permission",
            performedBy: ownerAddress,
            details: {
              collaborator: p.collaboratorAddress,
              permissionLevel: p.permissionLevel || "view",
            },
          });
        }
      }
    }

    // 6. Register signature requests if signers specified
    let signatureRequests = [];
    if (hasSigners) {
      signatureRequests = dbRequestSignatures({
        documentId: doc.id,
        versionNumber: 1,
        signers,
      });
      recordDocumentAudit({
        documentId: doc.id,
        versionNumber: 1,
        action: "request_signature",
        performedBy: ownerAddress,
        details: { signers },
      });
    }

    // 7. Record document creation audit log
    recordDocumentAudit({
      documentId: doc.id,
      versionNumber: 1,
      action: "create",
      performedBy: ownerAddress,
      details: {
        title: doc.title,
        docType: doc.doc_type,
        cid: ipfsResult.cid,
        fileSize: ipfsResult.size,
        contractId,
      },
    });

    logger.info("Created document with IPFS CID", {
      documentId: doc.id,
      cid: ipfsResult.cid,
      owner: ownerAddress,
    });

    return {
      ...doc,
      currentVersionDetails: version,
      gatewayUrl: ipfsResult.gatewayUrl,
      signatures: signatureRequests,
      permissions: getDocumentPermissions(doc.id),
    };
  }

  /**
   * Upload a new version for an existing document
   */
  async uploadNewVersion(
    documentId,
    {
      fileContent,
      fileName,
      mimeType = "application/pdf",
      createdBy,
      changeSummary = "Updated document",
      signers = [],
      pinToIpfs = true,
    },
  ) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found with ID: ${documentId}`);
    }

    if (!createdBy) {
      throw new Error("Author address (createdBy) is required");
    }

    // Enforce Access Control: only owner or admin can upload a new version
    const userPerm = getUserPermission(documentId, createdBy);
    if (userPerm !== "owner" && userPerm !== "admin") {
      throw new Error(`Forbidden: Address ${createdBy} is not authorized to create new versions for document ${documentId}`);
    }

    if (fileContent === undefined || fileContent === null) {
      throw new Error("File content is required for new version");
    }

    const nextVersionNumber = doc.current_version + 1;
    const safeFileName = fileName || `${doc.title.replace(/\s+/g, "_").toLowerCase()}_v${nextVersionNumber}`;

    // Upload to IPFS
    const ipfsResult = await this.ipfs.uploadContent(fileContent, {
      fileName: safeFileName,
      mimeType,
      pin: pinToIpfs,
      metadata: { documentId, versionNumber: nextVersionNumber, createdBy },
    });

    // Record new version in DB
    const parentVersion = getDocumentVersion(documentId, doc.current_version);
    const versionRecord = insertDocumentVersion({
      documentId,
      versionNumber: nextVersionNumber,
      cid: ipfsResult.cid,
      fileName: safeFileName,
      fileSize: ipfsResult.size,
      mimeType,
      checksum: ipfsResult.checksum,
      createdBy,
      changeSummary,
      parentVersionId: parentVersion ? parentVersion.id : null,
      metadata: { ipfsPinned: ipfsResult.pinned },
    });

    // Handle signatures for the new version
    const hasSigners = Array.isArray(signers) && signers.length > 0;
    const newSigStatus = hasSigners ? "pending" : "unsigned";

    // Update document head
    const updatedDoc = updateDocument(documentId, {
      current_version: nextVersionNumber,
      current_cid: ipfsResult.cid,
      signature_status: newSigStatus,
    });

    let signatures = [];
    if (hasSigners) {
      signatures = dbRequestSignatures({
        documentId,
        versionNumber: nextVersionNumber,
        signers,
      });
      recordDocumentAudit({
        documentId,
        versionNumber: nextVersionNumber,
        action: "request_signature",
        performedBy: createdBy,
        details: { signers, versionNumber: nextVersionNumber },
      });
    }

    // Audit log
    recordDocumentAudit({
      documentId,
      versionNumber: nextVersionNumber,
      action: "upload_version",
      performedBy: createdBy,
      details: {
        versionNumber: nextVersionNumber,
        cid: ipfsResult.cid,
        changeSummary,
        fileSize: ipfsResult.size,
      },
    });

    return {
      document: updatedDoc,
      version: versionRecord,
      gatewayUrl: ipfsResult.gatewayUrl,
      signatures,
    };
  }

  /**
   * Get document metadata and details (with access control check)
   */
  async getDocument(documentId, userAddress = null) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    let userPermission = null;
    if (userAddress) {
      userPermission = getUserPermission(documentId, userAddress);
      // If user is neither owner, nor has permission, nor is a signer
      const isSigner = getDocumentSignatures(documentId).some(
        (s) => s.signer_address === userAddress,
      );
      if (!userPermission && !isSigner) {
        throw new Error(`Forbidden: You do not have permission to view document ${documentId}`);
      }

      recordDocumentAudit({
        documentId,
        action: "view",
        performedBy: userAddress,
        details: { version: doc.current_version },
      });
    }

    const versions = getDocumentVersions(documentId);
    const permissions = getDocumentPermissions(documentId);
    const signatures = getDocumentSignatures(documentId, doc.current_version);

    return {
      ...doc,
      gatewayUrl: this.ipfs.getGatewayUrl(doc.current_cid),
      userPermission,
      versions,
      permissions,
      signatures,
    };
  }

  /**
   * Download document file content (with view vs download access enforcement)
   */
  async downloadDocument(documentId, { versionNumber = null, userAddress }) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (!userAddress) {
      throw new Error("User address is required to download document");
    }

    // Enforce view-only vs download permission
    const userPermission = getUserPermission(documentId, userAddress);
    if (userPermission !== "owner" && userPermission !== "admin" && userPermission !== "download") {
      if (userPermission === "view") {
        throw new Error(`Forbidden: You only have view-only access to document ${documentId}. Download is restricted.`);
      }
      throw new Error(`Forbidden: Access denied for document ${documentId}`);
    }

    const targetVersionNumber = versionNumber ? Number(versionNumber) : doc.current_version;
    const version = getDocumentVersion(documentId, targetVersionNumber);
    if (!version) {
      throw new Error(`Version ${targetVersionNumber} not found for document ${documentId}`);
    }

    // Retrieve from IPFS and verify integrity
    const ipfsContent = await this.ipfs.getContent(version.cid);

    recordDocumentAudit({
      documentId,
      versionNumber: targetVersionNumber,
      action: "download",
      performedBy: userAddress,
      details: { cid: version.cid, versionNumber: targetVersionNumber },
    });

    return {
      content: ipfsContent.content,
      fileName: version.file_name,
      mimeType: version.mime_type,
      size: version.file_size,
      checksum: version.checksum,
      cid: version.cid,
      versionNumber: targetVersionNumber,
      verified: ipfsContent.verified,
    };
  }

  /**
   * Share document with specific collaborator
   */
  async shareDocument(
    documentId,
    { collaboratorAddress, permissionLevel = "view", grantedBy, expiresAt = null },
  ) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (!grantedBy) {
      throw new Error("Grantor address is required");
    }
    if (!collaboratorAddress) {
      throw new Error("Collaborator address is required");
    }
    if (!PERMISSION_LEVELS.includes(permissionLevel)) {
      throw new Error(`Invalid permission level: ${permissionLevel}. Allowed: ${PERMISSION_LEVELS.join(", ")}`);
    }

    const granterPerm = getUserPermission(documentId, grantedBy);
    if (granterPerm !== "owner" && granterPerm !== "admin") {
      throw new Error("Forbidden: Only owner or admin can share this document");
    }

    const perm = setCollaboratorPermission({
      documentId,
      collaboratorAddress,
      permissionLevel,
      grantedBy,
      expiresAt,
    });

    recordDocumentAudit({
      documentId,
      action: "grant_permission",
      performedBy: grantedBy,
      details: { collaboratorAddress, permissionLevel, expiresAt },
    });

    return perm;
  }

  /**
   * Revoke collaborator document access
   */
  async revokeAccess(documentId, { collaboratorAddress, revokedBy }) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    const revokerPerm = getUserPermission(documentId, revokedBy);
    if (revokerPerm !== "owner" && revokerPerm !== "admin") {
      throw new Error("Forbidden: Only owner or admin can revoke permissions");
    }

    const revoked = revokeCollaboratorPermission(documentId, collaboratorAddress);

    recordDocumentAudit({
      documentId,
      action: "revoke_permission",
      performedBy: revokedBy,
      details: { collaboratorAddress },
    });

    return { success: revoked, documentId, collaboratorAddress };
  }

  /**
   * Request signatures on a document
   */
  async requestSignatures(documentId, { versionNumber = null, signers = [], requestedBy }) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    const requesterPerm = getUserPermission(documentId, requestedBy);
    if (requesterPerm !== "owner" && requesterPerm !== "admin") {
      throw new Error("Forbidden: Only owner or admin can request signatures");
    }

    if (!Array.isArray(signers) || signers.length === 0) {
      throw new Error("Signers list must contain at least one wallet address");
    }

    const targetVersion = versionNumber ? Number(versionNumber) : doc.current_version;
    const sigs = dbRequestSignatures({
      documentId,
      versionNumber: targetVersion,
      signers,
    });

    updateDocument(documentId, { signature_status: "pending" });

    recordDocumentAudit({
      documentId,
      versionNumber: targetVersion,
      action: "request_signature",
      performedBy: requestedBy,
      details: { signers, versionNumber: targetVersion },
    });

    return sigs;
  }

  /**
   * Digitally sign a document version
   */
  async signDocument(
    documentId,
    { versionNumber = null, signerAddress, signature, metadata = {} },
  ) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (!signerAddress || !signerAddress.trim()) {
      throw new Error("Signer address is required");
    }
    if (!signature || !signature.trim()) {
      throw new Error("Digital signature is required");
    }

    const targetVersion = versionNumber ? Number(versionNumber) : doc.current_version;

    // Record the signature in the DB
    const signatureRecord = dbRecordSignature({
      documentId,
      versionNumber: targetVersion,
      signerAddress,
      signature,
      metadata,
    });

    const refreshedDoc = getDocumentById(documentId);

    recordDocumentAudit({
      documentId,
      versionNumber: targetVersion,
      action: "sign",
      performedBy: signerAddress,
      details: {
        signature,
        newDocumentStatus: refreshedDoc.signature_status,
      },
    });

    logger.info("Document digitally signed", {
      documentId,
      version: targetVersion,
      signer: signerAddress,
      status: refreshedDoc.signature_status,
    });

    return {
      success: true,
      signatureRecord,
      documentStatus: refreshedDoc.signature_status,
    };
  }

  /**
   * Reject a signature request
   */
  async rejectSignature(
    documentId,
    { versionNumber = null, signerAddress, reason = "" },
  ) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (!signerAddress) {
      throw new Error("Signer address is required");
    }

    const targetVersion = versionNumber ? Number(versionNumber) : doc.current_version;

    const rejection = dbRejectSignature({
      documentId,
      versionNumber: targetVersion,
      signerAddress,
      reason,
    });

    recordDocumentAudit({
      documentId,
      versionNumber: targetVersion,
      action: "reject_signature",
      performedBy: signerAddress,
      details: { reason },
    });

    return {
      success: true,
      rejection,
      documentStatus: "rejected",
    };
  }

  /**
   * Search and filter document catalog
   */
  searchCatalog(filters = {}) {
    const results = listDocuments(filters);

    // Enrich documents with gateway URLs and signature summaries
    const enriched = results.documents.map((d) => ({
      ...d,
      gatewayUrl: this.ipfs.getGatewayUrl(d.current_cid),
      signatures: getDocumentSignatures(d.id, d.current_version),
      permissionsCount: getDocumentPermissions(d.id).length,
    }));

    return {
      ...results,
      documents: enriched,
    };
  }

  /**
   * Get audit trail for document
   */
  getAuditTrail(documentId, userAddress = null) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (userAddress) {
      const userPerm = getUserPermission(documentId, userAddress);
      if (!userPerm) {
        throw new Error("Forbidden: Access denied to document audit trail");
      }
    }

    return getDocumentAuditTrail(documentId);
  }

  /**
   * Export document audit trail as JSON or CSV
   */
  exportAuditTrail(documentId, { format = "json", userAddress = null }) {
    const doc = getDocumentById(documentId);
    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (userAddress) {
      const userPerm = getUserPermission(documentId, userAddress);
      if (!userPerm) {
        throw new Error("Forbidden: Access denied to export audit trail");
      }
    }

    return exportDocumentAuditTrail(documentId, format);
  }
}

export const documentManager = new DocumentManagerService();
export default documentManager;
