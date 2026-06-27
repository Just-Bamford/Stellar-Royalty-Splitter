import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const buildAndRecordTransaction = jest.fn();
const stellarImport = {
  addressToScVal: jest.fn((a) => ({ type: "address", value: a })),
  vecToScVal: jest.fn((v) => ({ type: "vec", value: v })),
  u32ToScVal: jest.fn((n) => ({ type: "u32", value: n })),
};

await jest.unstable_mockModule("../src/routes/_shared.js", () => ({
  buildAndRecordTransaction,
}));
await jest.unstable_mockModule("../src/stellar.js", () => stellarImport);
await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 5),
  createApiKey: jest.fn(),
  listApiKeys: jest.fn(() => []),
  revokeApiKey: jest.fn(() => false),
}));

const { adminRouter } = await import("../src/routes/admin.js");

const app = express();
app.use(express.json());
app.use("/api/v1/admin", adminRouter);

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ADMIN1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ADMIN2 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ADMIN3 = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

describe("POST /admin/set-admins — multi-sig enforcement (#404)", () => {
  beforeEach(() => {
    buildAndRecordTransaction.mockReset();
    buildAndRecordTransaction.mockResolvedValue({ xdr: "xdr==", transactionId: 42 });
  });

  test("accepts valid 2-of-3 multi-sig configuration", async () => {
    const res = await request(app)
      .post("/api/v1/admin/set-admins")
      .send({ contractId: CONTRACT, walletAddress: WALLET, admins: [ADMIN1, ADMIN2, ADMIN3], threshold: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, adminCount: 3, threshold: 2 });
  });

  test("accepts 1-of-1 single admin (backwards compatible)", async () => {
    const res = await request(app)
      .post("/api/v1/admin/set-admins")
      .send({ contractId: CONTRACT, walletAddress: WALLET, admins: [ADMIN1], threshold: 1 });

    expect(res.status).toBe(200);
    expect(res.body.threshold).toBe(1);
    expect(res.body.adminCount).toBe(1);
  });

  test("accepts 3-of-3 unanimous multi-sig", async () => {
    const res = await request(app)
      .post("/api/v1/admin/set-admins")
      .send({ contractId: CONTRACT, walletAddress: WALLET, admins: [ADMIN1, ADMIN2, ADMIN3], threshold: 3 });

    expect(res.status).toBe(200);
    expect(res.body.threshold).toBe(3);
  });

  test("rejects threshold exceeding admin count", async () => {
    const res = await request(app)
      .post("/api/v1/admin/set-admins")
      .send({ contractId: CONTRACT, walletAddress: WALLET, admins: [ADMIN1, ADMIN2], threshold: 3 });

    expect(res.status).toBe(400);
  });

  test("rejects empty admins list", async () => {
    const res = await request(app)
      .post("/api/v1/admin/set-admins")
      .send({ contractId: CONTRACT, walletAddress: WALLET, admins: [], threshold: 1 });

    expect(res.status).toBe(400);
  });

  test("rejects threshold of 0", async () => {
    const res = await request(app)
      .post("/api/v1/admin/set-admins")
      .send({ contractId: CONTRACT, walletAddress: WALLET, admins: [ADMIN1], threshold: 0 });

    expect(res.status).toBe(400);
  });

  test("rejects missing contractId", async () => {
    const res = await request(app)
      .post("/api/v1/admin/set-admins")
      .send({ walletAddress: WALLET, admins: [ADMIN1], threshold: 1 });

    expect(res.status).toBe(400);
  });

  test("rejects invalid Stellar address in admins list", async () => {
    const res = await request(app)
      .post("/api/v1/admin/set-admins")
      .send({ contractId: CONTRACT, walletAddress: WALLET, admins: ["not-an-address"], threshold: 1 });

    expect(res.status).toBe(400);
  });

  test("calls buildAndRecordTransaction with correct adminCount and threshold", async () => {
    await request(app)
      .post("/api/v1/admin/set-admins")
      .send({ contractId: CONTRACT, walletAddress: WALLET, admins: [ADMIN1, ADMIN2], threshold: 2 });

    expect(buildAndRecordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: CONTRACT,
        auditAction: "set_admins",
        auditMetadata: { adminCount: 2, threshold: 2 },
      }),
    );
  });
});
