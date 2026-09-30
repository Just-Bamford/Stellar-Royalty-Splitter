/**
 * Integration tests for partner API key auth, tiered rate limiting, metering
 * and the partner routes — closes #996.
 *
 * Covers:
 *   - x-api-key / Authorization: Bearer extraction
 *   - 401 for missing, invalid, revoked and expired keys
 *   - Anonymous and wallet-based traffic is unaffected
 *   - Per-tier quota enforcement with 429 + X-RateLimit-* headers
 *   - Every call is metered, including throttled ones
 *   - RBAC on the operator/admin surface
 *   - Endpoint-normalisation for low-cardinality analytics
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createFakeMeteringDb } from "./fake-metering-db.js";

// ─── Mock the database layer ──────────────────────────────────────────────────

const fake = createFakeMeteringDb();

await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: fake.db,
  countWrite: () => {},
  closeDatabase: () => {},
  initializeDatabase: () => {},
  default: fake.db,
}));

const { issueApiKey, recordApiCall, revokeApiKey, findApiKey } = await import(
  "../src/services/api-metering.js"
);
const { apiKeyAuth, meterApiCall, normalizeEndpoint, partnerRateLimit } = await import(
  "../src/middleware/api-key-auth.js"
);
const { partnerApiRouter } = await import("../src/routes/partner-api.js");

/**
 * Mount the partner middleware chain and a public "marketplace" endpoint the
 * way index.js does, so the tests exercise the real request path.
 */
function buildApp({ role = "admin" } = {}) {
  const app = express();
  app.use(express.json());

  // Stand in for the global attachRole middleware.
  app.use((req, _res, next) => {
    req.role = role;
    next();
  });

  app.use(apiKeyAuth());
  app.use(meterApiCall());
  app.use(partnerRateLimit());

  // A public endpoint a marketplace would call.
  app.get("/api/v1/contract/:id", (req, res) =>
    res.json({ success: true, contractId: req.params.id, partnerId: req.partnerId ?? null })
  );

  app.use("/api/v1/partner", partnerApiRouter);

  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });

  return app;
}

const app = buildApp();

beforeEach(() => {
  fake.reset();
});

/** Issue a key and return it along with the plaintext. */
function keyFor(partnerId, options = {}) {
  return issueApiKey({ partnerId, partnerName: options.partnerName ?? partnerId, ...options });
}

// ─── Key extraction ───────────────────────────────────────────────────────────

