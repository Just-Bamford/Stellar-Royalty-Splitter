/**
 * Document Manager Service Unit Tests
 * Issue #1060 - Advanced document management system with IPFS
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  DocumentManagerService,
  DOCUMENT_TYPES,
  PERMISSION_LEVELS,
  SIGNATURE_STATUSES,
} from "../src/services/document-manager.js";
import { IPFSIntegrationService } from "../src/services/ipfs-integration.js";
import { resetDocumentDatabase } from "../src/database/document-manager.js";

describe("Document Manager Service (#1060)", () => {
  let docService;
  let mockIpfs;
  const OWNER_ADDR = "GAOWNER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const COLLAB_ADDR = "GACOLLAB1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const SIGNER_ADDR = "GASIGNER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  beforeEach(() => {
    resetDocumentDatabase();
    mockIpfs = new IPFSIntegrationService();
    mockIpfs.clearCache();
    docService = new DocumentManagerService({ ipfs: mockIpfs });
  });

  describe("Constants and enums", () => {
    test("defines expected document types, permission levels, and signature statuses", () => {
      expect(DOCUMENT_TYPES).toContain("contract");
      expect(DOCUMENT_TYPES).toContain("agreement");
      expect(DOCUMENT_TYPES).toContain("proof");
      expect(PERMISSION_LEVELS).toEqual(["view", "download", "sign", "admin"]);
      expect(SIGNATURE_STATUSES).toContain("signed");
      expect(SIGNATURE_STATUSES).toContain("pending");
    });
  });

  describe("createDocument", () => {
    test("creates document, stores on IPFS, and initializes version 1", async () => {
      const doc = await docService.createDocument({
        title: "Royalty Distribution Agreement",
        docType: "agreement",
        ownerAddress: OWNER_ADDR,
        contractId: "C123456",
        description: "Standard 70/30 music royalty distribution agreement",
        tags: ["music", "split", "2026"],
        fileContent: "AGREEMENT TERMS: 70% to Artist, 30% to Producer",
        fileName: "royalty_agreement.pdf",
        mimeType: "application/pdf",
      });

      expect(doc.id).toBeDefined();
      expect(doc.id.startsWith("doc_")).toBe(true);
      expect(doc.title).toBe("Royalty Distribution Agreement");
      expect(doc.doc_type).toBe("agreement");
      expect(doc.owner_address).toBe(OWNER_ADDR);
      expect(doc.current_version).toBe(1);
      expect(doc.current_cid).toBeDefined();
      expect(doc.current_cid.startsWith("Qm")).toBe(true);
      expect(doc.signature_status).toBe("unsigned");
      expect(doc.gatewayUrl).toContain(doc.current_cid);
    });

    test("sets initial permissions and signature requests on creation", async () => {
      const doc = await docService.createDocument({
        title: "Multi-party Contract",
        docType: "contract",
        ownerAddress: OWNER_ADDR,
        fileContent: "Contract terms",
        signers: [SIGNER_ADDR, COLLAB_ADDR],
        initialPermissions: [
          { collaboratorAddress: COLLAB_ADDR, permissionLevel: "download" },
        ],
      });

      expect(doc.signature_status).toBe("pending");
      expect(doc.signatures).toHaveLength(2);
      expect(doc.permissions).toHaveLength(1);
      expect(doc.permissions[0].collaborator_address).toBe(COLLAB_ADDR);
      expect(doc.permissions[0].permission_level).toBe("download");
    });

    test("validates required fields and document types", async () => {
      await expect(
        docService.createDocument({
          title: "",
          ownerAddress: OWNER_ADDR,
          fileContent: "data",
        }),
      ).rejects.toThrow("Document title is required");

      await expect(
        docService.createDocument({
          title: "Test",
          ownerAddress: "",
          fileContent: "data",
        }),
      ).rejects.toThrow("Owner wallet address is required");

      await expect(
        docService.createDocument({
          title: "Test",
          ownerAddress: OWNER_ADDR,
          docType: "invalid_type",
          fileContent: "data",
        }),
      ).rejects.toThrow("Invalid document type");
    });
  });

  describe("Version Control (uploadNewVersion)", () => {
    test("uploads new version v2, updates document head, and records parent version", async () => {
      const created = await docService.createDocument({
        title: "Smart Contract Terms",
        ownerAddress: OWNER_ADDR,
        fileContent: "Version 1 Content",
      });

      const v2Result = await docService.uploadNewVersion(created.id, {
        fileContent: "Version 2 Content with updated terms",
        fileName: "terms_v2.pdf",
        createdBy: OWNER_ADDR,
        changeSummary: "Updated royalty split percentages",
      });

      expect(v2Result.version.version_number).toBe(2);
      expect(v2Result.version.change_summary).toBe("Updated royalty split percentages");
      expect(v2Result.document.current_version).toBe(2);
      expect(v2Result.version.cid).not.toBe(created.current_cid);

      const docDetails = await docService.getDocument(created.id, OWNER_ADDR);
      expect(docDetails.versions).toHaveLength(2);
      expect(docDetails.versions[0].version_number).toBe(2);
      expect(docDetails.versions[1].version_number).toBe(1);
    });

    test("enforces access control: non-owner/non-admin cannot upload new version", async () => {
      const doc = await docService.createDocument({
        title: "Protected Doc",
        ownerAddress: OWNER_ADDR,
        fileContent: "Protected",
      });

      // Grant COLLAB_ADDR only view permission
      await docService.shareDocument(doc.id, {
        collaboratorAddress: COLLAB_ADDR,
        permissionLevel: "view",
        grantedBy: OWNER_ADDR,
      });

      await expect(
        docService.uploadNewVersion(doc.id, {
          fileContent: "Unauthorized update",
          createdBy: COLLAB_ADDR,
        }),
      ).rejects.toThrow("Forbidden: Address");
    });
  });

  describe("Access Control (shareDocument, revokeAccess, downloadDocument)", () => {
    test("enforces view-only vs download permissions", async () => {
      const doc = await docService.createDocument({
        title: "Confidential Contract",
        ownerAddress: OWNER_ADDR,
        fileContent: "Confidential financial terms",
        fileName: "confidential.pdf",
      });

      // Share view-only with COLLAB_ADDR
      await docService.shareDocument(doc.id, {
        collaboratorAddress: COLLAB_ADDR,
        permissionLevel: "view",
        grantedBy: OWNER_ADDR,
      });

      // COLLAB_ADDR can view document metadata
      const viewResult = await docService.getDocument(doc.id, COLLAB_ADDR);
      expect(viewResult.id).toBe(doc.id);
      expect(viewResult.userPermission).toBe("view");

      // COLLAB_ADDR CANNOT download file content
      await expect(
        docService.downloadDocument(doc.id, { userAddress: COLLAB_ADDR }),
      ).rejects.toThrow("You only have view-only access");

      // Upgrade permission to download
      await docService.shareDocument(doc.id, {
        collaboratorAddress: COLLAB_ADDR,
        permissionLevel: "download",
        grantedBy: OWNER_ADDR,
      });

      // COLLAB_ADDR CAN now download file content
      const downloadResult = await docService.downloadDocument(doc.id, {
        userAddress: COLLAB_ADDR,
      });
      expect(downloadResult.verified).toBe(true);
      expect(downloadResult.content.toString("utf8")).toBe("Confidential financial terms");
    });

    test("revoking access blocks subsequent document operations", async () => {
      const doc = await docService.createDocument({
        title: "Revoke Test",
        ownerAddress: OWNER_ADDR,
        fileContent: "Data",
      });

      await docService.shareDocument(doc.id, {
        collaboratorAddress: COLLAB_ADDR,
        permissionLevel: "download",
        grantedBy: OWNER_ADDR,
      });

      await docService.revokeAccess(doc.id, {
        collaboratorAddress: COLLAB_ADDR,
        revokedBy: OWNER_ADDR,
      });

      await expect(
        docService.getDocument(doc.id, COLLAB_ADDR),
      ).rejects.toThrow("Forbidden: You do not have permission");
    });
  });

  describe("Digital Signatures Workflow", () => {
    test("progresses signature status from pending -> partially_signed -> signed", async () => {
      const doc = await docService.createDocument({
        title: "Three-Party Agreement",
        ownerAddress: OWNER_ADDR,
        fileContent: "Agreement terms",
        signers: [SIGNER_ADDR, COLLAB_ADDR],
      });

      expect(doc.signature_status).toBe("pending");

      // First signer signs
      const sign1 = await docService.signDocument(doc.id, {
        signerAddress: SIGNER_ADDR,
        signature: "ed25519_sig_signer_1",
      });
      expect(sign1.documentStatus).toBe("partially_signed");

      // Second signer signs
      const sign2 = await docService.signDocument(doc.id, {
        signerAddress: COLLAB_ADDR,
        signature: "ed25519_sig_collab_2",
      });
      expect(sign2.documentStatus).toBe("signed");

      const docFinal = await docService.getDocument(doc.id, OWNER_ADDR);
      expect(docFinal.signature_status).toBe("signed");
    });

    test("handles signature rejection with reason", async () => {
      const doc = await docService.createDocument({
        title: "Disputed Agreement",
        ownerAddress: OWNER_ADDR,
        fileContent: "Unagreed terms",
        signers: [SIGNER_ADDR],
      });

      const rej = await docService.rejectSignature(doc.id, {
        signerAddress: SIGNER_ADDR,
        reason: "Percentages do not match previous agreement",
      });

      expect(rej.documentStatus).toBe("rejected");
      expect(rej.rejection.rejection_reason).toBe("Percentages do not match previous agreement");

      const docRefreshed = await docService.getDocument(doc.id, OWNER_ADDR);
      expect(docRefreshed.signature_status).toBe("rejected");
    });
  });

  describe("Catalog Search and Filtering", () => {
    test("filters by docType, signatureStatus, text query, and date", async () => {
      await docService.createDocument({
        title: "Music Royalty Agreement",
        docType: "agreement",
        ownerAddress: OWNER_ADDR,
        description: "Album split agreement",
        tags: ["music", "album"],
        fileContent: "Content 1",
      });

      await docService.createDocument({
        title: "Smart Contract Code",
        docType: "contract",
        ownerAddress: OWNER_ADDR,
        description: "Soroban smart contract code",
        tags: ["stellar", "code"],
        fileContent: "Content 2",
        signers: [SIGNER_ADDR],
      });

      // Filter by type
      const contracts = docService.searchCatalog({ docType: "contract" });
      expect(contracts.documents).toHaveLength(1);
      expect(contracts.documents[0].title).toBe("Smart Contract Code");

      // Filter by signature status
      const pending = docService.searchCatalog({ signatureStatus: "pending" });
      expect(pending.documents).toHaveLength(1);
      expect(pending.documents[0].title).toBe("Smart Contract Code");

      // Search by keyword
      const keywordSearch = docService.searchCatalog({ query: "album" });
      expect(keywordSearch.documents).toHaveLength(1);
      expect(keywordSearch.documents[0].title).toBe("Music Royalty Agreement");
    });
  });

  describe("Audit Trail and Export", () => {
    test("generates hash-chained immutable audit trail and exports to JSON / CSV", async () => {
      const doc = await docService.createDocument({
        title: "Audit Test Contract",
        ownerAddress: OWNER_ADDR,
        fileContent: "Audit Content",
      });

      await docService.shareDocument(doc.id, {
        collaboratorAddress: COLLAB_ADDR,
        permissionLevel: "download",
        grantedBy: OWNER_ADDR,
      });

      await docService.downloadDocument(doc.id, { userAddress: COLLAB_ADDR });

      const audit = docService.getAuditTrail(doc.id, OWNER_ADDR);
      expect(audit.verified).toBe(true);
      expect(audit.totalEvents).toBeGreaterThanOrEqual(3);

      const jsonExport = docService.exportAuditTrail(doc.id, {
        format: "json",
        userAddress: OWNER_ADDR,
      });
      expect(jsonExport.contentType).toBe("application/json");
      expect(jsonExport.verified).toBe(true);
      expect(jsonExport.data.events.length).toBeGreaterThanOrEqual(3);

      const csvExport = docService.exportAuditTrail(doc.id, {
        format: "csv",
        userAddress: OWNER_ADDR,
      });
      expect(csvExport.contentType).toBe("text/csv");
      expect(csvExport.data).toContain("Timestamp,Action,Performed By");
      expect(csvExport.data).toContain("create");
      expect(csvExport.data).toContain("grant_permission");
      expect(csvExport.data).toContain("download");
    });
  });
});
