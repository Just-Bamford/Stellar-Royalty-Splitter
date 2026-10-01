/**
 * Route-level tests for the fraud detection API (#1042).
 *
 * The `fraud-detection` service is mocked so the tests are deterministic and do
 * not touch the database or Python runtime; they validate the HTTP contract and
 * the verification-flow wiring.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const mockService = {
  getAlerts: jest.fn(),
  getAlert: jest.fn(),
  resolveAlert: jest.fn(),
  verifyToken: jest.fn(),
  createVerificationToken: jest.fn(),
  scoreTransactionEvent: jest.fn(),
};

await jest.unstable_mockModule("../src/services/fraud-detection.js", () => ({
  __esModule: true,
  default: mockService,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const express = (await import("express")).default;
const { fraudAlertsRouter } = await import("../src/routes/security/fraud-alerts.js");

const app = express();
app.use(express.json());
app.use("/api/v1/security/fraud-alerts", fraudAlertsRouter);

describe("Fraud Alerts API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/v1/security/fraud-alerts", () => {
    it("returns a filtered list of alerts", async () => {
      mockService.getAlerts.mockReturnValue([
        { id: 1, userId: "U1", level: "require_verification", status: "open" },
        { id: 2, userId: "U1", level: "block", status: "open" },
      ]);

      const res = await request(app).get("/api/v1/security/fraud-alerts").query({
        userId: "U1",
        status: "open",
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(2);
      expect(res.body.alerts).toHaveLength(2);
      expect(mockService.getAlerts).toHaveBeenCalledWith({
        userId: "U1",
        status: "open",
      });
    });

    it("defaults to open alerts with no filters", async () => {
      mockService.getAlerts.mockReturnValue([]);
      const res = await request(app).get("/api/v1/security/fraud-alerts");
      expect(res.status).toBe(200);
      expect(mockService.getAlerts).toHaveBeenCalledWith({
        userId: undefined,
        status: undefined,
      });
    });
  });

  describe("GET /api/v1/security/fraud-alerts/:id", () => {
    it("returns the alert when found", async () => {
      mockService.getAlert.mockReturnValue({ id: 42, userId: "U1", level: "block" });
      const res = await request(app).get("/api/v1/security/fraud-alerts/42");
      expect(res.status).toBe(200);
      expect(res.body.alert.id).toBe(42);
    });

    it("returns 404 when not found", async () => {
      mockService.getAlert.mockReturnValue(null);
      const res = await request(app).get("/api/v1/security/fraud-alerts/99");
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("not_found");
    });
  });

  describe("POST /api/v1/security/fraud-alerts/:id/resolve", () => {
    it("approves an alert with action=approve", async () => {
      mockService.resolveAlert.mockReturnValue({ id: 5, status: "resolved", resolution: "approve" });
      const res = await request(app)
        .post("/api/v1/security/fraud-alerts/5/resolve")
        .send({ action: "approve", resolvedBy: "admin:ops" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.alert.status).toBe("resolved");
      expect(mockService.resolveAlert).toHaveBeenCalledWith(5, {
        action: "approve",
        resolvedBy: "admin:ops",
        resolution: undefined,
      });
    });

    it("returns 400 for an invalid action", async () => {
      mockService.resolveAlert.mockImplementation(() => {
        throw new Error("invalid resolution action: foo");
      });
      const res = await request(app)
        .post("/api/v1/security/fraud-alerts/5/resolve")
        .send({ action: "foo" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("fraud_resolve_failed");
    });

    it("returns 404 when the alert does not exist", async () => {
      mockService.resolveAlert.mockReturnValue(null);
      const res = await request(app)
        .post("/api/v1/security/fraud-alerts/77/resolve")
        .send({ action: "block" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/security/fraud-alerts/:id/verify (verification flow)", () => {
    it("accepts a valid verification token", async () => {
      mockService.verifyToken.mockReturnValue({ valid: true, alertId: 9 });
      const res = await request(app)
        .post("/api/v1/security/fraud-alerts/9/verify")
        .send({ token: "abc.123" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockService.verifyToken).toHaveBeenCalledWith(9, "abc.123");
    });

    it("rejects an invalid/expired token with 403", async () => {
      mockService.verifyToken.mockReturnValue({ valid: false, reason: "invalid_or_expired_token" });
      const res = await request(app)
        .post("/api/v1/security/fraud-alerts/9/verify")
        .send({ token: "stale" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("verification_failed");
    });

    it("rejects a missing token with 403", async () => {
      mockService.verifyToken.mockReturnValue({ valid: false, reason: "missing_token" });
      const res = await request(app)
        .post("/api/v1/security/fraud-alerts/9/verify")
        .send({});
      expect(res.status).toBe(403);
    });
  });
});
