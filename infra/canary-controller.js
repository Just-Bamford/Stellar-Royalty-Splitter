#!/usr/bin/env node
/**
 * canary-controller.js — progressive traffic shifting with automatic rollback (#936).
 *
 *   1%  of traffic for 30 minutes   ← the new version proves itself on real users
 *   5%  for 10 minutes
 *   25% for 10 minutes
 *   100%                            ← promoted
 *
 * Every check interval the controller samples the canary and the stable
 * version side by side and judges the canary on:
 *
 *   - absolute 5xx ratio        (default: fail above 5%)
 *   - 5xx ratio vs stable       (default: fail when 2 percentage points worse)
 *   - absolute p95 latency      (default: fail above 2000ms)
 *   - p95 latency vs stable     (default: fail when 1.5x slower)
 *
 * Ratios are only judged once a window has at least `minRequests` canary
 * requests, so a quiet minute cannot trigger a rollback on one unlucky
 * request. `failureThreshold` consecutive failing checks roll back: traffic
 * weight goes to 0% immediately and the process exits 1, failing the pipeline.
 * A stage that never sees enough traffic to judge also rolls back, unless
 * --allow-low-traffic is set: "no evidence" is not the same as "healthy".
 *
 * Architecture note: the application writes a single SQLite file, so the canary
 * runs as a second process on the same host (port 3002), not a second host.
 * The ALB splits traffic between a stable and a canary target group that point
 * at the two ports (infra/terraform/canary-deployment.tf). See
 * docs/canary-deployment.md.
 *
 * Usage:
 *   node infra/canary-controller.js run \
 *     --router alb --rule-arn <arn> --stable-tg <arn> --canary-tg <arn> \
 *     --metrics prometheus --prometheus-url http://prometheus:9090 \
 *     --status-file canary-status.json [--pushgateway-url http://pushgateway:9091]
 *
 *   node infra/canary-controller.js run --router none --metrics direct \
 *     --stable-metrics-url http://127.0.0.1:3001/metrics \
 *     --canary-metrics-url http://127.0.0.1:3002/metrics
 *
 *   node infra/canary-controller.js set-weight 0 --router alb ...   # manual rollback
 *   node infra/canary-controller.js status --status-file canary-status.json
 *
 * Exit codes: 0 promoted, 1 rolled back / error, 2 usage.
 */

import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

export const DEFAULT_STAGES = [
  { percent: 1, bakeSeconds: 30 * 60 },
  { percent: 5, bakeSeconds: 10 * 60 },
  { percent: 25, bakeSeconds: 10 * 60 },
  { percent: 100, bakeSeconds: 0 },
];

export const DEFAULT_THRESHOLDS = {
  maxErrorRate: 0.05,
  maxErrorRateIncrease: 0.02,
  maxP95LatencyMs: 2000,
  maxLatencyRatio: 1.5,
  minRequests: 20,
  failureThreshold: 2,
};

const HISTORY_LIMIT = 100;

// ── Health evaluation ──────────────────────────────────────────────────────

function ratio(errors, requests) {
  return requests > 0 ? errors / requests : 0;
}

/**
 * Judge one sample.
 * @param {{canary: {requests:number, errors:number, p95Ms:number|null},
 *          stable: {requests:number, errors:number, p95Ms:number|null}}} sample
 * @returns {{verdict: "pass"|"fail"|"insufficient_data", reasons: string[], canaryErrorRate: number, stableErrorRate: number}}
 */
