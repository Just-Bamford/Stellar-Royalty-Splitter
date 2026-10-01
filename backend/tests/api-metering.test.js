/**
 * Tests for the partner API metering service — closes #996.
 *
 * Covers:
 *   - Key issuance, hashing, lookup, revocation and tier changes
 *   - Per-tier rate limits (free daily, pro monthly, enterprise custom)
 *   - Call recording, including throttled calls that must not be billed
 *   - Analytics aggregation (calls over time, top endpoints, error rates)
 *   - Usage-based pricing and revenue attribution per partner
 *   - Event retention pruning
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { createFakeMeteringDb } from "./fake-metering-db.js";

// ─── Mock the database layer with an in-memory implementation ─────────────────

const fake = createFakeMeteringDb();

await jest.unstable_mockModule("../src/database/core.js", () => ({
  db: fake.db,
  countWrite: () => {},
  default: fake.db,
}));

const {
  PRICING_TIERS,
  calculateCharge,
  checkRateLimit,
  dayBucket,
  findApiKey,
  getEffectiveLimits,
  getErrorRates,
  getPartnerOverview,
  getPricingTiers,
  getRevenueByPartner,
  getTopEndpoints,
  getUsageOverTime,
  issueApiKey,
  listApiKeys,
  nextUtcMidnight,
  nextUtcMonthStart,
  pruneApiCallEvents,
  recordApiCall,
  revokeApiKey,
  updateApiKey,
} = await import("../src/services/api-metering.js");

/** Seed `count` billable calls for a key on today's UTC day. */
function recordCalls(keyId, partnerId, count, overrides = {}) {
  for (let i = 0; i < count; i += 1) {
    recordApiCall({
      keyId,
      partnerId,
      endpoint: overrides.endpoint ?? "/api/v1/contract/status",
      method: overrides.method ?? "GET",
      statusCode: overrides.statusCode ?? 200,
      durationMs: overrides.durationMs ?? 12,
      rateLimited: overrides.rateLimited ?? false,
    });
  }
}

beforeEach(() => {
  fake.reset();
});

// ─── Key issuance and lookup ──────────────────────────────────────────────────

