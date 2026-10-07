/**
 * Tests for SMS notification preferences routes — closes #927.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockGet = jest.fn();
const mockSave = jest.fn();

await jest.unstable_mockModule("../src/database/sms-preferences.js", () => ({
  getSmsPreferences: mockGet,
  saveSmsPreferences: mockSave,
}));

const { smsPreferencesRouter } = await import("../src/routes/notifications/sms.js");

const app = express();
app.use(express.json());
app.use("/api/v1/notifications/sms", smsPreferencesRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const TIMESTAMP = "2026-07-27T10:00:00.000Z";

const prefRecord = (overrides = {}) => ({
  walletAddress: WALLET,
  smsEnabled: 0,
  phoneNumber: null,
  updatedAt: TIMESTAMP,
  ...overrides,
});

describe("GET /api/v1/notifications/sms/preferences", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns stored preferences", async () => {
    mockGet.mockReturnValue(prefRecord({ smsEnabled: 1, phoneNumber: "+15551234567" }));

    const res = await request(app).get(`/api/v1/notifications/sms/preferences?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.smsEnabled).toBe(1);
    expect(res.body.data.phoneNumber).toBe("+15551234567");
    expect(mockGet).toHaveBeenCalledWith(WALLET);
  });

  test("returns opted-out default when no record exists", async () => {
    mockGet.mockReturnValue(null);

    const res = await request(app).get(`/api/v1/notifications/sms/preferences?walletAddress=${WALLET}`);

    expect(res.status).toBe(200);
    expect(res.body.data.smsEnabled).toBe(0);
    expect(res.body.data.phoneNumber).toBe(null);
  });

  test("400 when walletAddress is missing", async () => {
    const res = await request(app).get("/api/v1/notifications/sms/preferences");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("missing_wallet_address");
    expect(mockGet).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is invalid", async () => {
    const res = await request(app).get("/api/v1/notifications/sms/preferences?walletAddress=invalid");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_stellar_address");
  });
});

describe("POST /api/v1/notifications/sms/preferences", () => {
  beforeEach(() => jest.clearAllMocks());

  test("opts in with a valid E.164 phone number", async () => {
    mockSave.mockReturnValue(prefRecord({ smsEnabled: 1, phoneNumber: "+15551234567" }));

    const res = await request(app)
      .post("/api/v1/notifications/sms/preferences")
      .send({ walletAddress: WALLET, smsEnabled: true, phoneNumber: "+15551234567" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.smsEnabled).toBe(1);
    expect(mockSave).toHaveBeenCalledWith(WALLET, { smsEnabled: true, phoneNumber: "+15551234567" });
  });

  test("opts out without requiring a phone number", async () => {
    mockSave.mockReturnValue(prefRecord({ smsEnabled: 0 }));

    const res = await request(app)
      .post("/api/v1/notifications/sms/preferences")
      .send({ walletAddress: WALLET, smsEnabled: false });

    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith(WALLET, { smsEnabled: false, phoneNumber: undefined });
  });

  test("rejects opting in without a phone number on file or supplied", async () => {
    mockGet.mockReturnValue(null);

    const res = await request(app)
      .post("/api/v1/notifications/sms/preferences")
      .send({ walletAddress: WALLET, smsEnabled: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("phone_number_required");
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("allows opting in when a phone number is already on file", async () => {
    mockGet.mockReturnValue(prefRecord({ smsEnabled: 0, phoneNumber: "+15559876543" }));
    mockSave.mockReturnValue(prefRecord({ smsEnabled: 1, phoneNumber: "+15559876543" }));

    const res = await request(app)
      .post("/api/v1/notifications/sms/preferences")
      .send({ walletAddress: WALLET, smsEnabled: true });

    expect(res.status).toBe(200);
    expect(mockSave).toHaveBeenCalledWith(WALLET, { smsEnabled: true, phoneNumber: undefined });
  });

  test("400 when phoneNumber is not valid E.164", async () => {
    const res = await request(app)
      .post("/api/v1/notifications/sms/preferences")
      .send({ walletAddress: WALLET, smsEnabled: true, phoneNumber: "not-a-phone" });

    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is missing", async () => {
    const res = await request(app)
      .post("/api/v1/notifications/sms/preferences")
      .send({ smsEnabled: true, phoneNumber: "+15551234567" });

    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("400 when smsEnabled is missing", async () => {
    const res = await request(app)
      .post("/api/v1/notifications/sms/preferences")
      .send({ walletAddress: WALLET, phoneNumber: "+15551234567" });

    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  test("400 when walletAddress is a contract address", async () => {
    const res = await request(app)
      .post("/api/v1/notifications/sms/preferences")
      .send({
        walletAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        smsEnabled: true,
        phoneNumber: "+15551234567",
      });

    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });
});