export function evaluateHealth(sample, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const canaryErrorRate = ratio(sample.canary.errors, sample.canary.requests);
  const stableErrorRate = ratio(sample.stable.errors, sample.stable.requests);
  const base = { canaryErrorRate, stableErrorRate };

  if (sample.canary.requests < t.minRequests) {
    return {
      ...base,
      verdict: "insufficient_data",
      reasons: [`only ${sample.canary.requests} canary requests (need ${t.minRequests})`],
    };
  }

  const reasons = [];
  if (canaryErrorRate > t.maxErrorRate) {
    reasons.push(`error rate ${(canaryErrorRate * 100).toFixed(2)}% > ${(t.maxErrorRate * 100).toFixed(2)}%`);
  }
  if (sample.stable.requests >= t.minRequests && canaryErrorRate - stableErrorRate > t.maxErrorRateIncrease) {
    reasons.push(
      `error rate ${(canaryErrorRate * 100).toFixed(2)}% is ${((canaryErrorRate - stableErrorRate) * 100).toFixed(2)}pp above stable`,
    );
  }
  const canaryP95 = sample.canary.p95Ms;
  const stableP95 = sample.stable.p95Ms;
  if (Number.isFinite(canaryP95) && canaryP95 > t.maxP95LatencyMs) {
    reasons.push(`p95 latency ${canaryP95.toFixed(0)}ms > ${t.maxP95LatencyMs}ms`);
  }
  if (
    Number.isFinite(canaryP95) &&
    Number.isFinite(stableP95) &&
    stableP95 > 0 &&
    sample.stable.requests >= t.minRequests &&
    canaryP95 / stableP95 > t.maxLatencyRatio
  ) {
    reasons.push(`p95 latency ${(canaryP95 / stableP95).toFixed(2)}x stable (limit ${t.maxLatencyRatio}x)`);
  }
  return { ...base, verdict: reasons.length ? "fail" : "pass", reasons };
}

// ── Prometheus text parsing (for the direct metrics source) ────────────────

/** Parse Prometheus exposition text into [{name, labels, value}]. */
export function parsePrometheusText(text) {
  const samples = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels = {};
    if (m[3]) {
      for (const lm of m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        labels[lm[1]] = lm[2].replace(/\\(.)/g, "$1");
      }
    }
    const value = m[4] === "+Inf" ? Infinity : Number(m[4]);
    if (Number.isFinite(value) || value === Infinity) samples.push({ name: m[1], labels, value });
  }
  return samples;
}

/** Linear interpolation inside the bucket containing the quantile — as histogram_quantile() does. */
export function quantileFromBuckets(buckets, q) {
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  if (sorted.length === 0) return null;
  const total = sorted[sorted.length - 1].count;
  if (!(total > 0)) return null;
  const rank = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const { le, count } of sorted) {
    if (count >= rank) {
      if (le === Infinity) return prevLe;
      const inBucket = count - prevCount;
      return inBucket > 0 ? prevLe + (le - prevLe) * ((rank - prevCount) / inBucket) : le;
    }
    prevLe = le;
    prevCount = count;
  }
  return prevLe;
}

const DEFAULT_EXCLUDED_ROUTES = /^(\/metrics|\/api\/v1\/metrics|\/health|\/api\/v1\/health|\/live|\/ready)/;

/** Cumulative request/error counts and latency buckets from one /metrics scrape. */
export function summarizeHttpMetrics(text, excludeRoutes = DEFAULT_EXCLUDED_ROUTES) {
  let requests = 0;
  let errors = 0;
  const buckets = new Map();
  for (const s of parsePrometheusText(text)) {
    if (excludeRoutes.test(s.labels.route ?? "")) continue;
    if (s.name === "http_requests_total") {
      requests += s.value;
      if (/^5\d\d$/.test(s.labels.status ?? "")) errors += s.value;
    } else if (s.name === "http_request_duration_seconds_bucket") {
      const le = s.labels.le === "+Inf" ? Infinity : Number(s.labels.le);
      buckets.set(le, (buckets.get(le) ?? 0) + s.value);
    }
  }
  return { requests, errors, buckets };
}

function diffSummaries(current, previous) {
  // A counter that went down means the process restarted: treat the current
  // values as the whole window rather than reporting negative traffic.
  const reset = !previous || current.requests < previous.requests;
  const base = reset ? { requests: 0, errors: 0, buckets: new Map() } : previous;
  const buckets = [...current.buckets.entries()].map(([le, count]) => ({
    le,
    count: Math.max(0, count - (base.buckets.get(le) ?? 0)),
  }));
  const p95s = quantileFromBuckets(buckets, 0.95);
  return {
    requests: current.requests - base.requests,
    errors: current.errors - base.errors,
    p95Ms: p95s === null ? null : p95s * 1000,
  };
}

// ── Metrics sources ────────────────────────────────────────────────────────

