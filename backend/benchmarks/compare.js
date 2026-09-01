#!/usr/bin/env node
/**
 * Baseline comparison and regression gate (#867).
 *
 *   node benchmarks/compare.js --baseline benchmarks/baselines/ci-ubuntu-latest.json \
 *                              --current  bench-results.json \
 *                              --markdown comparison.md
 *
 * Exits non-zero when a regression clears every gate in `stats.compareMetric`,
 * so CI blocks on it. Exits zero — with a warning — when the baseline is
 * missing or was captured on a materially different machine, because failing a
 * pull request over an absent or incomparable baseline would be noise, not
 * signal.
 *
 * Configuration (all overridable, per #867's "thresholds are configurable"):
 *
 *   --threshold <pct>   Relative regression threshold. Default 10.
 *   --floor <ms>        Absolute floor below which a change is ignored.
 *   --metrics <list>    Comma-separated metrics to gate on. Default p50,p95.
 *   --max-rsd <ratio>   Baseline noise above which a scenario is not gated.
 *
 * Defaults live in `benchmarks/thresholds.json` so they can be tuned without
 * editing the workflow.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareMetric, isTooNoisy, noiseAllowance } from "./stats.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = JSON.parse(readFileSync(join(HERE, "thresholds.json"), "utf8"));

function parseArgs(argv) {
  const args = {
    baseline: null,
    current: null,
    markdown: null,
    threshold: null,
    floor: null,
    metrics: null,
    maxRsd: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--baseline":
        args.baseline = argv[++i];
        break;
      case "--current":
        args.current = argv[++i];
        break;
      case "--markdown":
        args.markdown = argv[++i];
        break;
      case "--threshold":
        args.threshold = Number(argv[++i]);
        break;
      case "--floor":
        args.floor = Number(argv[++i]);
        break;
      case "--metrics":
        args.metrics = argv[++i].split(",").map((m) => m.trim());
        break;
      case "--max-rsd":
        args.maxRsd = Number(argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  if (!args.current) throw new Error("--current is required");
  return args;
}

/**
 * Decide whether two environments are comparable.
 *
 * Timings are only meaningful against a baseline from the same kind of
 * machine. A mismatch is reported and gating is skipped rather than producing
 * a confidently wrong verdict.
 */
function environmentMismatch(baselineEnv, currentEnv) {
  const reasons = [];
  if (baselineEnv.platform !== currentEnv.platform) {
    reasons.push(`platform ${baselineEnv.platform} → ${currentEnv.platform}`);
  }
  if (baselineEnv.arch !== currentEnv.arch) {
    reasons.push(`arch ${baselineEnv.arch} → ${currentEnv.arch}`);
  }
  // Node major version only: a patch bump does not invalidate a baseline, but
  // a major one routinely shifts V8 performance by more than the threshold.
  const major = (v) => String(v).split(".")[0];
  if (major(baselineEnv.node) !== major(currentEnv.node)) {
    reasons.push(`Node ${baselineEnv.node} → ${currentEnv.node}`);
  }
  if (Boolean(baselineEnv.ci) !== Boolean(currentEnv.ci)) {
    reasons.push(
      `baseline captured ${baselineEnv.ci ? "in CI" : "locally"}, ` +
        `current run ${currentEnv.ci ? "in CI" : "local"}`
    );
  }
  return reasons;
}

/** Compare one scenario across every gated metric. */
function compareScenario(baseline, current, config) {
  const metrics = {};
  let worst = { status: "unchanged", deltaPct: 0 };

  const noisy = isTooNoisy(baseline.rsd, config.maxRsd);

  // Movement this scenario's own baseline spread can account for. Computed
  // once per scenario and applied to every gated metric.
  const allowance = noiseAllowance(baseline, config.noiseMultiplier);

  for (const metric of config.metrics) {
    const result = compareMetric(baseline[metric], current[metric], {
      thresholdPct: config.threshold,
      absoluteFloorMs: config.floor,
      noiseAllowanceMs: allowance,
    });

    // A scenario whose baseline was already unstable cannot support a verdict.
    // The measurement is still reported; it just does not gate the build.
    const effective = noisy && result.status === "regression"
      ? {
          ...result,
          status: "unstable",
          reason:
            `${result.reason}, but the baseline's run-to-run spread was ` +
            `${(baseline.rsd * 100).toFixed(1)}% (limit ${(config.maxRsd * 100).toFixed(0)}%) — not gated`,
        }
      : result;

    metrics[metric] = {
      baseline: baseline[metric],
      current: current[metric],
      ...effective,
    };

    if (effective.status === "regression" && effective.deltaPct > worst.deltaPct) {
      worst = effective;
    } else if (worst.status !== "regression" && effective.status === "unstable") {
      worst = effective;
    }
  }

  return { name: current.name, group: current.group, status: worst.status, metrics, noisy };
}

function compareReports(baselineReport, currentReport, config) {
  const baselineByName = new Map(baselineReport.scenarios.map((s) => [s.name, s]));

  const compared = [];
  const missingBaseline = [];

  for (const current of currentReport.scenarios) {
    const baseline = baselineByName.get(current.name);
    if (!baseline) {
      missingBaseline.push(current.name);
      continue;
    }
    compared.push(compareScenario(baseline, current, config));
    baselineByName.delete(current.name);
  }

  return {
    compared,
    missingBaseline,
    // A scenario in the baseline but not the current run: usually a rename or
    // deletion. Surfaced so a silently dropped benchmark is noticed.
    removed: [...baselineByName.keys()],
  };
}

