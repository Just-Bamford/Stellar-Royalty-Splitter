/**
 * Opt-in fault injection for staging chaos runs (#966).
 *
 * The harness is disabled unless CHAOS_ENABLED=true. Faults are injected at
 * dependency boundaries, so production code can exercise retry/reconnect and
 * recovery paths without monkey-patching globals. Tests can use the same API
 * with a deterministic random source.
 */

const MODES = new Set(["rpc-timeout", "database-unavailable", "websocket-drop", "latency-spike"]);

export class ChaosController {
  constructor({ enabled = process.env.CHAOS_ENABLED === "true", random = Math.random, logger = console } = {}) {
    this.enabled = enabled;
    this.random = random;
    this.logger = logger;
    this.faults = new Map();
    this.events = [];
  }

  configure({ mode, probability = 1, latencyMs = 0 } = {}) {
    if (!MODES.has(mode)) throw new Error(`Unsupported chaos mode: ${mode}`);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("probability must be between 0 and 1");
    this.faults.set(mode, { probability, latencyMs });
    return this;
  }

  clear() { this.faults.clear(); this.events = []; }

  shouldInject(mode) {
    if (!this.enabled) return false;
    const fault = this.faults.get(mode);
    return Boolean(fault && this.random() < fault.probability);
  }

  async run(mode, operation, { label = mode } = {}) {
    const fault = this.faults.get(mode);
    if (!this.shouldInject(mode)) return operation();
    this.events.push({ mode, label, at: Date.now() });
    this.logger.warn?.({ mode, label }, "Chaos fault injected");
    if (mode === "rpc-timeout") throw Object.assign(new Error(`Injected RPC timeout: ${label}`), { code: "CHAOS_RPC_TIMEOUT", status: 504 });
    if (mode === "database-unavailable") throw Object.assign(new Error(`Injected database outage: ${label}`), { code: "CHAOS_DATABASE_UNAVAILABLE", status: 503 });
    if (mode === "websocket-drop") throw Object.assign(new Error(`Injected WebSocket disconnect: ${label}`), { code: "CHAOS_WEBSOCKET_DROP", retryable: true });
    if (mode === "latency-spike") await new Promise((resolve) => setTimeout(resolve, fault.latencyMs || 500));
    return operation();
  }

  snapshot() { return { enabled: this.enabled, configuredModes: [...this.faults.keys()], injected: this.events.length, events: [...this.events] }; }
}

export const chaos = new ChaosController();

export function configureChaosFromEnv(controller = chaos, env = process.env) {
  if (env.CHAOS_ENABLED !== "true") return controller;
  const probability = Number(env.CHAOS_PROBABILITY ?? "0.05");
  const latencyMs = Number(env.CHAOS_LATENCY_MS ?? "5000");
  for (const mode of String(env.CHAOS_MODES ?? "rpc-timeout,database-unavailable,websocket-drop,latency-spike").split(",").map((value) => value.trim()).filter(Boolean)) {
    controller.configure({ mode, probability, latencyMs });
  }
  return controller;
}
