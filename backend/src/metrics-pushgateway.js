import logger from "./logger.js";
import { prometheusMetrics } from "./metrics.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_JOB = "stellar-royalty-splitter";
const MAX_BACKOFF_MS = 5 * 60_000;

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

export function getPushgatewayConfig(env = process.env) {
  const url = env.PROMETHEUS_PUSHGATEWAY_URL?.trim();
  if (!url) return { enabled: false };

  return {
    enabled: true,
    url: trimTrailingSlash(url),
    job: env.PROMETHEUS_PUSHGATEWAY_JOB?.trim() || DEFAULT_JOB,
    instance: env.PROMETHEUS_PUSHGATEWAY_INSTANCE?.trim() || undefined,
    intervalMs: Number.parseInt(env.PROMETHEUS_PUSH_INTERVAL_MS ?? "", 10) || DEFAULT_INTERVAL_MS,
  };
}

export function buildPushgatewayUrl(config) {
  const parts = [config.url, "metrics", "job", encodeURIComponent(config.job)];
  if (config.instance) {
    parts.push("instance", encodeURIComponent(config.instance));
  }
  return parts.join("/");
}

export function createMetricsPusher({
  config = getPushgatewayConfig(),
  metricsProvider = prometheusMetrics,
  fetchImpl = globalThis.fetch,
  log = logger,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let timer = null;
  let failureCount = 0;
  let stopped = false;

  async function pushOnce() {
    if (!config.enabled) return { skipped: true };
    const response = await fetchImpl(buildPushgatewayUrl(config), {
      method: "PUT",
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      // `prometheusMetrics()` is async (prom-client's registry export is
      // promise-based) — awaiting it keeps the PUT body a real string.
      body: await metricsProvider(),
    });
    if (!response.ok) {
      throw new Error(`Pushgateway responded with ${response.status}`);
    }
    failureCount = 0;
    return { ok: true };
  }

  async function tick() {
    try {
      await pushOnce();
    } catch (error) {
      failureCount += 1;
      const backoffMs = Math.min(config.intervalMs * 2 ** failureCount, MAX_BACKOFF_MS);
      log.warn("Prometheus Pushgateway push failed", {
        error: error.message,
        failureCount,
        backoffMs,
      });
      if (!stopped && timer) {
        clearIntervalImpl(timer);
        timer = setIntervalImpl(tick, backoffMs);
        timer.unref?.();
      }
    }
  }

  function start() {
    if (!config.enabled || timer) return { started: false };
    timer = setIntervalImpl(tick, config.intervalMs);
    timer.unref?.();
    tick();
    return { started: true };
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
  }

  return { start, stop, pushOnce, getFailureCount: () => failureCount };
}
