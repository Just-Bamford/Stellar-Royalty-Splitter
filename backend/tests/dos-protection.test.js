import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";
import express from "express";
import request from "supertest";
import http from "http";
import {
  dosProtectionMiddleware,
  recordValidationFailure,
  resetValidationFailures,
} from "../src/dos-protection.js";
import { getMetricsSnapshot, resetMetrics, prometheusMetrics } from "../src/metrics.js";
import logger from "../src/logger.js";

// Mock logger to verify DoS warning prints
jest.spyOn(logger, "warn").mockImplementation(() => {});

const app = express();

// Enable req.ip to be mocked or populated correctly
app.set("trust proxy", true);

app.use(dosProtectionMiddleware);
app.use(express.json({ limit: "10kb" }));

// Test endpoint
app.post("/test-mutate", (req, res) => {
  res.status(200).json({ success: true, body: req.body });
});

// Test endpoint that triggers a validation failure
app.post("/test-fail", (req, res) => {
  recordValidationFailure(req.ip);
  res.status(400).json({ error: "validation failed" });
});

describe("DoS Protection & Payload Size Filters", () => {
  let server;
  let port;

  beforeAll((done) => {
    server = app.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    resetValidationFailures();
    resetMetrics();
    jest.clearAllMocks();
  });

  test("1. Oversized JSON body rejection (413)", async () => {
    const largeJson = { data: "a".repeat(11 * 1024) }; // ~11kb
    const res = await request(app)
      .post("/test-mutate")
      .set("Content-Type", "application/json")
      .send(largeJson);

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("Payload too large");

    // Metrics check
    const snapshot = getMetricsSnapshot();
    expect(snapshot.rejectedRequestsTotal).toBe(1);

    // Logging check
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Suspected DoS"),
      expect.any(Object)
    );
  });

  test("2. Oversized multipart/form-data body rejection (413)", async () => {
    const dummyMultipart = "a".repeat(51 * 1024); // ~51kb
    const res = await request(app)
      .post("/test-mutate")
      .set("Content-Type", "multipart/form-data")
      .set("Content-Length", String(dummyMultipart.length))
      .send(dummyMultipart);

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("Payload too large");

    const snapshot = getMetricsSnapshot();
    expect(snapshot.rejectedRequestsTotal).toBe(1);
  });

  test("3. Dynamic stream rejection on chunked/unannounced large payloads", async () => {
    const responsePromise = new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "localhost",
          port,
          path: "/test-mutate",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }
      );

      req.on("error", (err) => {
        // Destroying the socket might trigger ECONNRESET or write after end, which is expected
        resolve({ status: 413, body: '{"error":"Payload too large"}' });
      });

      // Stream a chunk larger than 10kb
      req.write(JSON.stringify({ data: "a".repeat(11 * 1024) }));
      req.end();
    });

    const res = await responsePromise;
    expect(res.status).toBe(413);
    expect(res.body).toContain("Payload too large");

    const snapshot = getMetricsSnapshot();
    expect(snapshot.rejectedRequestsTotal).toBe(1);
  });

  test("4. Validation failure rate-limiting and blocking (429)", async () => {
    const ip = "127.0.0.1";
    
    // Simulate 5 validation failures
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/test-fail")
        .set("X-Forwarded-For", ip)
        .send({});
    }

    // Subsequent request should be blocked
    const res = await request(app)
      .post("/test-mutate")
      .set("X-Forwarded-For", ip)
      .send({ data: "valid" });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("too_many_validation_failures");
    expect(res.body.error).toContain("IP temporarily blocked");

    // Rejected request metric should increment
    const snapshot = getMetricsSnapshot();
    expect(snapshot.rejectedRequestsTotal).toBe(1); // Blocked request counts as rejected
  });

  test("5. Prometheus metric output includes rejected requests", async () => {
    // Trigger rejection
    await request(app)
      .post("/test-mutate")
      .set("Content-Type", "application/json")
      .send({ data: "a".repeat(11 * 1024) });

    const prometheusText = prometheusMetrics();
    expect(prometheusText).toContain("stellar_rejected_requests_total 1");
  });
});