describe("api-key-auth :: key extraction", () => {
  test("reads the key from the x-api-key header", async () => {
    const key = keyFor("opensea");
    const res = await request(app).get("/api/v1/partner/me").set("x-api-key", key.apiKey);

    expect(res.status).toBe(200);
    expect(res.body.data.partnerId).toBe("opensea");
  });

  test("falls back to an Authorization: Bearer token", async () => {
    const key = keyFor("rarible");
    const res = await request(app)
      .get("/api/v1/partner/me")
      .set("Authorization", `Bearer ${key.apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.data.partnerId).toBe("rarible");
  });

  test("ignores surrounding whitespace", async () => {
    const key = keyFor("opensea");
    const res = await request(app).get("/api/v1/partner/me").set("x-api-key", `  ${key.apiKey}  `);
    expect(res.status).toBe(200);
  });
});

// ─── Authentication ───────────────────────────────────────────────────────────

describe("api-key-auth :: authentication", () => {
  test("401s a key-protected route when no key is presented", async () => {
    const res = await request(app).get("/api/v1/partner/me");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("api_key_required");
  });

  test("401s an unknown key", async () => {
    const res = await request(app)
      .get("/api/v1/partner/me")
      .set("x-api-key", "srs_live_deadbeef");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_api_key");
  });

  test("401s a revoked key with a specific code", async () => {
    const key = keyFor("opensea");
    revokeApiKey(key.id);

    const res = await request(app).get("/api/v1/partner/me").set("x-api-key", key.apiKey);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("api_key_revoked");
  });

  test("401s an expired key with a specific code", async () => {
    const key = keyFor("opensea", { expiresAt: "2000-01-01T00:00:00.000Z" });

    const res = await request(app).get("/api/v1/partner/me").set("x-api-key", key.apiKey);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("api_key_expired");
  });

  test("lets anonymous traffic reach public endpoints untouched", async () => {
    const res = await request(app).get("/api/v1/contract/abc123");

    expect(res.status).toBe(200);
    expect(res.body.partnerId).toBeNull();
  });

  test("exposes the partner id on public endpoints for keyed callers", async () => {
    const key = keyFor("opensea");
    const res = await request(app)
      .get("/api/v1/contract/abc123")
      .set("x-api-key", key.apiKey);

    expect(res.status).toBe(200);
    expect(res.body.partnerId).toBe("opensea");
  });

  test("marks the key as used", async () => {
    const key = keyFor("opensea");
    await request(app).get("/api/v1/partner/me").set("x-api-key", key.apiKey);

    expect(findApiKey(key.apiKey).lastUsedAt).not.toBeNull();
  });
});

// ─── Tiered rate limiting ─────────────────────────────────────────────────────

describe("api-key-auth :: tiered rate limiting", () => {
  test("allows a free-tier key up to 100 calls a day, then 429s", async () => {
    const key = keyFor("free-co");
    // 99 already used; this request is the 100th and must pass.
    for (let i = 0; i < 99; i += 1) {
      recordApiCall({
        keyId: key.keyId,
        partnerId: key.partnerId,
        endpoint: "/api/v1/contract/x",
        method: "GET",
        statusCode: 200,
      });
    }

    const allowed = await request(app)
      .get("/api/v1/contract/x")
      .set("x-api-key", key.apiKey);
    expect(allowed.status).toBe(200);
    expect(allowed.headers["x-ratelimit-limit"]).toBe("100");
    expect(allowed.headers["x-ratelimit-remaining"]).toBe("1");
    expect(allowed.headers["x-ratelimit-tier"]).toBe("free");

    const blocked = await request(app)
      .get("/api/v1/contract/x")
      .set("x-api-key", key.apiKey);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("rate_limit_exceeded");
    expect(blocked.body.window).toBe("daily");
    expect(blocked.body.limit).toBe(100);
    expect(blocked.body.resetsAt).toBeTruthy();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  test("enforces the pro tier monthly quota", async () => {
    const key = keyFor("pro-co", { tier: "pro" });
    for (let i = 0; i < 10_000; i += 1) {
      recordApiCall({
        keyId: key.keyId,
        partnerId: key.partnerId,
        endpoint: "/api/v1/contract/x",
        method: "GET",
        statusCode: 200,
      });
    }

    const res = await request(app).get("/api/v1/contract/x").set("x-api-key", key.apiKey);
    expect(res.status).toBe(429);
    expect(res.body.window).toBe("monthly");
    expect(res.body.limit).toBe(10_000);
  });

  test("enforces a custom enterprise daily limit", async () => {
    const key = keyFor("ent-co", { tier: "enterprise", dailyCallLimit: 2 });

    expect((await request(app).get("/api/v1/contract/x").set("x-api-key", key.apiKey)).status).toBe(200);
    expect((await request(app).get("/api/v1/contract/x").set("x-api-key", key.apiKey)).status).toBe(200);
    expect((await request(app).get("/api/v1/contract/x").set("x-api-key", key.apiKey)).status).toBe(429);
  });

  test("does not rate-limit anonymous traffic at the tier layer", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).get("/api/v1/contract/x");
      expect(res.status).toBe(200);
    }
  });
});

// ─── Metering ─────────────────────────────────────────────────────────────────

describe("api-key-auth :: metering", () => {
  test("records every keyed call with its status and duration", async () => {
    const key = keyFor("opensea");
    const contractId = "3f2b7c0a1d4e4f6a9b8c0d1e2f3a4b5c";

    await request(app).get(`/api/v1/contract/${contractId}`).set("x-api-key", key.apiKey);

    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]).toMatchObject({
      keyId: key.keyId,
      partnerId: "opensea",
      endpoint: "/api/v1/contract/:id",
      method: "GET",
      statusCode: 200,
      rateLimited: 0,
    });
    expect(fake.events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test("records throttled calls but does not charge them to the quota", async () => {
    const key = keyFor("free-co", { dailyCallLimit: 1 });

    await request(app).get("/api/v1/contract/x").set("x-api-key", key.apiKey);
    await request(app).get("/api/v1/contract/x").set("x-api-key", key.apiKey);

    expect(fake.events).toHaveLength(2);
    expect(fake.events[1].statusCode).toBe(429);
    expect(fake.events[1].rateLimited).toBe(1);
  });

  test("does not meter anonymous traffic", async () => {
    await request(app).get("/api/v1/contract/x");
    expect(fake.events).toHaveLength(0);
  });

  test("normalises high-cardinality paths", () => {
    expect(normalizeEndpoint("/api/v1/contract/3f2b7c0a1d4e4f6a9b8c0d1e2f3a4b5c")).toBe(
      "/api/v1/contract/:id"
    );
    expect(normalizeEndpoint("/api/v1/contract/3f2b7c0a-1d4e-4f6a-9b8c-0d1e2f3a4b5c")).toBe(
      "/api/v1/contract/:id"
    );
    expect(normalizeEndpoint("/api/v1/partner/keys/key_ab12cd34")).toBe(
      "/api/v1/partner/keys/:keyId"
    );
    expect(normalizeEndpoint("/api/v1/partner/keys/7")).toBe("/api/v1/partner/keys/:keyId");
    expect(normalizeEndpoint("/api/v1/history/12345?limit=10")).toBe("/api/v1/history/:id");
    expect(normalizeEndpoint(undefined)).toBe("unknown");
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────

describe("partner-api :: routes", () => {
  test("GET /pricing is reachable without a key", async () => {
    const res = await request(app).get("/api/v1/partner/pricing");

    expect(res.status).toBe(200);
    expect(res.body.data.tiers.map((t) => t.tier)).toEqual(["free", "pro", "enterprise"]);
    expect(res.body.data.tiers[0].dailyLimit).toBe(100);
    expect(res.body.data.tiers[1].monthlyPriceCents).toBe(5000);
  });

  test("GET /me reports the tier, limits and live usage", async () => {
    const key = keyFor("opensea", { tier: "pro" });

    const res = await request(app).get("/api/v1/partner/me").set("x-api-key", key.apiKey);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      partnerId: "opensea",
      tier: "pro",
      limits: { monthlyLimit: 10_000 },
    });
    expect(res.body.data.keyHash).toBeUndefined();
  });

  test("GET /usage, /usage/endpoints and /errors are scoped to the caller", async () => {
    const key = keyFor("opensea");
    recordApiCall({
      keyId: key.keyId,
      partnerId: "opensea",
      endpoint: "/api/v1/contract/x",
      method: "GET",
      statusCode: 200,
    });
    const other = keyFor("rarible");
    recordApiCall({
      keyId: other.keyId,
      partnerId: "rarible",
      endpoint: "/api/v1/contract/y",
      method: "GET",
      statusCode: 200,
    });

    const usage = await request(app)
      .get("/api/v1/partner/usage?days=7")
      .set("x-api-key", key.apiKey);
    const total = usage.body.data.series.reduce((sum, p) => sum + p.calls, 0);
    expect(usage.body.data.partnerId).toBe("opensea");
    expect(total).toBe(1);

    const endpoints = await request(app)
      .get("/api/v1/partner/usage/endpoints")
      .set("x-api-key", key.apiKey);
    // The partner's own dashboard calls are metered too, so the list also
    // contains the /partner/usage call made a moment earlier.
    const names = endpoints.body.data.endpoints.map((e) => e.endpoint);
    expect(names).toContain("/api/v1/contract/x");
    expect(names).not.toContain("/api/v1/contract/y");

    const errors = await request(app)
      .get("/api/v1/partner/errors")
      .set("x-api-key", key.apiKey);
    // Only this partner's traffic is counted; the dashboard's own calls are
    // metered too, so the total is at least the one seeded call.
    expect(errors.body.data.totalCalls).toBeGreaterThanOrEqual(1);
    expect(errors.body.data.errorRate).toBe(0);
  });

  test("rejects an out-of-range analytics window", async () => {
    const key = keyFor("opensea");
    const res = await request(app)
      .get("/api/v1/partner/usage?days=9999")
      .set("x-api-key", key.apiKey);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("validation_failed");
  });

  test("POST /keys issues a key and never returns the hash again", async () => {
    const res = await request(app)
      .post("/api/v1/partner/keys")
      .send({ partnerId: "opensea", partnerName: "OpenSea", tier: "pro" });

    expect(res.status).toBe(201);
    expect(res.body.data.apiKey).toMatch(/^srs_live_/);
    expect(res.body.data.monthlyCallLimit).toBe(10_000);

    const listed = await request(app).get("/api/v1/partner/keys");
    expect(listed.body.count).toBe(1);
    expect(listed.body.data[0].apiKey).toBeUndefined();
    expect(listed.body.data[0].keyHash).toBeUndefined();
  });

  test("POST /keys validates the payload", async () => {
    const missing = await request(app).post("/api/v1/partner/keys").send({ partnerId: "x" });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("validation_failed");

    const badTier = await request(app)
      .post("/api/v1/partner/keys")
      .send({ partnerId: "x", partnerName: "X", tier: "platinum" });
    expect(badTier.status).toBe(400);
  });

  test("PATCH /keys/:id updates a tier and DELETE revokes", async () => {
    const created = await request(app)
      .post("/api/v1/partner/keys")
      .send({ partnerId: "opensea", partnerName: "OpenSea" });

    const patched = await request(app)
      .patch(`/api/v1/partner/keys/${created.body.data.id}`)
      .send({ tier: "enterprise", monthlyPriceCents: 120_000 });
    expect(patched.status).toBe(200);
    expect(patched.body.data.tier).toBe("enterprise");

    const deleted = await request(app).delete(`/api/v1/partner/keys/${created.body.data.id}`);
    expect(deleted.status).toBe(200);

    const missing = await request(app).delete(`/api/v1/partner/keys/${created.body.data.id}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("api_key_not_found");
  });

  test("PATCH /keys/:id 404s an unknown key and 400s a bad id", async () => {
    const missing = await request(app).patch("/api/v1/partner/keys/9999").send({ tier: "pro" });
    expect(missing.status).toBe(404);

    const bad = await request(app).patch("/api/v1/partner/keys/abc").send({ tier: "pro" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_key_id");
  });

  test("GET /analytics returns the full dashboard payload", async () => {
    const key = keyFor("pro-co", { tier: "pro" });
    for (let i = 0; i < 5; i += 1) {
      recordApiCall({
        keyId: key.keyId,
        partnerId: "pro-co",
        endpoint: "/api/v1/contract/x",
        method: "GET",
        statusCode: 200,
      });
    }

    const res = await request(app).get("/api/v1/partner/analytics?days=30");

    expect(res.status).toBe(200);
    expect(res.body.data.overview.activeKeys).toBe(1);
    expect(res.body.data.usageOverTime.series).toHaveLength(30);
    expect(res.body.data.topEndpoints.endpoints[0].calls).toBe(5);
    expect(res.body.data.errorRates.totalCalls).toBe(5);
    expect(res.body.data.revenue.totals.totalCents).toBe(5000);
    expect(res.body.data.tiers).toHaveLength(3);
  });

  test("GET /analytics/revenue attributes revenue per partner", async () => {
    const pro = keyFor("pro-co", { tier: "pro" });
    const ent = keyFor("ent-co", { tier: "enterprise", monthlyPriceCents: 200_000 });
    recordApiCall({
      keyId: pro.keyId,
      partnerId: "pro-co",
      endpoint: "/api/v1/contract/x",
      method: "GET",
      statusCode: 200,
    });

    const res = await request(app).get("/api/v1/partner/analytics/revenue");

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.partners.map((p) => [p.partnerId, p]));
    expect(byId["ent-co"].totalCents).toBe(200_000);
    expect(byId["ent-co"].negotiated).toBe(true);
    expect(byId["pro-co"].totalCents).toBe(5000);
  });

  test("GET /analytics/overview returns headline counters", async () => {
    keyFor("opensea");
    const res = await request(app).get("/api/v1/partner/analytics/overview");

    expect(res.status).toBe(200);
    expect(res.body.data.totalKeys).toBe(1);
    expect(res.body.data.keysByTier.free).toBe(1);
  });

  test("the operator surface is closed to viewers", async () => {
    const viewerApp = buildApp({ role: "viewer" });

    const keys = await request(viewerApp).get("/api/v1/partner/keys");
    expect(keys.status).toBe(403);
    expect(keys.body.code).toBe("forbidden");

    const issue = await request(viewerApp)
      .post("/api/v1/partner/keys")
      .send({ partnerId: "x", partnerName: "X" });
    expect(issue.status).toBe(403);

    const analytics = await request(viewerApp).get("/api/v1/partner/analytics");
    expect(analytics.status).toBe(403);
  });

  test("a viewer key cannot reach the partner analytics either", async () => {
    const key = keyFor("opensea");
    const viewerApp = buildApp({ role: "viewer" });

    const res = await request(viewerApp)
      .get("/api/v1/partner/analytics")
      .set("x-api-key", key.apiKey);

    expect(res.status).toBe(403);
  });

  test("GET /usage is 404-free and returns an empty series for a fresh key", async () => {
    const key = keyFor("brand-new");
    const res = await request(app).get("/api/v1/partner/usage").set("x-api-key", key.apiKey);

    expect(res.status).toBe(200);
    expect(res.body.data.series.every((p) => p.calls === 0)).toBe(true);
  });
});
