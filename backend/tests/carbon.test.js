import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const recordTransactionFootprint = jest.fn(() => ({ emissionId: 1, gramsCo2: 0.5 }));
const getUserFootprint = jest.fn(() => ({ walletAddress: "GAAA", txCount: 0 }));
const getProjectFootprint = jest.fn(() => ({ contractId: "CAAA", txCount: 0 }));
const purchaseOffsets = jest.fn((body) => ({ offsetId: 2, ...body, status: "completed" }));
const getOffsetHistory = jest.fn(() => ({ data: [], total: 0 }));
const getAutoOffsetSettings = jest.fn(() => ({
  walletAddress: "GAAA",
  autoOffsetEnabled: false,
  offsetPercentage: 1,
}));
const saveAutoOffsetSettings = jest.fn((wallet, body) => ({ walletAddress: wallet, ...body }));
const buildSharePayload = jest.fn(() => ({ text: "share", stats: {}, shareUrls: {} }));

await jest.unstable_mockModule("../src/services/carbon-tracker.js", () => ({
  OFFSET_PROJECTS: [{ id: "amazon-reforestation", name: "Amazon", type: "forest" }],
  getUserFootprint,
  getProjectFootprint,
  recordTransactionFootprint,
  purchaseOffsets,
  getOffsetHistory,
  getAutoOffsetSettings,
  saveAutoOffsetSettings,
  buildSharePayload,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 25),
}));

const { carbonRouter } = await import("../src/routes/carbon.js");

import express from "express";

const app = express();
app.use(express.json());
app.use("/api/v1", carbonRouter);

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

describe("Carbon routes (#1064)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("GET /carbon/projects returns the catalog", async () => {
    const res = await request(app).get("/api/v1/carbon/projects");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  test("GET /carbon/footprint/:walletAddress returns personal footprint", async () => {
    const res = await request(app).get(`/api/v1/carbon/footprint/${WALLET}`);

    expect(res.status).toBe(200);
    expect(getUserFootprint).toHaveBeenCalledWith(WALLET, { start: null, end: null });
  });

  test("GET /carbon/footprint rejects invalid wallets and bad dates", async () => {
    expect(await request(app).get("/api/v1/carbon/footprint/not-a-wallet")).toHaveProperty(
      "status",
      400
    );
    const res = await request(app).get(`/api/v1/carbon/footprint/${WALLET}?start=not-a-date`);
    expect(res.status).toBe(400);
  });

  test("GET /carbon/project/:contractId returns project impact", async () => {
    const res = await request(app).get(`/api/v1/carbon/project/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(getProjectFootprint).toHaveBeenCalledWith(CONTRACT, { start: null, end: null });
  });

  test("POST /carbon/record records a footprint", async () => {
    const res = await request(app)
      .post("/api/v1/carbon/record")
      .send({ contractId: CONTRACT, walletAddress: WALLET, txHash: "a".repeat(64) });

    expect(res.status).toBe(201);
    expect(recordTransactionFootprint).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: CONTRACT, walletAddress: WALLET })
    );
  });

  test("POST /carbon/offsets purchases offsets", async () => {
    const res = await request(app)
      .post("/api/v1/carbon/offsets")
      .send({ walletAddress: WALLET, tonnes: 0.01, project: "forest" });

    expect(res.status).toBe(201);
    expect(purchaseOffsets).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: WALLET, tonnes: 0.01 })
    );
  });

  test("POST /carbon/offsets requires tonnes or amountUsdCents", async () => {
    const res = await request(app).post("/api/v1/carbon/offsets").send({ walletAddress: WALLET });

    expect(res.status).toBe(400);
    expect(purchaseOffsets).not.toHaveBeenCalled();
  });

  test("GET /carbon/offsets/:walletAddress lists purchases", async () => {
    const res = await request(app).get(`/api/v1/carbon/offsets/${WALLET}?limit=10`);

    expect(res.status).toBe(200);
    expect(getOffsetHistory).toHaveBeenCalledWith(WALLET, expect.objectContaining({ limit: 10 }));
  });

  test("GET + POST /carbon/settings/:walletAddress manage auto-offset", async () => {
    const getRes = await request(app).get(`/api/v1/carbon/settings/${WALLET}`);
    expect(getRes.status).toBe(200);

    const postRes = await request(app)
      .post(`/api/v1/carbon/settings/${WALLET}`)
      .send({ autoOffsetEnabled: true, offsetPercentage: 2.5 });
    expect(postRes.status).toBe(200);
    expect(saveAutoOffsetSettings).toHaveBeenCalledWith(WALLET, {
      autoOffsetEnabled: true,
      offsetPercentage: 2.5,
    });
  });

  test("GET /carbon/share/:walletAddress returns share payload", async () => {
    const res = await request(app).get(`/api/v1/carbon/share/${WALLET}`);

    expect(res.status).toBe(200);
    expect(buildSharePayload).toHaveBeenCalledWith(WALLET);
    expect(res.body.data.shareUrls).toBeDefined();
  });
});