/**
 * Scrapes each version's /metrics endpoint directly and reports the delta
 * since the previous scrape. Needs no Prometheus; used on-host and in tests.
 */
export class DirectMetricsSource {
  constructor({ stableUrl, canaryUrl, fetchImpl = globalThis.fetch, excludeRoutes }) {
    this.urls = { stable: stableUrl, canary: canaryUrl };
    this.fetch = fetchImpl;
    this.exclude = excludeRoutes ?? DEFAULT_EXCLUDED_ROUTES;
    this.previous = { stable: null, canary: null };
  }
  async #scrape(which) {
    const res = await this.fetch(this.urls[which], { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${which} metrics responded ${res.status}`);
    return summarizeHttpMetrics(await res.text(), this.exclude);
  }
  /** Establish the baseline so the first real sample is a clean window. */
  async prime() {
    this.previous.stable = await this.#scrape("stable");
    this.previous.canary = await this.#scrape("canary");
  }
  async sample() {
    const out = {};
    for (const which of ["stable", "canary"]) {
      const current = await this.#scrape(which);
      out[which] = diffSummaries(current, this.previous[which]);
      this.previous[which] = current;
    }
    return out;
  }
}

/**
 * Queries Prometheus. Stable and canary are told apart by the `deployment`
 * label that monitoring/prometheus.yml attaches to each scrape target.
 */
export class PrometheusMetricsSource {
  constructor({ url, window = "5m", fetchImpl = globalThis.fetch, stableSelector = 'deployment="stable"', canarySelector = 'deployment="canary"' }) {
    this.url = url.replace(/\/$/, "");
    this.window = window;
    this.fetch = fetchImpl;
    this.selectors = { stable: stableSelector, canary: canarySelector };
  }
  async #query(expr) {
    const res = await this.fetch(`${this.url}/api/v1/query?query=${encodeURIComponent(expr)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Prometheus responded ${res.status}`);
    const body = await res.json();
    const v = body?.data?.result?.[0]?.value?.[1];
    const n = v === undefined ? null : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  async prime() {}
  async sample() {
    const out = {};
    const excl = 'route!~"/metrics|/api/v1/metrics|/health.*|/api/v1/health.*"';
    for (const which of ["stable", "canary"]) {
      const sel = `${this.selectors[which]},${excl}`;
      const w = this.window;
      const [requests, errors, p95] = await Promise.all([
        this.#query(`sum(increase(http_requests_total{${sel}}[${w}]))`),
        this.#query(`sum(increase(http_requests_total{${sel},status=~"5.."}[${w}]))`),
        this.#query(`histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{${sel}}[${w}])))`),
      ]);
      out[which] = { requests: requests ?? 0, errors: errors ?? 0, p95Ms: p95 === null ? null : p95 * 1000 };
    }
    return out;
  }
}

// ── Traffic routers ────────────────────────────────────────────────────────

/** Weighted forward on the ALB listener rule created by canary-deployment.tf. */
export class AlbTrafficRouter {
  constructor({ ruleArn, stableTargetGroupArn, canaryTargetGroupArn, region = process.env.AWS_REGION || "us-east-1", exec = execFileAsync }) {
    for (const [k, v] of Object.entries({ ruleArn, stableTargetGroupArn, canaryTargetGroupArn })) {
      if (!v) throw new Error(`AlbTrafficRouter requires ${k}`);
    }
    Object.assign(this, { ruleArn, stableTargetGroupArn, canaryTargetGroupArn, region, exec });
  }
  async setCanaryWeight(percent) {
    const canary = Math.max(0, Math.min(100, Math.round(percent)));
    const actions = [
      {
        Type: "forward",
        ForwardConfig: {
          TargetGroups: [
            { TargetGroupArn: this.stableTargetGroupArn, Weight: 100 - canary },
            { TargetGroupArn: this.canaryTargetGroupArn, Weight: canary },
          ],
          TargetGroupStickinessConfig: { Enabled: false },
        },
      },
    ];
    await this.exec("aws", ["elbv2", "modify-rule", "--rule-arn", this.ruleArn, "--actions", JSON.stringify(actions), "--region", this.region]);
  }
}

/** Records the weight only — for dry runs and on-host rehearsals. */
export class NoopTrafficRouter {
  constructor() {
    this.weight = null;
  }
  async setCanaryWeight(percent) {
    this.weight = percent;
  }
}

// ── Status output (the "UI" data) ──────────────────────────────────────────

const STATE_CODES = { pending: 0, baking: 1, promoted: 2, rolled_back: 3, failed: 4 };

export function statusToPrometheus(status) {
  const lines = [
    "# HELP canary_traffic_percent Share of traffic currently routed to the canary.",
    "# TYPE canary_traffic_percent gauge",
    `canary_traffic_percent ${status.trafficPercent}`,
    "# HELP canary_stage Index of the current rollout stage (0-based).",
    "# TYPE canary_stage gauge",
    `canary_stage ${status.stageIndex}`,
    "# HELP canary_state Rollout state: 0 pending, 1 baking, 2 promoted, 3 rolled back, 4 failed.",
    "# TYPE canary_state gauge",
    `canary_state ${STATE_CODES[status.state] ?? -1}`,
    "# HELP canary_consecutive_failures Consecutive failing health checks.",
    "# TYPE canary_consecutive_failures gauge",
    `canary_consecutive_failures ${status.consecutiveFailures}`,
  ];
  const last = status.lastCheck;
  if (last) {
    lines.push(
      "# HELP canary_check_error_rate 5xx ratio in the last check window.",
      "# TYPE canary_check_error_rate gauge",
      `canary_check_error_rate{deployment="canary"} ${last.canaryErrorRate}`,
      `canary_check_error_rate{deployment="stable"} ${last.stableErrorRate}`,
      "# HELP canary_check_p95_latency_ms p95 latency in the last check window.",
      "# TYPE canary_check_p95_latency_ms gauge",
      `canary_check_p95_latency_ms{deployment="canary"} ${last.canary.p95Ms ?? "NaN"}`,
      `canary_check_p95_latency_ms{deployment="stable"} ${last.stable.p95Ms ?? "NaN"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function statusToMarkdown(status) {
  const icon = { promoted: "✅", rolled_back: "⏪", failed: "❌", baking: "⏳", pending: "…" }[status.state] ?? "";
  const rows = status.stages
    .map((s, i) => {
      const mark = i < status.stageIndex || status.state === "promoted" ? "done" : i === status.stageIndex ? status.state : "";
      return `| ${i + 1} | ${s.percent}% | ${Math.round(s.bakeSeconds / 60)} min | ${mark} |`;
    })
    .join("\n");
  const checks = status.history
    .slice(-10)
    .map(
      (c) =>
        `| ${c.at} | ${c.trafficPercent}% | ${c.verdict} | ${c.canary.requests} | ${(c.canaryErrorRate * 100).toFixed(2)}% / ${(c.stableErrorRate * 100).toFixed(2)}% | ${c.canary.p95Ms?.toFixed(0) ?? "–"} / ${c.stable.p95Ms?.toFixed(0) ?? "–"} ms | ${c.reasons.join("; ")} |`,
    )
    .join("\n");
  return [
    `## Canary ${icon} ${status.state.replace("_", " ")} — ${status.trafficPercent}% traffic`,
    status.reason ? `\n**Reason:** ${status.reason}\n` : "",
    "| Stage | Traffic | Bake | Status |",
    "|---|---|---|---|",
    rows,
    "",
    "### Recent checks",
    "| Time | Traffic | Verdict | Canary req | Error rate (canary / stable) | p95 (canary / stable) | Notes |",
    "|---|---|---|---|---|---|---|",
    checks || "| – | – | – | – | – | – | – |",
    "",
  ].join("\n");
}

// ── Controller ─────────────────────────────────────────────────────────────

export class CanaryController {
  constructor({
    router,
    metrics,
    stages = DEFAULT_STAGES,
    thresholds = {},
    checkIntervalMs = 60_000,
    allowLowTraffic = false,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => new Date(),
    onStatus = async () => {},
    log = () => {},
  }) {
    if (!stages.length || stages[stages.length - 1].percent !== 100) {
      throw new Error("the last stage must route 100% of traffic to the canary");
    }
    this.router = router;
    this.metrics = metrics;
    this.stages = stages;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.checkIntervalMs = checkIntervalMs;
    this.allowLowTraffic = allowLowTraffic;
    this.sleep = sleep;
    this.now = now;
    this.onStatus = onStatus;
    this.log = log;
    this.status = {
      state: "pending",
      stageIndex: 0,
      trafficPercent: 0,
      startedAt: now().toISOString(),
      updatedAt: now().toISOString(),
      stages,
      thresholds: this.thresholds,
      consecutiveFailures: 0,
      lastCheck: null,
      history: [],
      reason: null,
    };
  }

  async #publish(patch) {
    Object.assign(this.status, patch, { updatedAt: this.now().toISOString() });
    await this.onStatus(this.status);
  }

  async #setWeight(percent) {
    await this.router.setCanaryWeight(percent);
    await this.#publish({ trafficPercent: percent });
  }

