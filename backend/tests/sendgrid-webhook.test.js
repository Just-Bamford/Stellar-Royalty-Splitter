/**
 * Tests for /api/v1/webhooks/sendgrid
 *
 * Covers:
 *   - Accepts valid event batch (no secret configured)
 *   - Rejects non-array body
 *   - Returns 200 with processed count on success
 *   - Signature verification (valid, missing, invalid)
 *   - Empty batch returns zero processed
 *   - Delegates to processSendGridWebhookEvents
 */

import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import crypto from "crypto";

// ─── Mock the SendGrid service ────────────────────────────────────────────────

const mockProcessEvents = jest.fn();

jest.unstable_mockModule("../src/services/sendgrid.js", () => ({
  processSendGridWebhookEvents: mockProcessEvents,
  isSendGridConfigured: jest.fn(() => true),
  getEmailStatus: jest.fn(() => ({ status: "valid", updatedAt: null })),
  setEmailStatus: jest.fn(),
  sendEmailViaSendGrid: jest.fn(),
  sendPayoutConfirmationEmail: jest.fn(),
  sendAlertEmailViaSendGrid: jest.fn(),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 6),
}));

const { sendgridWebhookRouter } = await import("../src/routes/webhooks/sendgrid.js");

// ─── Test app ─────────────────────────────────────────────────────────────────

const app = express();
// Stash raw body for signature verification (mirrors index.js setup)
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);
app.use("/api/v1/webhooks/sendgrid", sendgridWebhookRouter);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SAMPLE_EVENTS = [
  { email: "a@example.com", event: "delivered", timestamp: 1700000000 },
  { email: "b@example.com", event: "bounce", type: "bounce", timestamp: 1700000000 },
];

const WEBHOOK_SECRET = "test-webhook-secret-abc";

function makeSignature(body, secret) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/webhooks/sendgrid", () => {
  const savedSecret = process.env.SENDGRID_WEBHOOK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SENDGRID_WEBHOOK_SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.SENDGRID_WEBHOOK_SECRET;
    else process.env.SENDGRID_WEBHOOK_SECRET = savedSecret;
  });

  // ── No secret configured (development mode) ────────────────────────────────

  test("processes events and returns 200 when no secret is configured", async () => {
    mockProcessEvents.mockReturnValue({ processed: 2, errors: 0 });

    const res = await request(app)
      .post("/api/v1/webhooks/sendgrid")
      .send(SAMPLE_EVENTS)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.processed).toBe(2);
    expect(res.body.errors).toBe(0);
    expect(mockProcessEvents).toHaveBeenCalledWith(SAMPLE_EVENTS);
  });

  test("returns 200 with processed=0 for empty batch", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/sendgrid")
      .send([])
      .expect(200);

    expect(res.body.processed).toBe(0);
    expect(mockProcessEvents).not.toHaveBeenCalled();
  });

  test("returns 400 when body is not an array", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/sendgrid")
      .send({ event: "delivered" })
      .expect(400);

    expect(res.body.code).toBe("invalid_payload");
    expect(mockProcessEvents).not.toHaveBeenCalled();
  });

  // ── Signature verification ────────────────────────────────────────────────

  test("accepts request with valid HMAC signature", async () => {
    process.env.SENDGRID_WEBHOOK_SECRET = WEBHOOK_SECRET;
    mockProcessEvents.mockReturnValue({ processed: 2, errors: 0 });

    const body = JSON.stringify(SAMPLE_EVENTS);
    const sig = makeSignature(body, WEBHOOK_SECRET);

    const res = await request(app)
      .post("/api/v1/webhooks/sendgrid")
      .set("Content-Type", "application/json")
      .set("X-Twilio-Email-Event-Webhook-Signature", sig)
      .send(body)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.processed).toBe(2);
  });

  test("rejects request with missing signature when secret is configured", async () => {
    process.env.SENDGRID_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const res = await request(app)
      .post("/api/v1/webhooks/sendgrid")
      .send(SAMPLE_EVENTS)
      .expect(401);

    expect(res.body.code).toBe("missing_signature");
    expect(mockProcessEvents).not.toHaveBeenCalled();
  });

  test("rejects request with invalid signature when secret is configured", async () => {
    process.env.SENDGRID_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const res = await request(app)
      .post("/api/v1/webhooks/sendgrid")
      .set("X-Twilio-Email-Event-Webhook-Signature", "bad-signature")
      .send(SAMPLE_EVENTS)
      .expect(401);

    expect(res.body.code).toBe("invalid_signature");
    expect(mockProcessEvents).not.toHaveBeenCalled();
  });

  test("also accepts the legacy X-SendGrid-Signature header", async () => {
    process.env.SENDGRID_WEBHOOK_SECRET = WEBHOOK_SECRET;
    mockProcessEvents.mockReturnValue({ processed: 1, errors: 0 });

    const body = JSON.stringify([SAMPLE_EVENTS[0]]);
    const sig = makeSignature(body, WEBHOOK_SECRET);

    const res = await request(app)
      .post("/api/v1/webhooks/sendgrid")
      .set("Content-Type", "application/json")
      .set("X-SendGrid-Signature", sig)
      .send(body)
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  // ── Error propagation ──────────────────────────────────────────────────────

  test("returns 200 even when some events have processing errors", async () => {
    mockProcessEvents.mockReturnValue({ processed: 1, errors: 1 });

    const res = await request(app)
      .post("/api/v1/webhooks/sendgrid")
      .send(SAMPLE_EVENTS)
      .expect(200);

    expect(res.body.errors).toBe(1);
    expect(res.body.success).toBe(true);
  });
});
