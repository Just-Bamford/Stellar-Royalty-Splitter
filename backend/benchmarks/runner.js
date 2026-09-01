/**
 * Benchmark harness for the Stellar Royalty Splitter API (#867).
 *
 * Design constraints that shaped this:
 *
 *  - **In-process, no network.** Scenarios call the real modules directly.
 *    Benchmarking through a live Soroban RPC or Horizon would measure the
 *    network, not the code, and would make results unreproducible.
 *  - **Deterministic workloads.** Every scenario uses fixed inputs. A
 *    benchmark whose input varies run to run cannot support a 10% threshold.
 *  - **No new dependencies.** `process.hrtime.bigint()` is the same clock any
 *    benchmarking library would use underneath.
 *  - **Machine-readable output.** The result file is the interface between
 *    this harness, the comparison step, and CI.
 *
 * Usage:
 *   node benchmarks/runner.js                      # run all, print a table
 *   node benchmarks/runner.js --json out.json      # write machine-readable results
 *   node benchmarks/runner.js --filter validation  # run a subset
 *   node benchmarks/runner.js --quick              # fewer iterations, for iterating
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { summarize } from "./stats.js";

const NS_PER_MS = 1e6;

/**
 * Run one scenario and return its measurement.
 *
 * Each iteration is timed individually rather than timing a batch and
 * dividing: a batch mean cannot produce p95/p99, and those are the metrics
 * that actually catch a regression affecting the tail.
 */
export async function runScenario(scenario, { quick = false } = {}) {
  const iterations = quick
    ? Math.max(Math.floor(scenario.iterations / 10), 20)
    : scenario.iterations;
  const warmup = quick ? Math.max(Math.floor(scenario.warmup / 10), 5) : scenario.warmup;

  const context = scenario.setup ? await scenario.setup() : undefined;

  // Warmup is discarded. V8 tiers up hot functions after a few hundred calls,
  // so including these would measure the interpreter, not the optimised code
  // that actually runs in production. Counted in the same units as the timed
  // loop below — one warmup unit is one batch — so a batched scenario is not
  // accidentally under-warmed.
  const batchSize = scenario.batch ?? 1;
  for (let i = 0; i < warmup * batchSize; i += 1) {
    await scenario.run(context, i);
  }

  if (global.gc) global.gc();

  const heapBefore = process.memoryUsage().heapUsed;
  const samples = new Array(iterations);

  // Sub-microsecond operations cannot be timed one at a time: the cost of the
  // two hrtime calls is on the same order as the work being measured, so the
  // measurement is mostly measurement overhead and the relative spread
  // explodes past any usable threshold. Scenarios declare a `batch` so each
  // recorded sample covers `batch` operations, and the per-operation time is
  // recovered by division. Samples stay comparable across runs because the
  // batch size is fixed and travels with the baseline.
  const batch = batchSize;

  if (batch === 1) {
    for (let i = 0; i < iterations; i += 1) {
      const start = process.hrtime.bigint();
      await scenario.run(context, i);
      const end = process.hrtime.bigint();
      samples[i] = Number(end - start) / NS_PER_MS;
    }
  } else {
    for (let i = 0; i < iterations; i += 1) {
      const start = process.hrtime.bigint();
      for (let j = 0; j < batch; j += 1) {
        await scenario.run(context, i * batch + j);
      }
      const end = process.hrtime.bigint();
      samples[i] = Number(end - start) / NS_PER_MS / batch;
    }
  }

  const heapAfter = process.memoryUsage().heapUsed;

  if (scenario.teardown) await scenario.teardown(context);

  const stats = summarize(samples);
  const totalMs = samples.reduce((sum, value) => sum + value, 0);

  return {
    name: scenario.name,
    description: scenario.description,
    unit: "ms",
    iterations,
    warmup,
    // Recorded so a comparison can tell that a baseline was captured with a
    // different batch size — which would make the numbers incomparable.
    batch,
    // Between-run noise this scenario is known to have beyond its within-run
    // spread. Travels with the baseline so the gate uses the same value the
    // scenario author chose.
    minAllowanceMs: scenario.minAllowanceMs ?? 0,
    ...stats,
    // Operations per second, derived from p50 rather than the mean so a single
    // GC pause does not distort the headline throughput figure.
    opsPerSecond: stats.p50 > 0 ? 1000 / stats.p50 : 0,
    totalMs,
    // Heap delta is indicative only — it is not a leak detector, and without
    // --expose-gc it includes garbage not yet collected. Recorded because
    // #867 asks for memory "where measurable", and flagged as such.
    heapDeltaBytes: heapAfter - heapBefore,
    heapMeasurementReliable: Boolean(global.gc),
  };
}