  async rollback(reason) {
    this.log(`ROLLBACK: ${reason}`);
    try {
      await this.#setWeight(0);
      await this.#publish({ state: "rolled_back", reason });
    } catch (err) {
      await this.#publish({ state: "failed", reason: `${reason}; rollback itself failed: ${err.message}` });
      throw err;
    }
    return this.status;
  }

  /** Run the whole rollout. Resolves with the final status. */
  async run() {
    try {
      await this.metrics.prime?.();
      for (let i = 0; i < this.stages.length; i++) {
        const stage = this.stages[i];
        await this.#publish({ state: "baking", stageIndex: i, consecutiveFailures: 0 });
        await this.#setWeight(stage.percent);
        this.log(`stage ${i + 1}/${this.stages.length}: ${stage.percent}% for ${stage.bakeSeconds}s`);

        if (stage.percent === 100) break;

        const checks = Math.max(1, Math.ceil((stage.bakeSeconds * 1000) / this.checkIntervalMs));
        let judged = 0;
        for (let c = 0; c < checks; c++) {
          await this.sleep(this.checkIntervalMs);
          const sample = await this.metrics.sample();
          const result = evaluateHealth(sample, this.thresholds);
          const check = { at: this.now().toISOString(), trafficPercent: stage.percent, ...sample, ...result };
          const consecutiveFailures = result.verdict === "fail" ? this.status.consecutiveFailures + 1 : 0;
          if (result.verdict !== "insufficient_data") judged += 1;
          await this.#publish({
            lastCheck: check,
            history: [...this.status.history, check].slice(-HISTORY_LIMIT),
            consecutiveFailures,
          });
          this.log(`check ${c + 1}/${checks}: ${result.verdict}${result.reasons.length ? ` (${result.reasons.join("; ")})` : ""}`);

          if (consecutiveFailures >= this.thresholds.failureThreshold) {
            return await this.rollback(`health check failed at ${stage.percent}%: ${result.reasons.join("; ")}`);
          }
        }
        if (judged === 0 && !this.allowLowTraffic) {
          return await this.rollback(
            `insufficient canary traffic at ${stage.percent}%: no check reached ${this.thresholds.minRequests} requests`,
          );
        }
      }
      await this.#publish({ state: "promoted", reason: null });
      return this.status;
    } catch (err) {
      if (this.status.state === "rolled_back" || this.status.state === "failed") throw err;
      await this.rollback(`controller error: ${err.message}`);
      return this.status;
    }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function parseStages(spec) {
  return spec.split(",").map((part) => {
    const [percent, bake] = part.split(":").map(Number);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100 || !Number.isFinite(bake ?? 0) || (bake ?? 0) < 0) {
      throw new Error(`invalid stage "${part}" (expected percent:bakeSeconds)`);
    }
    return { percent, bakeSeconds: bake ?? 0 };
  });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { command, flags, positional };
}