describe("api-metering :: key issuance", () => {
  test("issues a key, returns the plaintext once and stores only the hash", () => {
    const issued = issueApiKey({ partnerId: "opensea", partnerName: "OpenSea" });

    expect(issued.apiKey).toMatch(/^srs_live_[0-9a-f]{48}$/);
    expect(issued.tier).toBe("free");
    expect(issued.dailyCallLimit).toBe(100);
    expect(issued.monthlyCallLimit).toBeNull();

    // The persisted row must never contain the plaintext key.
    expect(fake.keys).toHaveLength(1);
    expect(fake.keys[0].keyHash).not.toBe(issued.apiKey);
    expect(JSON.stringify(fake.keys[0])).not.toContain(issued.apiKey);
  });

  test("resolves a plaintext key to its record and rejects unknown keys", () => {
    const issued = issueApiKey({ partnerId: "rarible", partnerName: "Rarible" });

    const found = findApiKey(issued.apiKey);
    expect(found.partnerId).toBe("rarible");
    expect(found.keyId).toBe(issued.keyId);
    expect(found.reason).toBeUndefined();

    expect(findApiKey("srs_live_nope")).toBeNull();
    expect(findApiKey(null)).toBeNull();
    expect(findApiKey("")).toBeNull();
  });

  test("applies tier defaults and honours explicit overrides", () => {
    const pro = issueApiKey({ partnerId: "p1", partnerName: "P1", tier: "pro" });
    expect(pro.monthlyCallLimit).toBe(10_000);
    expect(pro.monthlyPriceCents).toBe(5_000);

    const custom = issueApiKey({
      partnerId: "p2",
      partnerName: "P2",
      tier: "enterprise",
      dailyCallLimit: 5_000,
      monthlyCallLimit: 1_000_000,
      monthlyPriceCents: 250_000,
    });
    expect(custom.dailyCallLimit).toBe(5_000);
    expect(custom.monthlyPriceCents).toBe(250_000);
  });

  test("rejects invalid input", () => {
    expect(() => issueApiKey({ partnerName: "no id" })).toThrow(/partnerId is required/);
    expect(() => issueApiKey({ partnerId: "x", tier: "platinum" })).toThrow(/Unknown tier/);
  });

  test("revokes a key and reports the reason on lookup", () => {
    const issued = issueApiKey({ partnerId: "p1", partnerName: "P1" });

    expect(revokeApiKey(issued.id)).toBe(true);
    expect(revokeApiKey(issued.id)).toBe(false);

    const found = findApiKey(issued.apiKey);
    expect(found.reason).toBe("revoked");
    expect(listApiKeys()).toHaveLength(1);
    expect(listApiKeys()[0].status).toBe("revoked");
  });

  test("reports expired keys without treating them as unknown", () => {
    const issued = issueApiKey({
      partnerId: "p1",
      partnerName: "P1",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    expect(findApiKey(issued.apiKey).reason).toBe("expired");
  });

  test("updates tier, limits and negotiated price", () => {
    const issued = issueApiKey({ partnerId: "p1", partnerName: "P1" });

    const updated = updateApiKey(issued.id, {
      tier: "enterprise",
      dailyCallLimit: 42,
      monthlyCallLimit: null,
      monthlyPriceCents: 99_900,
    });

    expect(updated.tier).toBe("enterprise");
    expect(updated.dailyCallLimit).toBe(42);
    // null resets the limit back to the tier default (uncapped for enterprise)
    expect(updated.monthlyCallLimit).toBeNull();
    expect(fake.keys[0].monthlyPriceCents).toBe(99_900);

    expect(updateApiKey(9_999, { tier: "pro" })).toBeNull();
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe("api-metering :: rate limits", () => {
  test("free tier allows 100 calls a day and blocks the 101st", () => {
    const issued = issueApiKey({ partnerId: "free-co", partnerName: "Free Co" });
    recordCalls(issued.keyId, issued.partnerId, 99);

    const before = checkRateLimit(findApiKey(issued.apiKey));
    expect(before.allowed).toBe(true);
    expect(before.used).toBe(99);
    expect(before.remaining).toBe(1);
    expect(before.window).toBe("daily");
    expect(before.percentUsed).toBe(99);

    recordCalls(issued.keyId, issued.partnerId, 1);

    const after = checkRateLimit(findApiKey(issued.apiKey));
    expect(after.allowed).toBe(false);
    expect(after.window).toBe("daily");
    expect(after.limit).toBe(100);
    expect(after.remaining).toBe(0);
    expect(after.resetsAt).toBe(nextUtcMidnight());
  });

  test("pro tier is capped monthly, not daily", () => {
    const issued = issueApiKey({ partnerId: "pro-co", partnerName: "Pro Co", tier: "pro" });
    recordCalls(issued.keyId, issued.partnerId, 10_000);

    const quota = checkRateLimit(findApiKey(issued.apiKey));
    expect(quota.allowed).toBe(false);
    expect(quota.window).toBe("monthly");
    expect(quota.limit).toBe(10_000);
    expect(quota.resetsAt).toBe(nextUtcMonthStart());
  });

  test("enterprise tier is uncapped unless custom limits are set", () => {
    const issued = issueApiKey({ partnerId: "ent-co", partnerName: "Ent Co", tier: "enterprise" });
    recordCalls(issued.keyId, issued.partnerId, 25_000);

    const quota = checkRateLimit(findApiKey(issued.apiKey));
    expect(quota.allowed).toBe(true);
    expect(quota.window).toBe("monthly");
    expect(quota.limit).toBeNull();
    expect(quota.remaining).toBeNull();

    const capped = updateApiKey(issued.id, { dailyCallLimit: 1 });
    expect(getEffectiveLimits(capped).dailyLimit).toBe(1);
    expect(checkRateLimit(findApiKey(issued.apiKey)).allowed).toBe(false);
  });

  test("throttled calls are metered but never charged to the quota", () => {
    const issued = issueApiKey({ partnerId: "free-co", partnerName: "Free Co" });
    recordCalls(issued.keyId, issued.partnerId, 100);
    recordCalls(issued.keyId, issued.partnerId, 25, { rateLimited: true });

    const quota = checkRateLimit(findApiKey(issued.apiKey));
    expect(quota.used).toBe(100);
    expect(quota.allowed).toBe(false);
    // They are still visible in the analytics.
    expect(getErrorRates({ partnerId: issued.partnerId }).rateLimited).toBe(25);
  });

  test("skipMetering reports usage without consuming quota", () => {
    const issued = issueApiKey({ partnerId: "free-co", partnerName: "Free Co" });
    recordCalls(issued.keyId, issued.partnerId, 100);

    const quota = checkRateLimit(findApiKey(issued.apiKey), { skipMetering: true });
    expect(quota.allowed).toBe(true);
    expect(quota.remaining).toBeNull();
    expect(quota.dailyUsed).toBe(100);
  });

  test("falls back to the tier default when the key has no stored limit", () => {
    expect(getEffectiveLimits({ tier: "free" })).toEqual({ dailyLimit: 100, monthlyLimit: null });
    expect(getEffectiveLimits({ tier: "pro" })).toEqual({ dailyLimit: null, monthlyLimit: 10_000 });
    expect(getEffectiveLimits(null)).toEqual({ dailyLimit: null, monthlyLimit: null });
  });
});

// ─── Metering ─────────────────────────────────────────────────────────────────

describe("api-metering :: call recording", () => {
  test("records the endpoint, method, status and duration", () => {
    const issued = issueApiKey({ partnerId: "p1", partnerName: "P1" });
    expect(
      recordApiCall({
        keyId: issued.keyId,
        partnerId: issued.partnerId,
        endpoint: "/api/v1/royalty-split",
        method: "POST",
        statusCode: 201,
        durationMs: 44,
      })
    ).toBe(true);

    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]).toMatchObject({
      endpoint: "/api/v1/royalty-split",
      method: "POST",
      statusCode: 201,
      durationMs: 44,
      rateLimited: 0,
      bucketDay: dayBucket(),
    });
  });

  test("ignores incomplete events", () => {
    expect(recordApiCall({ keyId: "k" })).toBe(false);
    expect(fake.events).toHaveLength(0);
  });

  test("prunes events older than the retention window", () => {
    const issued = issueApiKey({ partnerId: "p1", partnerName: "P1" });
    recordApiCall({
      keyId: issued.keyId,
      partnerId: issued.partnerId,
      endpoint: "/a",
      method: "GET",
      statusCode: 200,
    });
    // Rewrite the bucket so the row is 200 days old.
    const old = new Date();
    old.setUTCDate(old.getUTCDate() - 200);
    fake.events[0].bucketDay = dayBucket(old);

    expect(pruneApiCallEvents(90)).toBe(1);
    expect(fake.events).toHaveLength(0);
  });
});

// ─── Analytics ────────────────────────────────────────────────────────────────

describe("api-metering :: analytics", () => {
  test("reports calls over time and zero-fills quiet days", () => {
    const issued = issueApiKey({ partnerId: "p1", partnerName: "P1" });
    recordCalls(issued.keyId, issued.partnerId, 3);
    fake.events[2].statusCode = 500;
    fake.events[2].durationMs = 100;

    const { series, days } = getUsageOverTime({ days: 7 });
    expect(days).toBe(7);
    expect(series).toHaveLength(7);
    expect(series.at(-1)).toMatchObject({ day: dayBucket(), calls: 3, errors: 1, rateLimited: 0 });
    expect(series.slice(0, 6).every((p) => p.calls === 0)).toBe(true);
  });

  test("scopes analytics to a single partner", () => {
    const a = issueApiKey({ partnerId: "a", partnerName: "A" });
    const b = issueApiKey({ partnerId: "b", partnerName: "B" });
    recordCalls(a.keyId, "a", 4);
    recordCalls(b.keyId, "b", 9);

    expect(getErrorRates({ partnerId: "a" }).totalCalls).toBe(4);
    expect(getErrorRates({ partnerId: "b" }).totalCalls).toBe(9);
    expect(getErrorRates({}).totalCalls).toBe(13);
  });

  test("ranks top endpoints with their error rate", () => {
    const issued = issueApiKey({ partnerId: "p1", partnerName: "P1" });
    recordCalls(issued.keyId, issued.partnerId, 5, { endpoint: "/api/v1/royalty-split" });
    recordCalls(issued.keyId, issued.partnerId, 2, {
      endpoint: "/api/v1/contract/status",
      statusCode: 404,
    });

    const { endpoints } = getTopEndpoints({ days: 30, limit: 5 });
    expect(endpoints[0]).toMatchObject({
      endpoint: "/api/v1/royalty-split",
      method: "GET",
      calls: 5,
      errors: 0,
      errorRate: 0,
    });
    expect(endpoints[1]).toMatchObject({
      endpoint: "/api/v1/contract/status",
      calls: 2,
      errors: 2,
      errorRate: 100,
    });
  });

  test("splits errors into client and server classes", () => {
    const issued = issueApiKey({ partnerId: "p1", partnerName: "P1" });
    recordCalls(issued.keyId, issued.partnerId, 6);
    recordCalls(issued.keyId, issued.partnerId, 2, { statusCode: 400 });
    recordCalls(issued.keyId, issued.partnerId, 1, { statusCode: 503 });

    const rates = getErrorRates({ days: 30 });
    expect(rates.totalCalls).toBe(9);
    expect(rates.clientErrors).toBe(2);
    expect(rates.serverErrors).toBe(1);
    expect(rates.errorRate).toBeCloseTo(33.3, 1);
    expect(rates.byStatusCode[0]).toMatchObject({ statusCode: 200, calls: 6 });
  });

  test("clamps the analytics window", () => {
    expect(getUsageOverTime({ days: 0 }).days).toBe(1);
    expect(getUsageOverTime({ days: 10_000 }).days).toBe(365);
    expect(getUsageOverTime({ days: "abc" }).days).toBe(30);
  });
});

// ─── Pricing ──────────────────────────────────────────────────────────────────

describe("api-metering :: pricing", () => {
  test("exposes the tier catalogue", () => {
    const tiers = getPricingTiers();
    expect(tiers.map((t) => t.tier)).toEqual(["free", "pro", "enterprise"]);
    expect(PRICING_TIERS.free.dailyLimit).toBe(100);
    expect(PRICING_TIERS.pro.monthlyPriceCents).toBe(5_000);
  });

  test("charges the pro base fee plus per-call overage", () => {
    const under = calculateCharge({ tier: "pro", calls: 4_000 });
    expect(under).toMatchObject({
      baseCents: 5_000,
      overageCalls: 0,
      overageCents: 0,
      totalCents: 5_000,
      totalUsd: 50,
    });

    const over = calculateCharge({ tier: "pro", calls: 10_500 });
    expect(over.overageCalls).toBe(500);
    expect(over.overageCents).toBe(500);
    expect(over.totalCents).toBe(5_500);
    expect(over.totalUsd).toBe(55);
  });

  test("free tier is never charged and enterprise uses the negotiated fee", () => {
    expect(calculateCharge({ tier: "free", calls: 10_000 }).totalCents).toBe(0);

    const enterprise = calculateCharge({
      tier: "enterprise",
      calls: 1_000_000,
      monthlyPriceCents: 250_000,
    });
    expect(enterprise.baseCents).toBe(250_000);
    expect(enterprise.overageCents).toBe(0);
    expect(enterprise.totalUsd).toBe(2_500);
  });

  test("attributes revenue to each partner and ranks by value", () => {
    const pro = issueApiKey({ partnerId: "pro-co", partnerName: "Pro Co", tier: "pro" });
    const free = issueApiKey({ partnerId: "free-co", partnerName: "Free Co" });
    recordCalls(pro.keyId, "pro-co", 10_200);
    recordCalls(free.keyId, "free-co", 50);

    const revenue = getRevenueByPartner({ days: 30 });
    expect(revenue.partners[0].partnerId).toBe("pro-co");
    expect(revenue.partners[0].totalCents).toBe(5_200);
    expect(revenue.partners[1].totalCents).toBe(0);
    expect(revenue.totals.totalUsd).toBe(52);
    expect(revenue.totals.partners).toBe(2);
  });

  test("surfaces a negotiated enterprise fee separately from tier pricing", () => {
    issueApiKey({
      partnerId: "ent-co",
      partnerName: "Ent Co",
      tier: "enterprise",
      monthlyPriceCents: 120_000,
    });

    const [partner] = getRevenueByPartner({ days: 30 }).partners;
    expect(partner.negotiated).toBe(true);
    expect(partner.totalCents).toBe(120_000);
  });

  test("overview counts keys, tiers, calls and MRR", () => {
    issueApiKey({ partnerId: "a", partnerName: "A" });
    const revoked = issueApiKey({ partnerId: "b", partnerName: "B", tier: "pro" });
    revokeApiKey(revoked.id);

    const overview = getPartnerOverview({ days: 30 });
    expect(overview.totalKeys).toBe(2);
    expect(overview.activeKeys).toBe(1);
    expect(overview.revokedKeys).toBe(1);
    expect(overview.partners).toBe(2);
    expect(overview.keysByTier).toEqual({ free: 1, pro: 0, enterprise: 0 });
  });
});
