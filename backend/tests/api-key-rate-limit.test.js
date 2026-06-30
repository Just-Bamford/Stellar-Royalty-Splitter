/**
 * Per-API-key sliding window rate limiting (#420).
 *
 * Mocks database/index.js's API-key functions with an in-memory test
 * double (consistent with how other route tests mock the database layer —
 * see initialize.test.js) since better-sqlite3 itself is globally stubbed
 * to no-ops for tests (see __mocks__/better-sqlite3.js).
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import crypto from "crypto";
import express from "express";
import request from "supertest";

// In-memory fake mirroring backend/src/database/api-keys.js's semantics.
let keys;
let nextId;

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function resetFakeDb() {
  keys = new Map(); // id -> { id, keyHash, label, createdAt, revokedAt, lastUsedAt }
  nextId = 1;
}
resetFakeDb();

const createApiKey = jest.fn((label) => {
  const apiKey = `srs_${crypto.randomBytes(16).toString("base64url")}`;
  const id = nextId++;
  const row = {
    id,
    keyHash: hashKey(apiKey),
    label: label ?? null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
    lastUsedAt: null,
  };
  keys.set(id, row);
  return { id, apiKey, label: row.label, createdAt: row.createdAt };
});

const listApiKeys = jest.fn(() =>
  [...keys.values()].map(({ id, label, createdAt, revokedAt, lastUsedAt }) => ({
    id,
    label,
    createdAt,
    revokedAt,
    lastUsedAt,
  })),
);

const revokeApiKey = jest.fn((id) => {
  const row = keys.get(id);
  if (!row || row.revokedAt) return false;
  row.revokedAt = new Date().toISOString();
  return true;
});

const findActiveKeyByRawKey = jest.fn((rawKey) => {
  const targetHash = hashKey(rawKey);
  for (const row of keys.values()) {
    if (row.keyHash === targetHash && !row.revokedAt) {
      row.lastUsedAt = new Date().toISOString();
      return { id: row.id, label: row.label };
    }
  }
  return null;
});

await jest.unstable_mockModule("../src/database/index.js", () => ({
  createApiKey,
  listApiKeys,
  revokeApiKey,
  findActiveKeyByRawKey,
  recordTransaction: jest.fn(() => "tx-1"),
  addAuditLog: jest.fn(),
}));

const { adminRouter } = await import("../src/routes/admin.js");
const { apiKeyRateLimiter, _resetApiKeyRateLimitState } = await import("../src/api-key-rate-limit.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin", adminRouter);
  app.use(apiKeyRateLimiter);
  app.get("/api/v1/probe", (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

describe("API key admin endpoints + rate limiting (#420)", () => {
  let originalToken;

  beforeEach(() => {
    resetFakeDb();
    _resetApiKeyRateLimitState();
    jest.clearAllMocks();
    originalToken = process.env.ADMIN_ROTATE_TOKEN;
    process.env.ADMIN_ROTATE_TOKEN = "admin-secret";
  });

  afterEach(() => {
    process.env.ADMIN_ROTATE_TOKEN = originalToken;
  });

  test("POST /admin/generate-key requires the admin bearer token", async () => {
    const app = buildApp();
    const res = await request(app).post("/admin/generate-key").send({ label: "ci" });
    expect(res.status).toBe(401);
  });

  test("generates a key, and it works as X-API-Key on a real request", async () => {
    const app = buildApp();
    const genRes = await request(app)
      .post("/admin/generate-key")
      .set("Authorization", "Bearer admin-secret")
      .send({ label: "ci-bot" });

    expect(genRes.status).toBe(200);
    expect(genRes.body.apiKey).toMatch(/^srs_/);
    expect(genRes.body.label).toBe("ci-bot");

    const probeRes = await request(app)
      .get("/api/v1/probe")
      .set("X-API-Key", genRes.body.apiKey);

    expect(probeRes.status).toBe(200);
    expect(probeRes.headers["x-ratelimit-limit"]).toBeDefined();
    expect(probeRes.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(probeRes.headers["x-ratelimit-reset"]).toBeDefined();
  });

  test("rejects an unknown X-API-Key with 401", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/v1/probe").set("X-API-Key", "not-a-real-key");
    expect(res.status).toBe(401);
  });

  test("exceeding API_KEY_RATE_LIMIT_MAX within the window returns 429 with rate-limit headers", async () => {
    // Module-level WINDOW_MS/MAX_REQUESTS are read once at import time
    // (default 60/60000ms here, since this file's top-level import ran
    // before any test set env overrides) — drive past the default max
    // rather than reloading the module, which would also drop the
    // database/index.js mock registered above.
    const app = buildApp();
    const genRes = await request(app)
      .post("/admin/generate-key")
      .set("Authorization", "Bearer admin-secret")
      .send({});
    const apiKey = genRes.body.apiKey;

    const DEFAULT_MAX = 60;
    let last;
    for (let i = 0; i < DEFAULT_MAX + 1; i += 1) {
      last = await request(app).get("/api/v1/probe").set("X-API-Key", apiKey);
    }

    expect(last.status).toBe(429);
    expect(last.headers["x-ratelimit-remaining"]).toBe("0");
    expect(last.headers["x-ratelimit-limit"]).toBe(String(DEFAULT_MAX));
  });

  test("revoked keys are rejected", async () => {
    const app = buildApp();
    const genRes = await request(app)
      .post("/admin/generate-key")
      .set("Authorization", "Bearer admin-secret")
      .send({ label: "to-revoke" });

    const { id, apiKey } = genRes.body;

    const revokeRes = await request(app)
      .post(`/admin/keys/${id}/revoke`)
      .set("Authorization", "Bearer admin-secret");
    expect(revokeRes.status).toBe(200);

    const probeRes = await request(app).get("/api/v1/probe").set("X-API-Key", apiKey);
    expect(probeRes.status).toBe(401);
  });

  test("GET /admin/keys never returns the raw key or hash", async () => {
    const app = buildApp();
    await request(app)
      .post("/admin/generate-key")
      .set("Authorization", "Bearer admin-secret")
      .send({ label: "listed" });

    const res = await request(app).get("/admin/keys").set("Authorization", "Bearer admin-secret");

    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0]).toMatchObject({ label: "listed" });
    expect(res.body.keys[0].apiKey).toBeUndefined();
    expect(res.body.keys[0].keyHash).toBeUndefined();
  });
});