function formatMarkdown(comparison, config, meta) {
  const lines = [];
  const regressions = comparison.compared.filter((s) => s.status === "regression");
  const improvements = comparison.compared.filter((s) => s.status === "improvement");
  const unstable = comparison.compared.filter((s) => s.status === "unstable");

  lines.push("## Performance comparison");
  lines.push("");

  if (regressions.length > 0) {
    lines.push(`**${regressions.length} regression(s) exceeded the configured threshold.**`);
  } else {
    lines.push("No performance regressions detected.");
  }
  lines.push("");

  lines.push(
    `Threshold: **${config.threshold}%** · absolute floor: **${config.floor} ms** · ` +
      `gated metrics: **${config.metrics.join(", ")}**`
  );
  if (meta.baselineLabel) {
    lines.push(`Baseline: \`${meta.baselineLabel}\``);
  }
  lines.push("");

  const rows = [];
  for (const scenario of comparison.compared) {
    for (const metric of config.metrics) {
      const m = scenario.metrics[metric];
      const icon =
        m.status === "regression"
          ? "🔴"
          : m.status === "improvement"
            ? "🟢"
            : m.status === "unstable"
              ? "🟡"
              : "⚪";
      const sign = m.deltaPct >= 0 ? "+" : "";
      rows.push(
        `| ${icon} | \`${scenario.name}\` | ${metric} | ${m.baseline.toFixed(4)} | ` +
          `${m.current.toFixed(4)} | ${sign}${m.deltaPct.toFixed(1)}% |`
      );
    }
  }

  if (rows.length > 0) {
    lines.push("| | Scenario | Metric | Baseline (ms) | Current (ms) | Change |");
    lines.push("|---|---|---|---|---|---|");
    lines.push(...rows);
    lines.push("");
  }

  if (regressions.length > 0) {
    lines.push("### Regressions");
    lines.push("");
    for (const scenario of regressions) {
      for (const metric of config.metrics) {
        const m = scenario.metrics[metric];
        if (m.status !== "regression") continue;
        lines.push(`- \`${scenario.name}\` · **${metric}** — ${m.reason}`);
      }
    }
    lines.push("");
  }

  if (unstable.length > 0) {
    lines.push("### Not gated (noisy baseline)");
    lines.push("");
    for (const scenario of unstable) {
      lines.push(`- \`${scenario.name}\` — baseline spread exceeded the noise limit`);
    }
    lines.push("");
  }

  if (improvements.length > 0) {
    lines.push(`${improvements.length} scenario(s) improved.`);
    lines.push("");
  }

  if (comparison.missingBaseline.length > 0) {
    lines.push("### New scenarios (no baseline yet)");
    lines.push("");
    for (const name of comparison.missingBaseline) lines.push(`- \`${name}\``);
    lines.push("");
  }

  if (comparison.removed.length > 0) {
    lines.push("### In baseline but not in this run");
    lines.push("");
    for (const name of comparison.removed) lines.push(`- \`${name}\``);
    lines.push("");
  }

  if (meta.environmentWarnings.length > 0) {
    lines.push("> **Baseline environment differs from this run** — results are");
    lines.push("> reported but not gated:");
    for (const reason of meta.environmentWarnings) lines.push(`> - ${reason}`);
    lines.push("");
  }

  lines.push(
    "<sub>Benchmark failures are reported by the Performance CI job and are " +
      "distinct from functional test failures. See `docs/PERFORMANCE.md` for how " +
      "to reproduce locally and how to update an approved baseline.</sub>"
  );

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const config = {
    threshold: args.threshold ?? DEFAULTS.thresholdPercent,
    floor: args.floor ?? DEFAULTS.absoluteFloorMs,
    metrics: args.metrics ?? DEFAULTS.gatedMetrics,
    maxRsd: args.maxRsd ?? DEFAULTS.maxBaselineRsd,
    noiseMultiplier: DEFAULTS.noiseMultiplier,
  };

  const currentReport = JSON.parse(readFileSync(args.current, "utf8"));

  if (!args.baseline || !existsSync(args.baseline)) {
    const message =
      `No baseline at ${args.baseline ?? "(not specified)"} — reporting results ` +
      `without gating. Commit this run as a baseline to enable regression detection ` +
      `(see docs/PERFORMANCE.md).`;
    process.stderr.write(`${message}\n`);
    if (args.markdown) {
      writeFileSync(
        args.markdown,
        `## Performance comparison\n\n_${message}_\n`,
        "utf8"
      );
    }
    return;
  }

  const baselineReport = JSON.parse(readFileSync(args.baseline, "utf8"));
  const environmentWarnings = environmentMismatch(
    baselineReport.environment,
    currentReport.environment
  );

  const comparison = compareReports(baselineReport, currentReport, config);
  const markdown = formatMarkdown(comparison, config, {
    baselineLabel: baselineReport.label ?? args.baseline,
    environmentWarnings,
  });

  process.stdout.write(`${markdown}\n`);
  if (args.markdown) writeFileSync(args.markdown, `${markdown}\n`, "utf8");

  const regressions = comparison.compared.filter((s) => s.status === "regression");

  if (environmentWarnings.length > 0) {
    process.stderr.write(
      `\nBaseline environment differs (${environmentWarnings.join("; ")}); ` +
        `not failing the build on these numbers.\n`
    );
    return;
  }

  if (regressions.length > 0) {
    process.stderr.write(
      `\nPERFORMANCE REGRESSION: ${regressions.length} scenario(s) exceeded ` +
        `the ${config.threshold}% threshold.\n`
    );
    process.exitCode = 1;
  }
}

main();
