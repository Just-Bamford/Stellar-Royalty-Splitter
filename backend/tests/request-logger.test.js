import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

// Mock the logger so we can assert on what it receives without writing to stdout.
const mockInfo = jest.fn();

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { info: mockInfo, warn: jest.fn(), error: jest.fn() },
}));

const { requestLogger, safeHeaders } = await import("../src/middleware/request-logger.js");

function makeApp() {
  const app = express();
  app.use(requestLogger);
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  app.post("/echo", express.json(), (req, res) => res.json(req.body));
  return app;
}

describe("requestLogger middleware (#673)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("generates a request ID when none is provided", async () => {
    const app = makeApp();
    const res = await request(app).get("/ping");

    const id = res.headers["x-request-id"];
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("honours an existing X-Request-Id from the caller", async () => {
    const app = makeApp();
    const incoming = "my-trace-id-abc123";

    const res = await request(app).get("/ping").set("x-request-id", incoming);

    expect(res.headers["x-request-id"]).toBe(incoming);
  });

  test("trims an oversized incoming request ID to 128 characters", async () => {
    const app = makeApp();
    const oversized = "x".repeat(200);

    const res = await request(app).get("/ping").set("x-request-id", oversized);

    expect(res.headers["x-request-id"].length).toBe(128);
  });

  test("attaches requestId to the req object for downstream handlers", async () => {
    let captured;
    const app = express();
    app.use(requestLogger);
    app.get("/capture", (req, res) => {
      captured = req.requestId;
      res.sendStatus(200);
    });

    await request(app).get("/capture");
    expect(typeof captured).toBe("string");
    expect(captured.length).toBeGreaterThan(0);
  });

  test("logs method, path, status, and duration on finish", async () => {
    const app = makeApp();
    await request(app).get("/ping");

    expect(mockInfo).toHaveBeenCalledTimes(1);
    const [message, meta] = mockInfo.mock.calls[0];
    expect(message).toBe("request completed");
    expect(meta.method).toBe("GET");
    expect(meta.path).toBe("/ping");
    expect(meta.status).toBe(200);
    expect(typeof meta.duration).toBe("number");
    expect(meta.duration).toBeGreaterThanOrEqual(0);
  });

  test("logs the request ID in every log entry", async () => {
    const app = makeApp();
    const incoming = "test-request-id-xyz";
    await request(app).get("/ping").set("x-request-id", incoming);

    const [, meta] = mockInfo.mock.calls[0];
    expect(meta.requestId).toBe(incoming);
  });

  test("includes X-Request-Id in the response headers", async () => {
    const app = makeApp();
    const res = await request(app).get("/ping");
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  test("records the correct HTTP status code", async () => {
    const app = express();
    app.use(requestLogger);
    app.get("/notfound", (_req, res) => res.sendStatus(404));

    await request(app).get("/notfound");

    const [, meta] = mockInfo.mock.calls[0];
    expect(meta.status).toBe(404);
  });
});

describe("safeHeaders helper (#673)", () => {
  test("redacts Authorization header", () => {
    const result = safeHeaders({ authorization: "Bearer secret-token" });
    expect(result.authorization).toBe("[redacted]");
  });

  test("redacts x-api-key header", () => {
    const result = safeHeaders({ "x-api-key": "my-secret-key" });
    expect(result["x-api-key"]).toBe("[redacted]");
  });

  test("redacts cookie header", () => {
    const result = safeHeaders({ cookie: "session=abc123" });
    expect(result.cookie).toBe("[redacted]");
  });

  test("redacts x-private-key header", () => {
    const result = safeHeaders({ "x-private-key": "SDKZZZ..." });
    expect(result["x-private-key"]).toBe("[redacted]");
  });

  test("preserves non-sensitive headers unchanged", () => {
    const result = safeHeaders({
      "content-type": "application/json",
      "x-request-id": "abc-123",
    });
    expect(result["content-type"]).toBe("application/json");
    expect(result["x-request-id"]).toBe("abc-123");
  });
});
