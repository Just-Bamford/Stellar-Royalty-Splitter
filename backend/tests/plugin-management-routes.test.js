/**
 * Tests for plugin management HTTP routes (#998).
 *
 * GET  /api/v1/plugins
 * GET  /api/v1/plugins/audit
 * POST /api/v1/plugins/reload
 * GET  /api/v1/plugins/:name
 * POST /api/v1/plugins/:name/enable
 * POST /api/v1/plugins/:name/disable
 * GET  /api/v1/plugins/:name/logs
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  asyncLocalStorage: { run: (_s, fn) => fn() },
}));

// Bypass RBAC so we don't need real API keys in tests
await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
  ROLES: ["viewer", "collaborator", "operator", "admin"],
}));

// Mock the plugin loader's loadAllPlugins so POST /reload doesn't scan the FS
const mockLoadAllPlugins = jest.fn(async () => 3);
await jest.unstable_mockModule("../src/plugins/plugin-loader.js", () => ({
  loadAllPlugins: mockLoadAllPlugins,
  startHotReload: jest.fn(() => ({ stop: jest.fn() })),
  stopHotReload: jest.fn(),
  PLUGINS_DIR: "/fake/plugins",
}));

// ---------------------------------------------------------------------------
// Dynamic imports (AFTER mocks are registered)
// ---------------------------------------------------------------------------

const express = (await import("express")).default;
const { pluginsRouter } = await import("../src/routes/plugins.js");
const {
  registerPlugin,
  unregisterPlugin,
  listPlugins,
  runHook,
  clearLogs,
} = await import("../src/plugins/plugin-framework.js");

const app = express();
app.use(express.json());
app.use("/api/v1/plugins", pluginsRouter);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanRegistry() {
  for (const p of listPlugins()) unregisterPlugin(p.name);
  clearLogs();
}

function makePlugin(name, hookNames = ["beforeDistribute"]) {
  const hooks = {};
  for (const h of hookNames) hooks[h] = async () => {};
  return { name, version: "1.0.0", description: `Test ${name}`, hooks };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  cleanRegistry();
  jest.clearAllMocks();
});

afterEach(() => {
  cleanRegistry();
});

// ===========================================================================
// GET /api/v1/plugins — list
// ===========================================================================

describe("GET /api/v1/plugins", () => {
  test("returns empty list when no plugins are registered", async () => {
    const res = await request(app).get("/api/v1/plugins");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  test("returns all registered plugins with metadata", async () => {
    registerPlugin(makePlugin("alpha", ["beforeDistribute", "afterDistribute"]));
    registerPlugin(makePlugin("beta", ["onDispute"]));

    const res = await request(app).get("/api/v1/plugins");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);

    const names = res.body.data.map((p) => p.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");

    const alpha = res.body.data.find((p) => p.name === "alpha");
    expect(alpha.version).toBe("1.0.0");
    expect(alpha.enabled).toBe(true);
    expect(alpha.hooks).toContain("beforeDistribute");
  });
});

// ===========================================================================
// GET /api/v1/plugins/audit — audit log
// ===========================================================================

describe("GET /api/v1/plugins/audit", () => {
  test("returns empty audit log when nothing has run", async () => {
    const res = await request(app).get("/api/v1/plugins/audit");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  test("returns audit entries after hooks have fired", async () => {
    registerPlugin(makePlugin("audit-p", ["onPayment"]));
    await runHook("onPayment", { contractId: "C1" });

    const res = await request(app).get("/api/v1/plugins/audit");
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0]).toHaveProperty("hookName", "onPayment");
  });

  test("respects ?limit query param", async () => {
    registerPlugin(makePlugin("lim-p", ["onPayment"]));
    await runHook("onPayment", {});
    await runHook("onPayment", {});
    await runHook("onPayment", {});

    const res = await request(app).get("/api/v1/plugins/audit?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });
});

// ===========================================================================
// POST /api/v1/plugins/reload
// ===========================================================================

describe("POST /api/v1/plugins/reload", () => {
  test("returns success and loaded count", async () => {
    const res = await request(app).post("/api/v1/plugins/reload");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.loaded).toBe(3); // mocked to return 3
    expect(res.body.message).toContain("3 plugin(s)");
  });

  test("calls loadAllPlugins once", async () => {
    await request(app).post("/api/v1/plugins/reload");
    expect(mockLoadAllPlugins).toHaveBeenCalledTimes(1);
  });

  test("returns 500 when loadAllPlugins throws", async () => {
    mockLoadAllPlugins.mockRejectedValueOnce(new Error("FS error"));
    const res = await request(app).post("/api/v1/plugins/reload");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("plugin_reload_failed");
  });
});

// ===========================================================================
// GET /api/v1/plugins/:name — single plugin
// ===========================================================================

describe("GET /api/v1/plugins/:name", () => {
  test("returns plugin details when plugin is registered", async () => {
    registerPlugin(makePlugin("get-me"));
    const res = await request(app).get("/api/v1/plugins/get-me");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe("get-me");
  });

  test("returns 404 when plugin is not found", async () => {
    const res = await request(app).get("/api/v1/plugins/no-such-plugin");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("plugin_not_found");
  });
});

// ===========================================================================
// POST /api/v1/plugins/:name/enable
// ===========================================================================

describe("POST /api/v1/plugins/:name/enable", () => {
  test("enables a disabled plugin", async () => {
    registerPlugin(makePlugin("en-me"), undefined);
    // Manually disable it
    const { setPluginEnabled } = await import("../src/plugins/plugin-framework.js");
    setPluginEnabled("en-me", false);

    const res = await request(app).post("/api/v1/plugins/en-me/enable");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const listRes = await request(app).get("/api/v1/plugins");
    const plugin = listRes.body.data.find((p) => p.name === "en-me");
    expect(plugin.enabled).toBe(true);
  });

  test("returns 404 when plugin does not exist", async () => {
    const res = await request(app).post("/api/v1/plugins/ghost/enable");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("plugin_not_found");
  });
});

// ===========================================================================
// POST /api/v1/plugins/:name/disable
// ===========================================================================

describe("POST /api/v1/plugins/:name/disable", () => {
  test("disables an enabled plugin", async () => {
    registerPlugin(makePlugin("dis-me"));

    const res = await request(app).post("/api/v1/plugins/dis-me/disable");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const listRes = await request(app).get("/api/v1/plugins");
    const plugin = listRes.body.data.find((p) => p.name === "dis-me");
    expect(plugin.enabled).toBe(false);
  });

  test("returns 404 when plugin does not exist", async () => {
    const res = await request(app).post("/api/v1/plugins/ghost/disable");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("plugin_not_found");
  });
});

// ===========================================================================
// GET /api/v1/plugins/:name/logs
// ===========================================================================

describe("GET /api/v1/plugins/:name/logs", () => {
  test("returns empty logs for a plugin with no executions", async () => {
    registerPlugin(makePlugin("no-exec"));
    const res = await request(app).get("/api/v1/plugins/no-exec/logs");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  test("returns logs after hook execution", async () => {
    registerPlugin(makePlugin("exec-p", ["onPayment"]));
    await runHook("onPayment", { contractId: "C99" });

    const res = await request(app).get("/api/v1/plugins/exec-p/logs");
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0]).toHaveProperty("hookName", "onPayment");
    expect(res.body.data[0]).toHaveProperty("success");
  });

  test("respects ?limit query param", async () => {
    registerPlugin(makePlugin("lim-logs", ["onPayment"]));
    await runHook("onPayment", {});
    await runHook("onPayment", {});
    await runHook("onPayment", {});

    const res = await request(app).get("/api/v1/plugins/lim-logs/logs?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });

  test("returns 404 when plugin does not exist", async () => {
    const res = await request(app).get("/api/v1/plugins/no-such/logs");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("plugin_not_found");
  });
});