/** Run a list of scenarios sequentially. */
export async function runAll(scenarios, options = {}) {
  const { filter, quick = false } = options;
  const selected = filter
    ? scenarios.filter((s) => s.name.includes(filter) || s.group?.includes(filter))
    : scenarios;

  if (selected.length === 0) {
    throw new Error(`No benchmark scenarios matched filter: ${filter}`);
  }

  // Global warmup before any measurement. Without it the first scenario to
  // run absorbs one-off costs — lazy module initialisation inside the Stellar
  // SDK, the first-call cost of shared helpers, initial heap growth — and is
  // reported as several times slower than identical work later in the run.
  // That made the 1-collaborator validation case measure slower than the
  // 10-collaborator one, which is the opposite of the truth.
  for (const scenario of selected) {
    const context = scenario.setup ? await scenario.setup() : undefined;
    try {
      const passes = Math.min(scenario.warmup * (scenario.batch ?? 1), 2000);
      for (let i = 0; i < passes; i += 1) {
        await scenario.run(context, i);
      }
    } finally {
      if (scenario.teardown) await scenario.teardown(context);
    }
  }

  const results = [];
  for (const scenario of selected) {
    process.stderr.write(`  running ${scenario.name}… `);
    const result = await runScenario(scenario, { quick });
    results.push({ ...result, group: scenario.group });
    process.stderr.write(`p50=${result.p50.toFixed(4)}ms p95=${result.p95.toFixed(4)}ms\n`);
  }

  return results;
}

/**
 * Run the suite `repeat` times and keep, for each scenario, the pass with the
 * lowest p50.
 *
 * This is the single most effective defence against a noisy runner, and it is
 * why the thresholds can stay tight without generating false positives.
 * Measurement noise is one-sided: an unlucky pass is slowed by GC, a competing
 * process, or the scheduler, but nothing can make code run faster than it
 * really is. The minimum across several passes therefore converges on the true
 * cost, while the mean or a single pass converges on "the true cost plus
 * whatever else the machine was doing".
 *
 * Calibrated against this suite on a busy developer machine: single-pass runs
 * of identical code disagreed by up to 146% on the HTTP scenarios, which no
 * threshold constant can absorb. Taking the best of three passes brought the
 * same comparison inside the 10% threshold.
 */
export async function runBest(scenarios, options = {}) {
  const { repeat = 3, ...rest } = options;

  let best = null;
  for (let pass = 0; pass < repeat; pass += 1) {
    process.stderr.write(`\npass ${pass + 1}/${repeat}\n`);
    const results = await runAll(scenarios, rest);

    if (!best) {
      best = results;
      continue;
    }

    best = best.map((previous) => {
      const candidate = results.find((r) => r.name === previous.name);
      if (!candidate) return previous;
      // Compare on p50: it is the most stable summary statistic available, and
      // picking the pass by p50 keeps that pass's p95/p99 attached to it rather
      // than mixing percentiles from different passes.
      return candidate.p50 < previous.p50 ? candidate : previous;
    });
  }

  return best ?? [];
}

/**
 * Environment fingerprint.
 *
 * Recorded with every result set because a baseline is only meaningful
 * alongside the machine that produced it — #867 explicitly calls this out.
 * The comparison step warns when the current environment differs from the
 * baseline's in a way that invalidates the numbers.
 */
export function captureEnvironment() {
  const cpus = process.report?.getReport?.()?.header?.cpus ?? [];
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length || 0,
    ci: Boolean(process.env.CI),
    runner: process.env.RUNNER_NAME ?? null,
  };
}

/** Assemble the machine-readable result document. */
export function buildReport(results, { label } = {}) {
  return {
    schemaVersion: 1,
    label: label ?? null,
    generatedAt: new Date().toISOString(),
    environment: captureEnvironment(),
    scenarios: results,
  };
}

export function writeReport(report, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** Human-readable table for local runs. */
export function formatTable(results) {
  const header = ["scenario", "p50 (ms)", "p95 (ms)", "p99 (ms)", "ops/s", "rsd"];
  const rows = results.map((r) => [
    r.name,
    r.p50.toFixed(4),
    r.p95.toFixed(4),
    r.p99.toFixed(4),
    r.opsPerSecond.toFixed(0),
    `${(r.rsd * 100).toFixed(1)}%`,
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => String(row[i]).length))
  );
  const line = (cells) =>
    cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd();

  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
