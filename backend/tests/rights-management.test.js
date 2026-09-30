import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

import {
  initializeRightsTables,
  clearRightsTables,
  createRightRecord,
  getRightById,
  getRightsByContract as dbGetRightsByContract,
  updateRightRecord,
  deleteRightRecord,
} from "../src/database/rights-schema.js";

import {
  createRight,
  getRightDetails,
  getRightsByContract,
  getRightsByOwner,
  updateRight,
  deleteRight,
  setRightMetadata,
  validateDDEXMetadata,
  validateISO20022Metadata,
  submitVerificationProof,
  verifyOwnership,
  verifyContractDistributionEligibility,
  linkRightToDispute,
  getRightsForDispute,
  getRightsHistory,
} from "../src/services/rights-management.js";

import { rightsRouter } from "../src/routes/rights-management.js";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OWNER1 = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const OWNER2 = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

const app = express();
app.use(express.json());
app.use("/api/v1/rights", rightsRouter);

describe("Rights Management System", () => {
  beforeEach(() => {
    initializeRightsTables();
    clearRightsTables();
  });

  describe("Service & Database Operations", () => {
    test("creates rights entries with valid types and terms", () => {
      const right1 = createRight({
        contractId: CONTRACT,
        rightType: "composition",
        ownerAddress: OWNER1,
        percentage: 60,
        licenseTerms: "commercial",
      });

      expect(right1).toBeDefined();
      expect(right1.contractId).toBe(CONTRACT);
      expect(right1.rightType).toBe("composition");
      expect(right1.ownerAddress).toBe(OWNER1);
      expect(right1.percentage).toBe(60);
      expect(right1.licenseTerms).toBe("commercial");
      expect(right1.status).toBe("unverified");
      expect(right1.isVerified).toBe(false);

      const right2 = createRight({
        contractId: CONTRACT,
        rightType: "composition",
        ownerAddress: OWNER2,
        percentage: 40,
        licenseTerms: "commercial",
      });

      expect(right2.percentage).toBe(40);
    });

    test("prevents total allocation from exceeding 100% per right type", () => {
      createRight({
        contractId: CONTRACT,
        rightType: "performance",
        ownerAddress: OWNER1,
        percentage: 70,
        licenseTerms: "commercial",
      });

      expect(() => {
        createRight({
          contractId: CONTRACT,
          rightType: "performance",
          ownerAddress: OWNER2,
          percentage: 40,
          licenseTerms: "commercial",
        });
      }).toThrow(/Total percentage for right type 'performance' cannot exceed 100%/);
    });

    test("validates DDEX and ISO 20022 metadata standards", () => {
      // DDEX validation
      const validDDEX = validateDDEXMetadata({
        iswc: "T-123456789-C",
        isrc: "US-S1Z-22-00001",
        partyId: "PADPIDA2022010101",
      });
      expect(validDDEX.valid).toBe(true);

      const invalidDDEX = validateDDEXMetadata({
        iswc: "INVALID-ISWC",
      });
      expect(invalidDDEX.valid).toBe(false);
      expect(invalidDDEX.errors.length).toBeGreaterThan(0);

      // ISO 20022 validation
      const validISO = validateISO20022Metadata({
        messageIdentifier: "pacs.008.001.08",
        businessService: "swift.cbprplus.01",
      });
      expect(validISO.valid).toBe(true);
    });

    test("attaches metadata to rights record", () => {
      const right = createRight({
        contractId: CONTRACT,
        rightType: "mechanical",
        ownerAddress: OWNER1,
        percentage: 50,
      });

      const metadata = setRightMetadata(right.id, {
        ddex: {
          iswc: "T-123456789-C",
          resourceType: "SoundRecording",
        },
        iso20022: {
          messageIdentifier: "pacs.008.001.08",
        },
        customFields: {
          publisher: "Stellar Music Publishing",
          genre: "Electronic",
        },
      });

      expect(metadata).toBeDefined();
      expect(metadata.ddex.iswc).toBe("T-123456789-C");
      expect(metadata.customFields.publisher).toBe("Stellar Music Publishing");

      const details = getRightDetails(right.id);
      expect(details.metadata).toBeDefined();
      expect(details.metadata.ddex.resourceType).toBe("SoundRecording");
    });

    test("handles ownership verification workflow", () => {
      const right = createRight({
        contractId: CONTRACT,
        rightType: "sync",
        ownerAddress: OWNER1,
        percentage: 100,
      });

      // Submit proof document
      const proof = submitVerificationProof(right.id, {
        documentName: "Sync License Agreement 2026",
        documentType: "contract",
        documentUrl: "https://documents.example.com/sync-license.pdf",
        documentHash: "0x123456789abcdef",
      });

      expect(proof).toBeDefined();
      expect(proof.status).toBe("pending");

      // Details show pending status
      let details = getRightDetails(right.id);
      expect(details.status).toBe("pending");

      // Verify ownership
      const verification = verifyOwnership(right.id, {
        proofId: proof.id,
        approved: true,
        verifierAddress: "GADMIN123456789",
        verifierNotes: "Verified against copyright register",
      });

      expect(verification.right.status).toBe("verified");
      expect(verification.right.isVerified).toBe(true);

      details = getRightDetails(right.id);
      expect(details.isVerified).toBe(true);
    });

    test("checks contract distribution eligibility", () => {
      // Setup contract with unverified rights
      const r1 = createRight({
        contractId: CONTRACT,
        rightType: "composition",
        ownerAddress: OWNER1,
        percentage: 50,
      });
      const r2 = createRight({
        contractId: CONTRACT,
        rightType: "composition",
        ownerAddress: OWNER2,
        percentage: 50,
      });

      // Ineligible because unverified
      let eligibility = verifyContractDistributionEligibility(CONTRACT);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons.some((r) => r.includes("unverified"))).toBe(true);

      // Verify both
      verifyOwnership(r1.id, { approved: true });
      verifyOwnership(r2.id, { approved: true });

      // Now eligible
      eligibility = verifyContractDistributionEligibility(CONTRACT);
      expect(eligibility.eligible).toBe(true);
      expect(eligibility.reasons.length).toBe(0);
    });

    test("tracks historical change logs and links disputes", () => {
      const right = createRight({
        contractId: CONTRACT,
        rightType: "composition",
        ownerAddress: OWNER1,
        percentage: 100,
      });

      updateRight(right.id, { percentage: 80 }, "OWNER1", "Sold 20% share");

      const history = getRightsHistory(CONTRACT, right.id);
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history[0].action).toBe("update");
      expect(history[0].reason).toBe("Sold 20% share");

      // Link dispute
      const disputeLink = linkRightToDispute(right.id, "DSP-8899AABB", "Ownership percentage dispute");
      expect(disputeLink.ticketId).toBe("DSP-8899AABB");

      const disputeRights = getRightsForDispute("DSP-8899AABB");
      expect(disputeRights.length).toBe(1);
      expect(disputeRights[0].id).toBe(right.id);
    });
  });

  describe("REST API Endpoints", () => {
    test("POST /api/v1/rights creates a right", async () => {
      const res = await request(app)
        .post("/api/v1/rights")
        .send({
          contractId: CONTRACT,
          rightType: "mechanical",
          ownerAddress: OWNER1,
          percentage: 40,
          licenseTerms: "commercial",
        });

      expect(res.status).toBe(201);
      expect(res.body.rightType).toBe("mechanical");
      expect(res.body.percentage).toBe(40);
    });

    test("GET /api/v1/rights/contract/:contractId returns breakdown", async () => {
      await request(app)
        .post("/api/v1/rights")
        .send({
          contractId: CONTRACT,
          rightType: "performance",
          ownerAddress: OWNER1,
          percentage: 100,
        });

      const res = await request(app).get(`/api/v1/rights/contract/${CONTRACT}`);
      expect(res.status).toBe(200);
      expect(res.body.contractId).toBe(CONTRACT);
      expect(res.body.breakdown.performance.totalPercentage).toBe(100);
    });

    test("POST /api/v1/rights/:id/metadata attaches DDEX and custom metadata", async () => {
      const createRes = await request(app)
        .post("/api/v1/rights")
        .send({
          contractId: CONTRACT,
          rightType: "composition",
          ownerAddress: OWNER1,
          percentage: 100,
        });

      const rightId = createRes.body.id;

      const metaRes = await request(app)
        .post(`/api/v1/rights/${rightId}/metadata`)
        .send({
          ddex: {
            iswc: "T-987654321-A",
            territory: "Worldwide",
          },
          customFields: {
            label: "Stellar Records",
          },
        });

      expect(metaRes.status).toBe(200);
      expect(metaRes.body.ddex.iswc).toBe("T-987654321-A");

      const getMeta = await request(app).get(`/api/v1/rights/${rightId}/metadata`);
      expect(getMeta.status).toBe(200);
      expect(getMeta.body.customFields.label).toBe("Stellar Records");
    });

    test("POST /api/v1/rights/:id/proof and /verify executes verification workflow", async () => {
      const createRes = await request(app)
        .post("/api/v1/rights")
        .send({
          contractId: CONTRACT,
          rightType: "sync",
          ownerAddress: OWNER1,
          percentage: 100,
        });

      const rightId = createRes.body.id;

      const proofRes = await request(app)
        .post(`/api/v1/rights/${rightId}/proof`)
        .send({
          documentName: "Contract Agreement",
          documentType: "contract",
          documentUrl: "https://storage.example.com/contract.pdf",
        });

      expect(proofRes.status).toBe(201);
      const proofId = proofRes.body.id;

      const verifyRes = await request(app)
        .post(`/api/v1/rights/${rightId}/verify`)
        .send({
          proofId,
          approved: true,
          verifierNotes: "All signatures confirmed",
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.right.isVerified).toBe(true);

      const eligibilityRes = await request(app).get(`/api/v1/rights/contract/${CONTRACT}/eligibility`);
      expect(eligibilityRes.status).toBe(200);
      expect(eligibilityRes.body.eligible).toBe(true);
    });

    test("POST /api/v1/rights/:id/dispute links dispute ticket", async () => {
      const createRes = await request(app)
        .post("/api/v1/rights")
        .send({
          contractId: CONTRACT,
          rightType: "composition",
          ownerAddress: OWNER1,
          percentage: 100,
        });

      const rightId = createRes.body.id;

      const linkRes = await request(app)
        .post(`/api/v1/rights/${rightId}/dispute`)
        .send({
          ticketId: "DSP-12345678",
          notes: "Disputing copyright share",
        });

      expect(linkRes.status).toBe(201);

      const disputeRightsRes = await request(app).get("/api/v1/rights/dispute/DSP-12345678");
      expect(disputeRightsRes.status).toBe(200);
      expect(disputeRightsRes.body.rights.length).toBe(1);
    });
  });
});
