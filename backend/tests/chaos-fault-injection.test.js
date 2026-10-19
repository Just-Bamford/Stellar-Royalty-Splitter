import { jest, describe, expect, test } from "@jest/globals";
import { ChaosController, configureChaosFromEnv } from "../src/chaos/faultInjection.js";

describe("chaos fault injection (#966)", () => {
  test("is fail-safe and transparent when disabled", async () => {
    const controller = new ChaosController({ enabled: false, random: () => 0 });
    controller.configure({ mode: "rpc-timeout" });
    await expect(controller.run("rpc-timeout", async () => "healthy")).resolves.toBe("healthy");
    expect(controller.snapshot().injected).toBe(0);
  });

  test.each([
    ["rpc-timeout", "CHAOS_RPC_TIMEOUT", 504],
    ["database-unavailable", "CHAOS_DATABASE_UNAVAILABLE", 503],
    ["websocket-drop", "CHAOS_WEBSOCKET_DROP", undefined],
  ])("injects %s with a recovery-friendly error", async (mode, code, status) => {
    const controller = new ChaosController({ enabled: true, random: () => 0, logger: { warn: jest.fn() } });
    controller.configure({ mode, probability: 1 });
    await expect(controller.run(mode, async () => "must not run", { label: "test-boundary" })).rejects.toMatchObject({ code, ...(status ? { status } : {}) });
    expect(controller.snapshot().events[0]).toMatchObject({ mode, label: "test-boundary" });
  });

  test("latency spike delays the operation and then allows recovery", async () => {
    const controller = new ChaosController({ enabled: true, random: () => 0, logger: { warn: jest.fn() } });
    controller.configure({ mode: "latency-spike", probability: 1, latencyMs: 10 });
    const start = Date.now();
    await expect(controller.run("latency-spike", async () => "recovered")).resolves.toBe("recovered");
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
  });

  test("configures only requested staging modes from environment", () => {
    const controller = new ChaosController({ enabled: true, random: () => 1 });
    configureChaosFromEnv(controller, { CHAOS_ENABLED: "true", CHAOS_MODES: "rpc-timeout,latency-spike", CHAOS_PROBABILITY: "0.2", CHAOS_LATENCY_MS: "25" });
    expect(controller.snapshot().configuredModes).toEqual(["rpc-timeout", "latency-spike"]);
  });
});
