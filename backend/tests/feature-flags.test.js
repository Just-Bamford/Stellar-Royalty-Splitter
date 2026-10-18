import { describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";
import request from "supertest";
import express from "express";

import {
  initializeFeatureFlagTables,
  clearFeatureFlagTables,
} from "../src/database/feature-flags.js";

import {
  createFlag,
  getFlag,
  listFlags,
  updateFlag,
  deleteFlag,
  addRule,
  removeRule,
  setRollout,
  rollback,
  getHistory,
  recordMetric,
  getMetrics,
  monitorRollout,
  isEnabled,
  evaluateAll,
  stableBucket,
  invalidateFlagCache,
} from "../src/services/feature-flags.js";

import { featureFlagsRouter } from "../src/routes/feature-flags.js";
import { attachFeatureFlags } from "../src/middleware/feature-flag-resolver.js";

const ADMIN_TOKEN = "test-admin-token";
const originalToken = process.env.ADMIN_ROTATE_TOKEN;

const app = express();
app.use(express.json());
app.use(attachFeatureFlags);
app.use("/api/v1/feature-flags", featureFlagsRouter);

const WALLET = "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C";

function asAdmin(reqBuilder) {
  return reqBuilder.set("Authorization", `Bearer ${ADMIN_TOKEN}`);
}

describe("Feature Flags & Gradual Rollout", () => {
  beforeAll(() => {
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.ADMIN_ROTATE_TOKEN;
    else process.env.ADMIN_ROTATE_TOKEN = originalToken;
  });

  beforeEach(() => {
    initializeFeatureFlagTables();
    clearFeatureFlagTables();
    invalidateFlagCache();
  });

  describe("Service: flags and runtime toggling", () => {
    test("creates a disabled flag and validates input", () => {
      const flag = createFlag({ name: "new-dashboard", description: "New dashboard" });
      expect(flag.name).toBe("new-dashboard");
      expect(flag.enabled).toBe(false);
      expect(flag.rolloutPercentage).toBe(100);

      expect(() => createFlag({ name: "new-dashboard" })).toThrow(/already exists/);
      expect(() => createFlag({ name: "has spaces" })).toThrow(/Invalid flag name/);
      expect(() => createFlag({ name: "ok", rolloutPercentage: 150 })).toThrow(/between 0 and 100/);
    });

    test("toggles a flag at runtime without code changes", () => {
      createFlag({ name: "beta" });
      expect(isEnabled("beta", { walletAddress: WALLET })).toBe(false);

      updateFlag("beta", { enabled: true });
      expect(isEnabled("beta", { walletAddress: WALLET })).toBe(true);

      updateFlag("beta", { enabled: false });
      expect(isEnabled("beta", { walletAddress: WALLET })).toBe(false);
    });

    test("returns false for unknown flags", () => {
      expect(isEnabled("missing", {})).toBe(false);
    });
  });

  describe("Service: targeting rules", () => {
    test("enables a disabled flag for a specific user", () => {
      createFlag({ name: "targeted" });
      addRule("targeted", { ruleType: "user", value: WALLET, enabled: true });

      expect(isEnabled("targeted", { walletAddress: WALLET })).toBe(true);
      expect(isEnabled("targeted", { walletAddress: "GOTHER" })).toBe(false);
    });

    test("disables a flag for a specific org while enabled globally", () => {
      createFlag({ name: "global", enabled: true });
      addRule("global", { ruleType: "org", value: "org-blocked", enabled: false });

      expect(isEnabled("global", { walletAddress: "GX", orgId: "org-allowed" })).toBe(true);
      expect(isEnabled("global", { walletAddress: "GX", orgId: "org-blocked" })).toBe(false);
    });

    test("evaluates role rules and removes them", () => {
      createFlag({ name: "role-flag" });
      const rule = addRule("role-flag", { ruleType: "role", value: "operator", enabled: true });

      expect(isEnabled("role-flag", { role: "operator" })).toBe(true);
      expect(isEnabled("role-flag", { role: "viewer" })).toBe(false);

      removeRule("role-flag", rule.id);
      expect(isEnabled("role-flag", { role: "operator" })).toBe(false);
    });

    test("most specific rule wins (user over org)", () => {
      createFlag({ name: "precedence" });
      addRule("precedence", { ruleType: "org", value: "acme", enabled: false });
      addRule("precedence", { ruleType: "user", value: WALLET, enabled: true });

      expect(isEnabled("precedence", { walletAddress: WALLET, orgId: "acme" })).toBe(true);
      expect(isEnabled("precedence", { walletAddress: "GX", orgId: "acme" })).toBe(false);
    });
  });

  describe("Service: gradual rollout", () => {
    test("stableBucket is deterministic", () => {
      expect(stableBucket("flag", WALLET)).toBe(stableBucket("flag", WALLET));
    });

    test("rolls out to roughly the configured percentage", () => {
      createFlag({ name: "percent" });
      setRollout("percent", 10);

      let enabled = 0;
      const total = 2000;
      for (let i = 0; i < total; i += 1) {
        if (isEnabled("percent", { walletAddress: `GUSER${i}` })) enabled += 1;
      }

      const ratio = enabled / total;
      expect(ratio).toBeGreaterThan(0.05);
      expect(ratio).toBeLessThan(0.18);

      // Same user always gets the same answer.
      const first = isEnabled("percent", { walletAddress: "GSTICKY" });
      expect(isEnabled("percent", { walletAddress: "GSTICKY" })).toBe(first);
    });

    test("100% rollout enables all identified callers", () => {
      createFlag({ name: "full" });
      setRollout("full", 100);
      expect(isEnabled("full", { walletAddress: WALLET })).toBe(true);
      expect(isEnabled("full", { walletAddress: "GANOTHER" })).toBe(true);
    });

    test("0% rollout disables everyone", () => {
      createFlag({ name: "zero", enabled: true });
      setRollout("zero", 0);
      expect(isEnabled("zero", { walletAddress: WALLET })).toBe(false);
    });
  });

  describe("Service: rollback safety", () => {
    test("rollback kills the flag even when a rule targets a user", () => {
      createFlag({ name: "risky", enabled: true });
      addRule("risky", { ruleType: "user", value: WALLET, enabled: true });
      expect(isEnabled("risky", { walletAddress: WALLET })).toBe(true);

      rollback("risky", "admin", "errors spiking");
      expect(isEnabled("risky", { walletAddress: WALLET })).toBe(false);
      expect(getFlag("risky").killed).toBe(true);
    });

    test("archiving removes a flag from evaluation and the default list", () => {
      createFlag({ name: "old", enabled: true });
      deleteFlag("old");
      expect(isEnabled("old", { walletAddress: WALLET })).toBe(false);
      expect(listFlags().find((f) => f.name === "old")).toBeUndefined();
      expect(listFlags({ includeArchived: true }).find((f) => f.name === "old")).toBeDefined();
    });
  });

  describe("Service: metrics and monitoring", () => {
    test("aggregates errors and latency", () => {
      createFlag({ name: "monitored", enabled: true });
      for (let i = 0; i < 10; i += 1) recordMetric("monitored", { metricType: "request" });
      for (let i = 0; i < 3; i += 1) recordMetric("monitored", { metricType: "error", value: 1 });
      recordMetric("monitored", { metricType: "latency", value: 100 });
      recordMetric("monitored", { metricType: "latency", value: 2000 });

      const metrics = getMetrics("monitored");
      expect(metrics.requests).toBe(10);
      expect(metrics.errors).toBe(3);
      expect(metrics.errorRate).toBeCloseTo(0.3);
      expect(metrics.maxLatencyMs).toBe(2000);
    });

    test("monitorRollout auto-rolls back an unhealthy flag and records it", () => {
      createFlag({ name: "sick", enabled: true });
      for (let i = 0; i < 10; i += 1) recordMetric("sick", { metricType: "request" });
      for (let i = 0; i < 5; i += 1) recordMetric("sick", { metricType: "error", value: 1 });

      const result = monitorRollout("sick", { thresholds: { maxErrorRate: 0.05 } });
      expect(result.healthy).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(isEnabled("sick", { walletAddress: WALLET })).toBe(false);

      const history = getHistory("sick");
      expect(history.some((h) => h.action === "rollback")).toBe(true);
    });

    test("healthy flag is not rolled back", () => {
      createFlag({ name: "healthy", enabled: true });
      recordMetric("healthy", { metricType: "request" });
      const result = monitorRollout("healthy");
      expect(result.healthy).toBe(true);
      expect(result.rolledBack).toBe(false);
      expect(isEnabled("healthy", { walletAddress: WALLET })).toBe(true);
    });
  });

  describe("Service: history and bulk evaluation", () => {
    test("records a complete change history", () => {
      createFlag({ name: "audited" });
      updateFlag("audited", { enabled: true });
      setRollout("audited", 25);
      addRule("audited", { ruleType: "org", value: "acme", enabled: true });

      const actions = getHistory("audited").map((h) => h.action);
      expect(actions).toContain("create");
      expect(actions).toContain("update");
      expect(actions).toContain("rollout");
      expect(actions).toContain("rule_add");
    });

    test("evaluateAll only evaluates requested flags", () => {
      createFlag({ name: "a", enabled: true });
      createFlag({ name: "b", enabled: false });

      const result = evaluateAll({ walletAddress: WALLET }, ["a", "b"]);
      expect(result).toEqual({ a: true, b: false });
    });
  });

  describe("REST API", () => {
    test("rejects unauthenticated flag creation", async () => {
      const res = await request(app).post("/api/v1/feature-flags").send({ name: "nope" });
      expect(res.status).toBe(401);
    });

    test("supports create, read, update, rules, rollout and rollback", async () => {
      const created = await asAdmin(request(app).post("/api/v1/feature-flags")).send({
        name: "checkout-v2",
        description: "New checkout",
      });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe("checkout-v2");

      const list = await request(app).get("/api/v1/feature-flags");
      expect(list.status).toBe(200);
      expect(list.body.flags).toHaveLength(1);

      const patched = await asAdmin(request(app).patch("/api/v1/feature-flags/checkout-v2")).send({
        enabled: true,
      });
      expect(patched.status).toBe(200);
      expect(patched.body.enabled).toBe(true);

      const rule = await asAdmin(
        request(app).post("/api/v1/feature-flags/checkout-v2/rules")
      ).send({ ruleType: "user", value: WALLET, enabled: true });
      expect(rule.status).toBe(201);

      const rollout = await asAdmin(
        request(app).post("/api/v1/feature-flags/checkout-v2/rollout")
      ).send({ percentage: 50 });
      expect(rollout.status).toBe(200);
      expect(rollout.body.rolloutPercentage).toBe(50);

      const evaluated = await request(app)
        .get(`/api/v1/feature-flags/evaluate/checkout-v2?walletAddress=${WALLET}`);
      expect(evaluated.status).toBe(200);
      expect(evaluated.body.enabled).toBe(true);

      const rolledBack = await asAdmin(
        request(app).post("/api/v1/feature-flags/checkout-v2/rollback")
      ).send({ reason: "manual" });
      expect(rolledBack.status).toBe(200);
      expect(rolledBack.body.killed).toBe(true);

      const afterRollback = await request(app)
        .get(`/api/v1/feature-flags/evaluate/checkout-v2?walletAddress=${WALLET}`);
      expect(afterRollback.body.enabled).toBe(false);
    });

    test("records metrics, reports health and history", async () => {
      await asAdmin(request(app).post("/api/v1/feature-flags")).send({
        name: "svc",
        enabled: true,
      });

      await asAdmin(request(app).post("/api/v1/feature-flags/svc/metrics")).send({
        metricType: "request",
      });
      await asAdmin(request(app).post("/api/v1/feature-flags/svc/metrics")).send({
        metricType: "error",
        value: 1,
      });

      const metrics = await asAdmin(request(app).get("/api/v1/feature-flags/svc/metrics"));
      expect(metrics.status).toBe(200);
      expect(metrics.body.metrics.requests).toBe(1);
      expect(metrics.body.metrics.errors).toBe(1);

      const monitor = await asAdmin(
        request(app).post("/api/v1/feature-flags/svc/monitor")
      ).send({ maxErrorRate: 0.01 });
      expect(monitor.status).toBe(200);
      expect(monitor.body.rolledBack).toBe(true);

      const history = await asAdmin(request(app).get("/api/v1/feature-flags/svc/history"));
      expect(history.status).toBe(200);
      expect(history.body.history.some((h) => h.action === "rollback")).toBe(true);
    });

    test("returns 404 for unknown flags", async () => {
      const res = await request(app).get("/api/v1/feature-flags/does-not-exist");
      expect(res.status).toBe(404);
    });

    test("validates create payloads", async () => {
      const res = await asAdmin(request(app).post("/api/v1/feature-flags")).send({
        name: "bad name!",
      });
      expect(res.status).toBe(400);
    });
  });
});
