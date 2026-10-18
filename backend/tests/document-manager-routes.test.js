/**
 * Document Manager Express Route Integration Tests
 * Issue #1060 - Advanced document management system with IPFS
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import { documentManagerRouter } from "../src/routes/document-manager.js";
import { resetDocumentDatabase } from "../src/database/document-manager.js";
import { ipfsIntegration } from "../src/services/ipfs-integration.js";

describe("Document Manager API Routes (#1060)", () => {
  let app;
  const OWNER = "GAOWNER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const COLLAB = "GACOLLAB1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  beforeEach(() => {
    resetDocumentDatabase();
    ipfsIntegration.clearCache();
    app = express();
    app.use(express.json());
    app.use("/api/v1/documents", documentManagerRouter);
  });

  test("POST /api/v1/documents creates document on IPFS and returns 201", async () => {
    const res = await request(app)
      .post("/api/v1/documents")
      .send({
        title: "Test IPFS Document",
        docType: "contract",
        ownerAddress: OWNER,
        fileContent: "Contract File Contents",
        fileName: "contract.pdf",
        mimeType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.current_cid).toBeDefined();
    expect(res.body.data.current_version).toBe(1);
    expect(res.body.data.gatewayUrl).toBeDefined();
  });

  test("GET /api/v1/documents searches catalog and returns documents with metadata", async () => {
    await request(app)
      .post("/api/v1/documents")
      .send({
        title: "Searchable Doc",
        docType: "agreement",
        ownerAddress: OWNER,
        fileContent: "Agreement Content",
      });

    const res = await request(app)
      .get("/api/v1/documents?query=Searchable")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.documents).toHaveLength(1);
    expect(res.body.data.documents[0].title).toBe("Searchable Doc");
  });

  test("POST /api/v1/documents/ipfs/verify verifies content integrity", async () => {
    const createRes = await request(app)
      .post("/api/v1/documents")
      .send({
        title: "Verify Test",
        ownerAddress: OWNER,
        fileContent: "Exact verification payload",
      });

    const cid = createRes.body.data.current_cid;

    const verifyRes = await request(app)
      .post("/api/v1/documents/ipfs/verify")
      .send({
        cid,
        content: "Exact verification payload",
      })
      .expect(200);

    expect(verifyRes.body.verified).toBe(true);
  });

  test("GET /api/v1/documents/:id returns full document details", async () => {
    const createRes = await request(app)
      .post("/api/v1/documents")
      .send({
        title: "Detail Test",
        ownerAddress: OWNER,
        fileContent: "Content",
      });

    const docId = createRes.body.data.id;

    const getRes = await request(app)
      .get(`/api/v1/documents/${docId}`)
      .set("x-user-id", OWNER)
      .expect(200);

    expect(getRes.body.data.title).toBe("Detail Test");
    expect(getRes.body.data.versions).toHaveLength(1);
  });

  test("POST /api/v1/documents/:id/versions creates new version", async () => {
    const createRes = await request(app)
      .post("/api/v1/documents")
      .send({
        title: "Versioned Doc",
        ownerAddress: OWNER,
        fileContent: "V1",
      });

    const docId = createRes.body.data.id;

    const v2Res = await request(app)
      .post(`/api/v1/documents/${docId}/versions`)
      .send({
        createdBy: OWNER,
        fileContent: "V2 Updated Content",
        changeSummary: "Bumped to v2",
      })
      .expect(201);

    expect(v2Res.body.data.version.version_number).toBe(2);
    expect(v2Res.body.data.document.current_version).toBe(2);
  });

  test("POST /api/v1/documents/:id/share and DELETE /share grants and revokes permissions", async () => {
    const createRes = await request(app)
      .post("/api/v1/documents")
      .send({
        title: "Shareable Doc",
        ownerAddress: OWNER,
        fileContent: "Share me",
      });

    const docId = createRes.body.data.id;

    // Share
    const shareRes = await request(app)
      .post(`/api/v1/documents/${docId}/share`)
      .send({
        grantedBy: OWNER,
        collaboratorAddress: COLLAB,
        permissionLevel: "download",
      })
      .expect(200);

    expect(shareRes.body.data.permission_level).toBe("download");

    // Revoke
    const revokeRes = await request(app)
      .delete(`/api/v1/documents/${docId}/share/${COLLAB}?revokedBy=${OWNER}`)
      .expect(200);

    expect(revokeRes.body.data.success).toBe(true);
  });

  test("POST /api/v1/documents/:id/sign processes digital signature", async () => {
    const createRes = await request(app)
      .post("/api/v1/documents")
      .send({
        title: "Signable Doc",
        ownerAddress: OWNER,
        fileContent: "Sign terms",
        signers: [COLLAB],
      });

    const docId = createRes.body.data.id;

    const signRes = await request(app)
      .post(`/api/v1/documents/${docId}/sign`)
      .send({
        signerAddress: COLLAB,
        signature: "sig_mock_ed25519_12345",
      })
      .expect(200);

    expect(signRes.body.data.success).toBe(true);
    expect(signRes.body.data.documentStatus).toBe("signed");
  });

  test("GET /api/v1/documents/:id/audit-trail and /export returns immutable trail and exports", async () => {
    const createRes = await request(app)
      .post("/api/v1/documents")
      .send({
        title: "Audit Route Doc",
        ownerAddress: OWNER,
        fileContent: "Audit Content",
      });

    const docId = createRes.body.data.id;

    const auditRes = await request(app)
      .get(`/api/v1/documents/${docId}/audit-trail`)
      .set("x-user-id", OWNER)
      .expect(200);

    expect(auditRes.body.data.verified).toBe(true);
    expect(auditRes.body.data.events.length).toBeGreaterThan(0);

    const exportCsvRes = await request(app)
      .get(`/api/v1/documents/${docId}/audit-trail/export?format=csv`)
      .set("x-user-id", OWNER)
      .expect(200);

    expect(exportCsvRes.text).toContain("Timestamp,Action,Performed By");
  });
});