function buildRouter(flags) {
  if ((flags.router ?? "none") === "none") return new NoopTrafficRouter();
  if (flags.router === "alb") {
    return new AlbTrafficRouter({
      ruleArn: flags["rule-arn"],
      stableTargetGroupArn: flags["stable-tg"],
      canaryTargetGroupArn: flags["canary-tg"],
      region: flags.region,
    });
  }
  throw new Error(`unknown router: ${flags.router}`);
}

function buildMetrics(flags) {
  if ((flags.metrics ?? "direct") === "direct") {
    if (!flags["stable-metrics-url"] || !flags["canary-metrics-url"]) {
      throw new Error("--stable-metrics-url and --canary-metrics-url are required with --metrics direct");
    }
    return new DirectMetricsSource({ stableUrl: flags["stable-metrics-url"], canaryUrl: flags["canary-metrics-url"] });
  }
  if (flags.metrics === "prometheus") {
    if (!flags["prometheus-url"]) throw new Error("--prometheus-url is required with --metrics prometheus");
    return new PrometheusMetricsSource({ url: flags["prometheus-url"], window: flags.window ?? "5m" });
  }
  throw new Error(`unknown metrics source: ${flags.metrics}`);
}

async function pushStatus(url, status) {
  const res = await fetch(`${url.replace(/\/$/, "")}/metrics/job/canary_controller`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain; version=0.0.4" },
    body: statusToPrometheus(status),
  });
  if (!res.ok) throw new Error(`pushgateway responded ${res.status}`);
}

