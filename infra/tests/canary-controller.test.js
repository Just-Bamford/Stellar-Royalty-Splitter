/**
 * Canary controller (#936): health evaluation, metric parsing, and the
 * stage/rollback state machine with in-memory fakes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CanaryController,
  NoopTrafficRouter,
  AlbTrafficRouter,
  evaluateHealth,
  parsePrometheusText,
  parseStages,
  quantileFromBuckets,
  statusToMarkdown,
  statusToPrometheus,
  summarizeHttpMetrics,
} from "../canary-controller.js";

const healthy = { canary: { requests: 100, errors: 0, p95Ms: 120 }, stable: { requests: 1000, errors: 2, p95Ms: 110 } };

describe("evaluateHealth", () => {
  test("passes a canary that matches stable", () => {
    assert.equal(evaluateHealth(healthy).verdict, "pass");
  });

  test("fails on absolute error rate", () => {
    const r = evaluateHealth({ ...healthy, canary: { requests: 100, errors: 10, p95Ms: 100 } });
    assert.equal(r.verdict, "fail");
    assert.match(r.reasons.join(), /error rate 10.00% > 5.00%/);
  });

  test("fails on error rate relative to stable even under the absolute limit", () => {
    const r = evaluateHealth({ canary: { requests: 100, errors: 4, p95Ms: 100 }, stable: { requests: 1000, errors: 0, p95Ms: 100 } });
    assert.equal(r.verdict, "fail");
    assert.match(r.reasons.join(), /pp above stable/);
  });

  test("fails on latency, absolute and relative", () => {
    assert.match(evaluateHealth({ ...healthy, canary: { requests: 100, errors: 0, p95Ms: 2500 } }).reasons.join(), /> 2000ms/);
    assert.match(evaluateHealth({ ...healthy, canary: { requests: 100, errors: 0, p95Ms: 400 } }).reasons.join(), /x stable/);
  });

  test("does not judge a window with too little canary traffic", () => {
    const r = evaluateHealth({ ...healthy, canary: { requests: 3, errors: 3, p95Ms: 9000 } });
    assert.equal(r.verdict, "insufficient_data");
  });
});

describe("metric parsing", () => {
  const text = `
# HELP http_requests_total x
http_requests_total{method="GET",route="/api/v1/history/:contractId",status="200"} 90
http_requests_total{method="POST",route="/api/v1/distribute",status="500"} 10
http_requests_total{method="GET",route="/metrics",status="200"} 500
http_request_duration_seconds_bucket{le="0.1",method="GET",route="/a",status="200"} 50
http_request_duration_seconds_bucket{le="0.5",method="GET",route="/a",status="200"} 90
http_request_duration_seconds_bucket{le="+Inf",method="GET",route="/a",status="200"} 100
`;

  test("parses labels and values", () => {
    const samples = parsePrometheusText(text);
    assert.equal(samples.length, 6);
    assert.deepEqual(samples[0].labels, { method: "GET", route: "/api/v1/history/:contractId", status: "200" });
    assert.equal(samples[5].value, 100);
  });

  test("summarises requests and errors, excluding scrape traffic", () => {
    const s = summarizeHttpMetrics(text);
    assert.equal(s.requests, 100);
    assert.equal(s.errors, 10);
    assert.equal(s.buckets.get(Infinity), 100);
  });

  test("interpolates quantiles like histogram_quantile()", () => {
    const buckets = [{ le: 0.1, count: 50 }, { le: 0.5, count: 90 }, { le: Infinity, count: 100 }];
    assert.ok(Math.abs(quantileFromBuckets(buckets, 0.5) - 0.1) < 1e-9);
    assert.ok(Math.abs(quantileFromBuckets(buckets, 0.7) - 0.3) < 1e-9);
    assert.equal(quantileFromBuckets(buckets, 0.95), 0.5);
    assert.equal(quantileFromBuckets([], 0.95), null);
  });

  test("parses stage specs", () => {
    assert.deepEqual(parseStages("1:1800,5:600,100:0"), [
      { percent: 1, bakeSeconds: 1800 },
      { percent: 5, bakeSeconds: 600 },
      { percent: 100, bakeSeconds: 0 },
    ]);
    assert.throws(() => parseStages("0:10"), /invalid stage/);
  });
});

function scriptedMetrics(samples) {
  let i = 0;
  return { sample: async () => samples[Math.min(i++, samples.length - 1)] };
}

const fastStages = [
  { percent: 1, bakeSeconds: 3 },
  { percent: 5, bakeSeconds: 2 },
  { percent: 25, bakeSeconds: 2 },
  { percent: 100, bakeSeconds: 0 },
];

describe("CanaryController", () => {
  test("defaults to 1% for 30 minutes, then 5% → 25% → 100%", () => {
    const c = new CanaryController({ router: new NoopTrafficRouter(), metrics: scriptedMetrics([healthy]) });
    assert.deepEqual(c.stages.map((s) => s.percent), [1, 5, 25, 100]);
    assert.equal(c.stages[0].bakeSeconds, 1800);
  });

  test("walks every stage and promotes a healthy canary", async () => {
    const router = new NoopTrafficRouter();
    const weights = [];
    router.setCanaryWeight = async (p) => weights.push(p);
    const statuses = [];
    const c = new CanaryController({
      router,
      metrics: scriptedMetrics([healthy]),
      stages: fastStages,
      checkIntervalMs: 1000,
      sleep: async () => {},
      onStatus: async (s) => statuses.push(structuredClone(s)),
    });
    const final = await c.run();
    assert.equal(final.state, "promoted");
    assert.deepEqual(weights, [1, 5, 25, 100]);
    assert.equal(final.history.length, 3 + 2 + 2);
    assert.ok(statuses.some((s) => s.state === "baking" && s.trafficPercent === 1));
  });

  test("rolls back after consecutive failures, not after a single blip", async () => {
    const bad = { ...healthy, canary: { requests: 100, errors: 30, p95Ms: 100 } };
    const weights = [];
    const c = new CanaryController({
      router: { setCanaryWeight: async (p) => weights.push(p) },
      metrics: scriptedMetrics([bad, healthy, bad, bad]),
      stages: [{ percent: 1, bakeSeconds: 10 }, { percent: 100, bakeSeconds: 0 }],
      checkIntervalMs: 1000,
      sleep: async () => {},
    });
    const final = await c.run();
    assert.equal(final.state, "rolled_back");
    assert.equal(final.history.length, 4, "one blip is tolerated; two in a row are not");
    assert.deepEqual(weights, [1, 0]);
    assert.match(final.reason, /error rate 30.00%/);
  });

  test("rolls back a stage that never gets enough traffic to judge", async () => {
    const quiet = { canary: { requests: 1, errors: 0, p95Ms: 50 }, stable: healthy.stable };
    const c = new CanaryController({
      router: new NoopTrafficRouter(),
      metrics: scriptedMetrics([quiet]),
      stages: fastStages,
      checkIntervalMs: 1000,
      sleep: async () => {},
    });
    const final = await c.run();
    assert.equal(final.state, "rolled_back");
    assert.match(final.reason, /insufficient canary traffic/);
  });

  test("--allow-low-traffic promotes a quiet but error-free canary", async () => {
    const quiet = { canary: { requests: 1, errors: 0, p95Ms: 50 }, stable: healthy.stable };
    const c = new CanaryController({
      router: new NoopTrafficRouter(),
      metrics: scriptedMetrics([quiet]),
      stages: fastStages,
      checkIntervalMs: 1000,
      allowLowTraffic: true,
      sleep: async () => {},
    });
    assert.equal((await c.run()).state, "promoted");
  });

  test("rolls back when the metrics source errors", async () => {
    const router = new NoopTrafficRouter();
    const c = new CanaryController({
      router,
      metrics: { sample: async () => { throw new Error("scrape failed"); } },
      stages: fastStages,
      checkIntervalMs: 1000,
      sleep: async () => {},
    });
    const final = await c.run();
    assert.equal(final.state, "rolled_back");
    assert.equal(router.weight, 0);
    assert.match(final.reason, /controller error: scrape failed/);
  });

  test("refuses a stage plan that never reaches 100%", () => {
    assert.throws(
      () => new CanaryController({ router: new NoopTrafficRouter(), metrics: {}, stages: [{ percent: 5, bakeSeconds: 1 }] }),
      /100%/,
    );
  });
});

describe("routers and status rendering", () => {
  test("ALB router sends a weighted forward action", async () => {
    const calls = [];
    const router = new AlbTrafficRouter({
      ruleArn: "arn:rule",
      stableTargetGroupArn: "arn:stable",
      canaryTargetGroupArn: "arn:canary",
      region: "us-east-1",
      exec: async (cmd, args) => calls.push([cmd, args]),
    });
    await router.setCanaryWeight(5);
    const [cmd, args] = calls[0];
    assert.equal(cmd, "aws");
    assert.deepEqual(args.slice(0, 4), ["elbv2", "modify-rule", "--rule-arn", "arn:rule"]);
    const actions = JSON.parse(args[5]);
    assert.deepEqual(
      actions[0].ForwardConfig.TargetGroups.map((t) => t.Weight),
      [95, 5],
    );
  });

  test("renders status for Prometheus and the GitHub summary", async () => {
    const c = new CanaryController({
      router: new NoopTrafficRouter(),
      metrics: scriptedMetrics([healthy]),
      stages: fastStages,
      checkIntervalMs: 1000,
      sleep: async () => {},
    });
    const final = await c.run();
    assert.match(statusToPrometheus(final), /canary_traffic_percent 100/);
    assert.match(statusToPrometheus(final), /canary_state 2/);
    const md = statusToMarkdown(final);
    assert.match(md, /Canary ✅ promoted — 100% traffic/);
    assert.match(md, /\| 1 \| 1% \|/);
  });
});
