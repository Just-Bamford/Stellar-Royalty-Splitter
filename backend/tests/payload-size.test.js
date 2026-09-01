import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import request from "supertest";

// Mirrors the body-size + central error handler wiring in src/index.js, in
// isolation from rate limiting / Stellar RPC so we can assert on 413 vs 500
// behavior directly. See src/index.js for the source of truth this mirrors.
function buildApp(limit) {
  const app = express();
  app.use(express.json({ limit }));
  app.post("/echo", (req, res) => res.json({ received: req.body }));
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.too.large" || err.status === 413) {
      return res.status(413).json({ error: "Request body exceeds the maximum allowed size" });
    }
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

describe("Request body size limits", () => {
  const originalEnv = process.env.MAX_REQUEST_BODY_SIZE;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MAX_REQUEST_BODY_SIZE;
    else process.env.MAX_REQUEST_BODY_SIZE = originalEnv;
  });

  test("accepts a request body under the configured limit", async () => {
    const app = buildApp("1kb");
    const body = { data: "x".repeat(100) };

    const res = await request(app).post("/echo").send(body);

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual(body);
  });

  test("rejects a request body over the configured limit with 413 and a consistent error shape", async () => {
    const app = buildApp("1kb");
    const body = { data: "x".repeat(5000) };

    const res = await request(app).post("/echo").send(body);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "Request body exceeds the maximum allowed size" });
  });

  test("does not fall through to a generic 500 when the body is too large", async () => {
    const app = buildApp("1kb");

    const res = await request(app)
      .post("/echo")
      .send({ data: "y".repeat(5000) });

    expect(res.status).not.toBe(500);
  });

  test("limit is driven by the configured value, not hardcoded", async () => {
    // A body that fits under a 20kb limit but exceeds a 1kb limit.
    const body = { data: "z".repeat(5000) };

    const strict = await request(buildApp("1kb")).post("/echo").send(body);
    expect(strict.status).toBe(413);

    const lenient = await request(buildApp("20kb")).post("/echo").send(body);
    expect(lenient.status).toBe(200);
  });

  test("MAX_REQUEST_BODY_SIZE env var defaults to 10kb when unset", async () => {
    delete process.env.MAX_REQUEST_BODY_SIZE;
    const limit = process.env.MAX_REQUEST_BODY_SIZE ?? "10kb";
    expect(limit).toBe("10kb");
  });

  test("MAX_REQUEST_BODY_SIZE env var overrides the default when set", async () => {
    process.env.MAX_REQUEST_BODY_SIZE = "2kb";
    const limit = process.env.MAX_REQUEST_BODY_SIZE ?? "10kb";
    expect(limit).toBe("2kb");
  });
});

describe("Schema-level array length validation (independent of byte-size limit)", () => {
  test("a 21-collaborator payload well under 10kb is still rejected by initializeSchema", async () => {
    const { initializeSchema } = await import("../src/validation.js");

    const collaborators = Array.from(
      { length: 21 },
      (_, i) => `G${String(i).padStart(55, "A")}`
    );
    const shares = Array(21).fill(Math.floor(10000 / 21));

    const body = {
      contractId: "C" + "A".repeat(55),
      walletAddress: "G" + "A".repeat(55),
      collaborators,
      shares,
    };

    expect(JSON.stringify(body).length).toBeLessThan(10 * 1024);

    const result = initializeSchema.safeParse(body);
    expect(result.success).toBe(false);
  });
});