const USAGE = `Usage: canary-controller.js <run|set-weight <percent>|status> [options]
  --router none|alb  --rule-arn --stable-tg --canary-tg --region
  --metrics direct|prometheus  --stable-metrics-url --canary-metrics-url --prometheus-url --window 5m
  --stages 1:1800,5:600,25:600,100:0  --check-interval <seconds>
  --max-error-rate 0.05 --max-error-rate-increase 0.02 --max-p95-ms 2000 --max-latency-ratio 1.5
  --min-requests 20 --failure-threshold 2 --allow-low-traffic
  --status-file <path> --pushgateway-url <url> --summary-file <path>
`;

async function main(argv) {
  const { command, flags, positional } = parseArgs(argv);
  const log = (msg) => process.stderr.write(`${new Date().toISOString()} [canary] ${msg}\n`);

  if (command === "status") {
    if (!flags["status-file"]) throw new Error("--status-file is required");
    const status = JSON.parse(await fs.readFile(flags["status-file"], "utf8"));
    process.stdout.write(flags.markdown ? statusToMarkdown(status) : `${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  if (command === "set-weight") {
    const percent = Number(positional[0]);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      process.stderr.write(USAGE);
      return 2;
    }
    await buildRouter(flags).setCanaryWeight(percent);
    log(`canary weight set to ${percent}%`);
    return 0;
  }

  if (command !== "run") {
    process.stderr.write(USAGE);
    return 2;
  }

  const num = (name) => (flags[name] === undefined ? undefined : Number(flags[name]));
  const thresholds = Object.fromEntries(
    Object.entries({
      maxErrorRate: num("max-error-rate"),
      maxErrorRateIncrease: num("max-error-rate-increase"),
      maxP95LatencyMs: num("max-p95-ms"),
      maxLatencyRatio: num("max-latency-ratio"),
      minRequests: num("min-requests"),
      failureThreshold: num("failure-threshold"),
    }).filter(([, v]) => v !== undefined),
  );

  const writeStatus = async (status) => {
    if (flags["status-file"]) await fs.writeFile(flags["status-file"], JSON.stringify(status, null, 2));
    if (flags["pushgateway-url"]) await pushStatus(flags["pushgateway-url"], status).catch((e) => log(`pushgateway: ${e.message}`));
  };

  const controller = new CanaryController({
    router: buildRouter(flags),
    metrics: buildMetrics(flags),
    stages: flags.stages ? parseStages(flags.stages) : DEFAULT_STAGES,
    thresholds,
    checkIntervalMs: (num("check-interval") ?? 60) * 1000,
    allowLowTraffic: Boolean(flags["allow-low-traffic"]),
    onStatus: writeStatus,
    log,
  });

  const status = await controller.run();
  const summary = flags["summary-file"] ?? process.env.GITHUB_STEP_SUMMARY;
  if (summary) await fs.appendFile(summary, statusToMarkdown(status));
  log(`final state: ${status.state}${status.reason ? ` — ${status.reason}` : ""}`);
  return status.state === "promoted" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    },
  );
}
