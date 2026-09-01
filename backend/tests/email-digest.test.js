import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const mockSubscribe = jest.fn();
const mockUnsubscribeByToken = jest.fn();
const mockGetSubscriberByToken = jest.fn();
const mockGetSubscriberByWallet = jest.fn();
const mockUpdatePreferences = jest.fn();
const mockGetDigestHistory = jest.fn();

await jest.unstable_mockModule("../src/database/email-digest.js", () => ({
  subscribeEmailDigest: mockSubscribe,
  unsubscribeByEmailDigest: mockUnsubscribeByToken,
  getSubscriberByToken: mockGetSubscriberByToken,
  getSubscriberByWallet: mockGetSubscriberByWallet,
  updateSubscriberPreferences: mockUpdatePreferences,
  getDigestHistory: mockGetDigestHistory,
}));

await jest.unstable_mockModule("../src/email/email-service.js", () => ({
  isEmailConfigured: jest.fn(() => true),
  sendEmail: jest.fn(),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 6),
}));

const { default: emailDigestRouter } = await import("../src/routes/email-digest.js");

import express from "express";

const app = express();
app.use(express.json());
app.use("/api/v1", emailDigestRouter);

const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";
const EMAIL = "test@example.com";
const TOKEN = "abc123def456";

describe("Email digest routes (#569)", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("POST /email-digest/subscribe", () => {
    test("subscribes with valid data", async () => {
      mockSubscribe.mockReturnValue({
        id: 1,
        walletAddress: WALLET,
        email: EMAIL,
        timezone: "America/New_York",
        dayOfWeek: 0,
        hourOfDay: 9,
        enabled: 1,
        unsubscribeToken: TOKEN,
      });

      const res = await request(app)
        .post("/api/v1/email-digest/subscribe")
        .send({ walletAddress: WALLET, email: EMAIL, timezone: "America/New_York" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.subscriber.email).toBe(EMAIL);
      expect(res.body.subscriber.timezone).toBe("America/New_York");
      expect(mockSubscribe).toHaveBeenCalled();
    });

    test("rejects invalid email", async () => {
      const res = await request(app)
        .post("/api/v1/email-digest/subscribe")
        .send({ walletAddress: WALLET, email: "not-an-email" });

      expect(res.status).toBe(400);
      expect(mockSubscribe).not.toHaveBeenCalled();
    });

    test("rejects invalid wallet address", async () => {
      const res = await request(app)
        .post("/api/v1/email-digest/subscribe")
        .send({ walletAddress: "INVALID", email: EMAIL });

      expect(res.status).toBe(400);
      expect(mockSubscribe).not.toHaveBeenCalled();
    });

    test("rejects dayOfWeek out of range", async () => {
      const res = await request(app)
        .post("/api/v1/email-digest/subscribe")
        .send({ walletAddress: WALLET, email: EMAIL, dayOfWeek: 8 });

      expect(res.status).toBe(400);
      expect(mockSubscribe).not.toHaveBeenCalled();
    });

    test("rejects hourOfDay out of range", async () => {
      const res = await request(app)
        .post("/api/v1/email-digest/subscribe")
        .send({ walletAddress: WALLET, email: EMAIL, hourOfDay: 25 });

      expect(res.status).toBe(400);
      expect(mockSubscribe).not.toHaveBeenCalled();
    });
  });

  describe("GET /email-digest/preferences/:walletAddress", () => {
    test("returns subscriber preferences", async () => {
      mockGetSubscriberByWallet.mockReturnValue({
        walletAddress: WALLET,
        email: EMAIL,
        timezone: "UTC",
        dayOfWeek: 0,
        hourOfDay: 9,
        enabled: 1,
      });

      const res = await request(app).get(`/api/v1/email-digest/preferences/${WALLET}`);

      expect(res.status).toBe(200);
      expect(res.body.subscriber.email).toBe(EMAIL);
    });

    test("returns 404 for unknown wallet", async () => {
      mockGetSubscriberByWallet.mockReturnValue(null);

      const res = await request(app).get(`/api/v1/email-digest/preferences/${WALLET}`);

      expect(res.status).toBe(404);
    });

    test("rejects invalid wallet address", async () => {
      const res = await request(app).get("/api/v1/email-digest/preferences/INVALID");

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /email-digest/preferences", () => {
    test("updates preferences", async () => {
      mockUpdatePreferences.mockReturnValue(true);

      const res = await request(app)
        .put("/api/v1/email-digest/preferences")
        .send({ walletAddress: WALLET, timezone: "Europe/London", hourOfDay: 14 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUpdatePreferences).toHaveBeenCalledWith({
        walletAddress: WALLET,
        email: null,
        timezone: "Europe/London",
        dayOfWeek: null,
        hourOfDay: 14,
      });
    });

    test("returns 404 when no active subscription", async () => {
      mockUpdatePreferences.mockReturnValue(false);

      const res = await request(app)
        .put("/api/v1/email-digest/preferences")
        .send({ walletAddress: WALLET, timezone: "Europe/London" });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /email-digest/unsubscribe", () => {
    test("unsubscribes with valid token", async () => {
      mockGetSubscriberByToken.mockReturnValue({ id: 1, enabled: 1 });
      mockUnsubscribeByToken.mockReturnValue(true);

      const res = await request(app)
        .post("/api/v1/email-digest/unsubscribe")
        .send({ token: TOKEN });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUnsubscribeByToken).toHaveBeenCalledWith(TOKEN);
    });

    test("returns success if already unsubscribed", async () => {
      mockGetSubscriberByToken.mockReturnValue({ id: 1, enabled: 0 });

      const res = await request(app)
        .post("/api/v1/email-digest/unsubscribe")
        .send({ token: TOKEN });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("Already");
    });

    test("returns 404 for invalid token", async () => {
      mockGetSubscriberByToken.mockReturnValue(null);

      const res = await request(app)
        .post("/api/v1/email-digest/unsubscribe")
        .send({ token: "invalid" });

      expect(res.status).toBe(404);
    });

    test("rejects missing token", async () => {
      const res = await request(app)
        .post("/api/v1/email-digest/unsubscribe")
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe("GET /email-digest/history/:walletAddress", () => {
    test("returns digest history", async () => {
      mockGetSubscriberByWallet.mockReturnValue({ id: 1, walletAddress: WALLET });
      mockGetDigestHistory.mockReturnValue([
        {
          id: 1,
          weekStart: "2026-07-20",
          weekEnd: "2026-07-26",
          sentAt: "2026-07-27T09:00:00Z",
          status: "sent",
          earningsSummary: JSON.stringify({ totalEarned: 1.5, payoutCount: 3 }),
        },
      ]);

      const res = await request(app).get(`/api/v1/email-digest/history/${WALLET}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].earningsSummary.totalEarned).toBe(1.5);
    });

    test("returns 404 for unknown wallet", async () => {
      mockGetSubscriberByWallet.mockReturnValue(null);

      const res = await request(app).get(`/api/v1/email-digest/history/${WALLET}`);

      expect(res.status).toBe(404);
    });
  });
});
