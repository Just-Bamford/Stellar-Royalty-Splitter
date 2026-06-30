import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import StellarSdk from "@stellar/stellar-sdk";

let fakeAuditLogs = [];

const exportAuditLogs = jest.fn((filters = {}, limit = 10000, offset = 0) => {
  let filtered = [...fakeAuditLogs];
  if (filters.contractId) {
    filtered = filtered.filter((x) => x.contractId === filters.contractId);
  }
  if (filters.action) {
    filtered = filtered.filter((x) => x.action === filters.action);
  }
  if (filters.start) {
    filtered = filtered.filter((x) => x.timestamp >= filters.start);
  }
  if (filters.end) {
    filtered = filtered.filter((x) => x.timestamp <= filters.end);
  }
  return filtered.slice(offset, offset + limit);
});

// Mock database module
await jest.unstable_mockModule("../src/database/index.js", () => ({
  exportAuditLogs,
}));

process.env.ADMIN_ROTATE_TOKEN = "test-admin-token";

const { auditExportRouter, stringifyCSV } = await import("../src/routes/audit-export.js");
const { rotateSigningKey, getSigningKeypair } = await import("../src/signing-key.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", auditExportRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe("Audit Log Export System (#424)", () => {
  let testKeypair;

  beforeEach(() => {
    fakeAuditLogs = [
      {
        timestamp: "2026-06-20T10:00:00.000Z",
        action: "initialize",
        contractId: "CA123",
        actor: "G123",
        details: { version: 1 },
      },
      {
        timestamp: "2026-06-21T10:00:00.000Z",
        action: "distribute",
        contractId: "CA456",
        actor: "G456",
        details: { amount: "100" },
      },
      {
        timestamp: "2026-06-22T10:00:00.000Z",
        action: "secondary_royalty",
        contractId: "CA123",
        actor: "G123",
        details: { rate: 5 },
      },
    ];
    jest.clearAllMocks();

    testKeypair = StellarSdk.Keypair.random();
    rotateSigningKey(testKeypair.secret(), { source: "test" });
  });

  test("returns 401 when Authorization header is missing or invalid", async () => {
    const app = makeApp();

    const noAuth = await request(app).get("/api/v1/admin/audit-export");
    expect(noAuth.status).toBe(401);

    const badAuth = await request(app)
      .get("/api/v1/admin/audit-export")
      .set("Authorization", "Bearer wrong-token");
    expect(badAuth.status).toBe(401);
  });

  test("exports audit logs in JSON format with valid signatures", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/audit-export?format=json")
      .set("Authorization", "Bearer test-admin-token");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    // Assert signature headers are set
    const headerSig = res.headers["x-export-signature"];
    const headerPub = res.headers["x-export-public-key"];
    expect(headerSig).toBeDefined();
    expect(headerPub).toBe(testKeypair.publicKey());

    // Verify response body signature using header public key
    const verifyHeaderSig = StellarSdk.Keypair.fromPublicKey(headerPub).verify(
      Buffer.from(res.text, "utf8"),
      Buffer.from(headerSig, "base64")
    );
    expect(verifyHeaderSig).toBe(true);

    // Verify inner payload signature
    const body = JSON.parse(res.text);
    expect(body).toHaveProperty("signature");
    expect(body).toHaveProperty("publicKey");
    expect(body).toHaveProperty("data");

    const innerVerify = StellarSdk.Keypair.fromPublicKey(body.publicKey).verify(
      Buffer.from(JSON.stringify(body.data), "utf8"),
      Buffer.from(body.signature, "base64")
    );
    expect(innerVerify).toBe(true);
    expect(body.data.length).toBe(3);
  });

  test("exports audit logs in CSV format with valid signatures", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/audit-export?format=csv")
      .set("Authorization", "Bearer test-admin-token");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");

    const headerSig = res.headers["x-export-signature"];
    const headerPub = res.headers["x-export-public-key"];
    expect(headerSig).toBeDefined();
    expect(headerPub).toBe(testKeypair.publicKey());

    const verifyHeaderSig = StellarSdk.Keypair.fromPublicKey(headerPub).verify(
      Buffer.from(res.text, "utf8"),
      Buffer.from(headerSig, "base64")
    );
    expect(verifyHeaderSig).toBe(true);

    const lines = res.text.split("\n");
    expect(lines[0]).toBe("timestamp,action,contractId,actor,details");
    expect(lines.length).toBe(4); // Header + 3 records
    expect(lines[1]).toContain("2026-06-20T10:00:00.000Z,initialize,CA123,G123");
  });

  test("supports filtering by date range, contractId, and action", async () => {
    const app = makeApp();
    const res = await request(app)
      .get(
        "/api/v1/admin/audit-export?format=json&start=2026-06-21&end=2026-06-22&contractId=CA123&action=secondary_royalty"
      )
      .set("Authorization", "Bearer test-admin-token");

    expect(res.status).toBe(200);

    expect(exportAuditLogs).toHaveBeenCalledWith(
      {
        start: "2026-06-21T00:00:00.000Z",
        end: "2026-06-22T23:59:59.999Z",
        contractId: "CA123",
        action: "secondary_royalty",
      },
      10000,
      0
    );

    const body = JSON.parse(res.text);
    expect(body.data.length).toBe(1);
    expect(body.data[0].action).toBe("secondary_royalty");
  });

  test("supports limit and offset pagination", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/audit-export?format=json&limit=2&offset=1")
      .set("Authorization", "Bearer test-admin-token");

    expect(res.status).toBe(200);
    expect(exportAuditLogs).toHaveBeenCalledWith(
      {
        start: undefined,
        end: undefined,
        contractId: undefined,
        action: undefined,
      },
      2,
      1
    );

    const body = JSON.parse(res.text);
    expect(body.data.length).toBe(2);
    expect(body.data[0].action).toBe("distribute");
  });
});
