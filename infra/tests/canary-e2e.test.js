/**
 * End-to-end canary simulation (#936).
 *
 * Real HTTP servers stand in for the stable and canary API processes, each
 * exposing /metrics in the backend's format. A weighted proxy plays the ALB.
 * Traffic flows through the proxy while the controller shifts weights, scrapes
 * both versions, and decides — so this exercises the actual control loop, not
 * a mocked one.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";

import { CanaryController, DirectMetricsSource } from "../canary-controller.js";

const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** A fake API version: behaviour is adjustable while it runs. */
async function startVersion({ errorRate = 0, latencyMs = 1 } = {}) {
  const state = { errorRate, latencyMs, served: 0, counts: new Map(), buckets: new Array(BUCKETS.length + 1).fill(0) };
  let seq = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/metrics") {
      const lines = [];
      for (const [status, n] of state.counts) {
        lines.push(`http_requests_total{method="GET",route="/api/v1/history/:contractId",status="${status}"} ${n}`);
      }
      let cumulative = 0;
      BUCKETS.forEach((le, i) => {
        cumulative += state.buckets[i];
        lines.push(`http_request_duration_seconds_bucket{le="${le}",method="GET",route="/api/v1/history/:contractId",status="200"} ${cumulative}`);
      });
      cumulative += state.buckets[BUCKETS.length];
      lines.push(`http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/api/v1/history/:contractId",status="200"} ${cumulative}`);
      res.setHeader("Content-Type", "text/plain");
      return res.end(`${lines.join("\n")}\n`);
    }
    state.served += 1;
    seq += 1;
    // Deterministic error injection: every Nth request fails.
    const fail = state.errorRate > 0 && seq % Math.round(1 / state.errorRate) === 0;
    const status = fail ? 500 : 200;
    setTimeout(() => {
      const seconds = state.latencyMs / 1000;
      const idx = BUCKETS.findIndex((le) => seconds <= le);
      state.buckets[idx === -1 ? BUCKETS.length : idx] += 1;
      state.counts.set(status, (state.counts.get(status) ?? 0) + 1);
      res.statusCode = status;
      res.end(fail ? "boom" : "ok");
    }, state.latencyMs);
  });
  const port = await listen(server);
  return { state, server, url: `http://127.0.0.1:${port}` };
}

/** Plays the ALB: deterministic weighted split between two upstreams. */
async function startProxy(stableUrl, canaryUrl) {
  const proxy = { weight: 0, n: 0 };
  const server = http.createServer((req, res) => {
    const before = Math.floor((proxy.n * proxy.weight) / 100);
    proxy.n += 1;
    const toCanary = Math.floor((proxy.n * proxy.weight) / 100) > before;
    const upstream = new URL(req.url, toCanary ? canaryUrl : stableUrl);
    const up = http.request(upstream, { method: req.method, headers: req.headers }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on("error", () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(up);
  });
  const port = await listen(server);
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    router: { setCanaryWeight: async (p) => { proxy.weight = p; proxy.n = 0; } },
    get weight() { return proxy.weight; },
  };
}

async function sendTraffic(url, count, concurrency = 25) {
  let next = 0;
  const statuses = [];
  const worker = async () => {
    while (next < count) {
      next += 1;
      const res = await fetch(`${url}/api/v1/history/CABC`).catch(() => null);
      statuses.push(res?.status ?? 0);
      await res?.arrayBuffer().catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return statuses;
}

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
});

async function setup({ canary: canaryBehaviour = {}, stable: stableBehaviour = {} } = {}) {
  const stable = await startVersion(stableBehaviour);
  const canary = await startVersion(canaryBehaviour);
  const proxy = await startProxy(stable.url, canary.url);
  servers.push(stable.server, canary.server, proxy.server);
  return { stable, canary, proxy };
}

function controllerFor({ stable, canary, proxy }, { requestsPerWindow = 500, onWindow, ...options } = {}) {
  let window = 0;
  return new CanaryController({
    router: proxy.router,
    metrics: new DirectMetricsSource({ stableUrl: `${stable.url}/metrics`, canaryUrl: `${canary.url}/metrics` }),
    stages: [
      { percent: 1, bakeSeconds: 3 },
      { percent: 5, bakeSeconds: 2 },
      { percent: 25, bakeSeconds: 2 },
      { percent: 100, bakeSeconds: 0 },
    ],
    checkIntervalMs: 1000,
    thresholds: { minRequests: 5 },
    // Instead of waiting a real minute, each "interval" drives a window of traffic.
    sleep: async () => {
      window += 1;
      await onWindow?.(window);
      await sendTraffic(proxy.url, requestsPerWindow);
    },
    ...options,
  });
}

describe("canary deployment (end to end)", { timeout: 60_000 }, () => {
  test("a healthy canary starts at 1% and is promoted to 100% through every stage", async () => {
    const env = await setup();
    const seen = [];
    const final = await controllerFor(env, { onStatus: async (s) => seen.push(s.trafficPercent) }).run();

    assert.equal(final.state, "promoted");
    assert.equal(env.proxy.weight, 100);
    assert.deepEqual([...new Set(seen)], [0, 1, 5, 25, 100]);
    assert.ok(final.history[0].canary.requests >= 5, "the canary received real traffic at 1%");
    assert.ok(final.history.every((c) => c.verdict === "pass"));

    const before = env.canary.state.served;
    await sendTraffic(env.proxy.url, 50);
    assert.equal(env.canary.state.served - before, 50, "all traffic now reaches the new version");
  });

  test("an error-rate spike at 1% triggers an automatic rollback to 0%", async () => {
    const env = await setup({ canary: { errorRate: 0.5 } });
    const final = await controllerFor(env).run();

    assert.equal(final.state, "rolled_back");
    assert.equal(final.stageIndex, 0, "rolled back during the first (1%) stage");
    assert.equal(env.proxy.weight, 0);
    assert.match(final.reason, /error rate/);

    const before = env.canary.state.served;
    const statuses = await sendTraffic(env.proxy.url, 100);
    assert.equal(env.canary.state.served, before, "no traffic reaches the canary after rollback");
    assert.ok(statuses.every((s) => s === 200), "users only see the stable version");
  });

  test("errors that start mid-rollout (at 5%) still roll back", async () => {
    const env = await setup();
    const final = await controllerFor(env, {
      onWindow: (w) => {
        // Windows 1-3 are the 1% stage; break the canary once it reaches 5%.
        if (w === 4) env.canary.state.errorRate = 0.25;
      },
    }).run();
    assert.equal(final.state, "rolled_back");
    assert.equal(final.stages[final.stageIndex].percent, 5);
    assert.equal(env.proxy.weight, 0);
  });

  test("a latency regression triggers rollback", async () => {
    const env = await setup({ canary: { latencyMs: 120 }, stable: { latencyMs: 2 } });
    const final = await controllerFor(env, { thresholds: { minRequests: 5, maxP95LatencyMs: 100 } }).run();
    assert.equal(final.state, "rolled_back");
    assert.match(final.reason, /p95 latency/);
    assert.equal(env.proxy.weight, 0);
  });

  test("a canary that crashes mid-rollout is rolled back", async () => {
    const env = await setup();
    const final = await controllerFor(env, {
      onWindow: async (w) => {
        if (w === 2) await new Promise((r) => { env.canary.server.closeAllConnections?.(); env.canary.server.close(() => r()); });
      },
    }).run();
    assert.equal(final.state, "rolled_back");
    assert.equal(env.proxy.weight, 0);
  });
});
