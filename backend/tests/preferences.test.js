/**
 * Tests for the payment preferences route — closes #584.
 *
 * Covers: select, change, persist, validation, and 404-not-found paths.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mock database helpers ────────────────────────────────────────────────

const mockGetPaymentPreference = jest.fn();
const mockSavePaymentPreference = jest.fn();

await jest.unstable_mockModule("../src/database/payment-preferences.js", () => ({
  getPaymentPreference: mockGetPaymentPreference,
  savePaymentPreference: mockSavePaymentPreference,
}));

// The preferences route imports from database/index.js which re-exports
// payment-preferences.js, so we mock the index barrel as well.
await jest.unstable_mockModule("../src/database/index.js", () => ({
  getPaymentPreference: mockGetPaymentPreference,
  savePaymentPreference: mockSavePaymentPreference,
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 5),
}));

// ─── Build a minimal Express app with only the preferences route ──────────

import express from "express";
const { preferencesRouter } = await import("../src/routes/preferences.js");

const app = express();
app.use(express.json());
app.use("/api/v1/preferences", preferencesRouter);

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ─── Test data ────────────────────────────────────────────────────────────

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const TIMESTAMP = "2026-07-24T12:00:00.000Z";

const prefRecord = (method) => ({
  walletAddress: WALLET,
  paymentMethod: method,
  updatedAt: TIMESTAMP,
});

// ─── GET /api/v1/preferences/payment ─────────────────────────────────────

describe("GET /api/v1/preferences/payment", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns saved preference for a wallet address", async () => {
    mockGetPaymentPreference.mockReturnValue(prefRecord("xlm"));

    const res = await request(app)
      .get(`/api/v1/preferences/payment?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      walletAddress: WALLET,
      paymentMethod: "xlm",
      updatedAt: TIMESTAMP,
    });
    expect(mockGetPaymentPreference).toHaveBeenCalledWith(WALLET);
  });

  test("returns direct_transfer preference correctly", async () => {
    mockGetPaymentPreference.mockReturnValue(prefRecord("direct_transfer"));

    const res = await request(app)
      .get(`/api/v1/preferences/payment?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.data.paymentMethod).toBe("direct_transfer");
  });

  test("returns usdc preference correctly", async () => {
    mockGetPaymentPreference.mockReturnValue(prefRecord("usdc"));

    const res = await request(app)
      .get(`/api/v1/preferences/payment?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.data.paymentMethod).toBe("usdc");
  });

  test("404 when no preference exists for wallet", async () => {
    mockGetPaymentPreference.mockReturnValue(null);

    const res = await request(app)
      .get(`/api/v1/preferences/payment?walletAddress=${WALLET}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "preference_not_found" });
  });

  test("400 when walletAddress query param is missing", async () => {
    const res = await request(app).get("/api/v1/preferences/payment");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "missing_wallet_address" });
    expect(mockGetPaymentPreference).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is not a valid Stellar address", async () => {
    const res = await request(app)
      .get("/api/v1/preferences/payment?walletAddress=not-a-valid-address");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_stellar_address" });
    expect(mockGetPaymentPreference).not.toHaveBeenCalled();
  });
});

// ─── POST /api/v1/preferences/payment ────────────────────────────────────

describe("POST /api/v1/preferences/payment", () => {
  beforeEach(() => jest.clearAllMocks());

  test("saves xlm preference and returns saved record", async () => {
    mockSavePaymentPreference.mockReturnValue(prefRecord("xlm"));

    const res = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ walletAddress: WALLET, paymentMethod: "xlm" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      walletAddress: WALLET,
      paymentMethod: "xlm",
    });
    expect(mockSavePaymentPreference).toHaveBeenCalledWith(WALLET, "xlm");
  });

  test("saves direct_transfer preference", async () => {
    mockSavePaymentPreference.mockReturnValue(prefRecord("direct_transfer"));

    const res = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ walletAddress: WALLET, paymentMethod: "direct_transfer" });

    expect(res.status).toBe(200);
    expect(res.body.data.paymentMethod).toBe("direct_transfer");
    expect(mockSavePaymentPreference).toHaveBeenCalledWith(WALLET, "direct_transfer");
  });

  test("saves usdc preference", async () => {
    mockSavePaymentPreference.mockReturnValue(prefRecord("usdc"));

    const res = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ walletAddress: WALLET, paymentMethod: "usdc" });

    expect(res.status).toBe(200);
    expect(res.body.data.paymentMethod).toBe("usdc");
  });

  test("persists a preference change — xlm → usdc", async () => {
    // First save: xlm
    mockSavePaymentPreference.mockReturnValueOnce(prefRecord("xlm"));
    const first = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ walletAddress: WALLET, paymentMethod: "xlm" });
    expect(first.body.data.paymentMethod).toBe("xlm");

    // Change to: usdc
    mockSavePaymentPreference.mockReturnValueOnce(prefRecord("usdc"));
    const second = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ walletAddress: WALLET, paymentMethod: "usdc" });
    expect(second.status).toBe(200);
    expect(second.body.data.paymentMethod).toBe("usdc");
    expect(mockSavePaymentPreference).toHaveBeenNthCalledWith(2, WALLET, "usdc");
  });

  test("400 when walletAddress is missing from body", async () => {
    const res = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ paymentMethod: "xlm" });

    expect(res.status).toBe(400);
    expect(mockSavePaymentPreference).not.toHaveBeenCalled();
  });

  test("400 when paymentMethod is missing from body", async () => {
    const res = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(400);
    expect(mockSavePaymentPreference).not.toHaveBeenCalled();
  });

  test("400 when paymentMethod is an unknown value", async () => {
    const res = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ walletAddress: WALLET, paymentMethod: "bitcoin" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(mockSavePaymentPreference).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is not a valid G-address", async () => {
    const res = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ walletAddress: "invalid", paymentMethod: "xlm" });

    expect(res.status).toBe(400);
    expect(mockSavePaymentPreference).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is a contract (C-address) instead of a wallet", async () => {
    const contractAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const res = await request(app)
      .post("/api/v1/preferences/payment")
      .send({ walletAddress: contractAddr, paymentMethod: "xlm" });

    expect(res.status).toBe(400);
    expect(mockSavePaymentPreference).not.toHaveBeenCalled();
  });
});
