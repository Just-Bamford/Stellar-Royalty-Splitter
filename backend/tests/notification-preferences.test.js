/**
 * Tests for contributor notification preferences routes — closes #605.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockGet  = jest.fn();
const mockSave = jest.fn();

await jest.unstable_mockModule("../src/database/notification-preferences.js", () => ({
  getNotificationPreferences:  mockGet,
  saveNotificationPreferences: mockSave,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getNotificationPreferences:  mockGet,
  saveNotificationPreferences: mockSave,
  initializeDatabase:          jest.fn(),
  getMigrationVersion:         jest.fn(() => 11),
}));

const { notificationPreferencesRouter } = await import("../src/routes/notification-preferences.js");

const app = express();
app.use(express.json());
app.use("/api/v1/preferences", notificationPreferencesRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const WALLET = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TIMESTAMP = "2026-07-27T10:00:00.000Z";

const prefRecord = (overrides = {}) => ({
  walletAddress: WALLET,
  email: 1,
  sms:   0,
  inApp: 1,
  push:  0,
  updatedAt: TIMESTAMP,
  ...overrides,
});

describe("GET /api/v1/preferences/notifications", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns stored preferences", async () => {
    mockGet.mockReturnValue(prefRecord());

    const res = await request(app)
      .get(`/api/v1/preferences/notifications?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe(1);
    expect(res.body.data.sms).toBe(0);
    expect(mockGet).toHaveBeenCalledWith(WALLET);
  });

  test("returns default opt-in set when no record exists", async () => {
    mockGet.mockReturnValue(null);

    const res = await request(app)
      .get(`/api/v1/preferences/notifications?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(1);
    expect(res.body.data.inApp).toBe(1);
    expect(res.body.data.sms).toBe(0);
    expect(res.body.data.push).toBe(0);
  });

  test("400 when walletAddress is missing", async () => {
    const res = await request(app).get("/api/v1/preferences/notifications");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_wallet_address");
    expect(mockGet).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is invalid", async () => {
    const res = await request(app)
      .get("/api/v1/preferences/notifications?walletAddress=invalid");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_stellar_address");
  });
});

describe("POST /api/v1/preferences/notifications", () => {
  beforeEach(() => jest.clearAllMocks());

  test("saves preferences and returns the record", async () => {
    mockSave.mockReturnValue(prefRecord({ sms: 1 }));

    const res = await request(app)
      .post("/api/v1/preferences/notifications")
      .send({ walletAddress: WALLET, sms: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockSave).toHaveBeenCalledWith(WALLET, { sms: true });
  });

  test("can turn off email notifications", async () => {
    mockSave.mockReturnValue(prefRecord({ email: 0 }));

    const res = await request(app)
      .post("/api/v1/preferences/notifications")
      .send({ walletAddress: WALLET, email: false });

    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith(WALLET, { email: false });
  });

  test("can update multiple channels at once", async () => {
    mockSave.mockReturnValue(prefRecord({ sms: 1, push: 1 }));

    const res = await request(app)
      .post("/api/v1/preferences/notifications")
      .send({ walletAddress: WALLET, sms: true, push: true });

    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith(WALLET, { sms: true, push: true });
  });

  test("400 when no channel keys are provided", async () => {
    const res = await request(app)
      .post("/api/v1/preferences/notifications")
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("no_channels_provided");
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is missing", async () => {
    const res = await request(app)
      .post("/api/v1/preferences/notifications")
      .send({ email: true });

    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is a contract address", async () => {
    const res = await request(app)
      .post("/api/v1/preferences/notifications")
      .send({ walletAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", email: true });

    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });
});
