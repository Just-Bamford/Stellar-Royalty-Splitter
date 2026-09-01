/**
 * Statistics for the benchmark harness (#867).
 *
 * The hard problem in CI performance testing is not measuring — it is deciding
 * whether a difference is real. A shared GitHub runner varies by 10–20% between
 * runs for reasons that have nothing to do with the code, so a naive
 * "p95 got 10% slower → fail" rule produces mostly false positives and gets
 * muted within a week.
 *
 * The approach here:
 *
 *  1. Discard warmup iterations, so JIT compilation is not measured.
 *  2. Report percentiles rather than the mean — a mean is dominated by the
 *     occasional 50 ms GC pause and hides the typical case entirely.
 *  3. Require a regression to clear *both* a relative threshold and an
 *     absolute floor. Sub-millisecond operations routinely swing 30% in
 *     relative terms while being irrelevant in absolute terms.
 *  4. Compare against the baseline's own recorded spread. A metric that was
 *     already noisy when the baseline was captured needs a larger change
 *     before we believe it.
 */

/** Sort a copy ascending; every statistic below assumes sorted input. */
export function sorted(samples) {
  return [...samples].sort((a, b) => a - b);
}

/**
 * Linear-interpolated percentile, matching the definition k6 and most
 * observability tools use, so the numbers here are comparable to the ones the
 * load-testing scenarios report.
 *
 * @param {number[]} ascending Pre-sorted samples.
 * @param {number} p Percentile in [0, 100].
 */
export function percentile(ascending, p) {
  if (ascending.length === 0) return NaN;
  if (ascending.length === 1) return ascending[0];

  const rank = (p / 100) * (ascending.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return ascending[low];
  return ascending[low] + (rank - low) * (ascending[high] - ascending[low]);
}

export function mean(samples) {
  if (samples.length === 0) return NaN;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

export function stdDev(samples) {
  if (samples.length < 2) return 0;
  const avg = mean(samples);
  const variance =
    samples.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (samples.length - 1);
  return Math.sqrt(variance);
}

/**
 * Summarise a sample set into the metrics #867 asks for.
 *
 * `rsd` (relative standard deviation) is the noise indicator: it travels with
 * the baseline so a later comparison knows how stable this scenario was when
 * the baseline was taken.
 */
export function summarize(samples) {
  const ascending = sorted(samples);
  const avg = mean(ascending);

  return {
    samples: ascending.length,
    min: ascending[0],
    max: ascending[ascending.length - 1],
    mean: avg,
    p50: percentile(ascending, 50),
    p95: percentile(ascending, 95),
    p99: percentile(ascending, 99),
    stdDev: stdDev(ascending),
    // Guard against a zero mean so a degenerate run reports 0 noise rather
    // than NaN, which would poison every downstream comparison.
    rsd: avg > 0 ? stdDev(ascending) / avg : 0,
  };
}

/**
 * Decide whether a metric regressed.
 *
 * Three gates, all of which must be cleared before a change is called a
 * regression:
 *
 *  - **Relative**: the change exceeds `thresholdPct`.
 *  - **Absolute**: the change exceeds `absoluteFloorMs`. Without this, a
 *    0.02 ms → 0.03 ms move is a "50% regression" and fails the build for
 *    nothing.
 *  - **Noise**: the change exceeds `noiseMultiplier` times the baseline's own
 *    relative spread. A scenario that measured ±15% run-to-run when the
 *    baseline was captured cannot support a 10% verdict.
 *
 * @returns {{status: "regression"|"improvement"|"unchanged", deltaPct: number, reason: string}}
 */
export function compareMetric(baseline, current, options) {
  const { thresholdPct, absoluteFloorMs, noiseAllowanceMs = 0 } = options;

  if (!Number.isFinite(baseline) || baseline <= 0) {
    return { status: "unchanged", deltaPct: 0, reason: "no usable baseline value" };
  }

  const deltaMs = current - baseline;
  const deltaPct = (deltaMs / baseline) * 100;

  // A change must clear the larger of two floors:
  //
  //  - the flat floor, which protects microsecond-scale scenarios where a
  //    ±100% relative swing is a rounding artefact; and
  //  - a per-scenario allowance derived from the baseline's own measured
  //    spread, which protects millisecond-scale scenarios. A loopback HTTP
  //    request varies by a few tenths of a millisecond from OS scheduling
  //    alone, and a flat floor small enough to be useful for a 5 µs operation
  //    cannot possibly absorb that.
  const floor = Math.max(absoluteFloorMs, noiseAllowanceMs);

  if (deltaPct <= -thresholdPct && Math.abs(deltaMs) >= floor) {
    return {
      status: "improvement",
      deltaPct,
      reason: `${deltaPct.toFixed(1)}% faster`,
    };
  }

  if (deltaPct < thresholdPct) {
    return { status: "unchanged", deltaPct, reason: "within threshold" };
  }

  if (Math.abs(deltaMs) < floor) {
    return {
      status: "unchanged",
      deltaPct,
      reason:
        `+${deltaPct.toFixed(1)}% but only +${deltaMs.toFixed(4)}ms, ` +
        `under the ${floor.toFixed(4)}ms floor for this scenario`,
    };
  }

  return { status: "regression", deltaPct, reason: `+${deltaPct.toFixed(1)}% slower` };
}

/**
 * How much absolute movement this scenario's own measured noise can explain.
 *
 * Uses the p95−p50 gap rather than the standard deviation. Standard deviation
 * is dominated by the handful of multi-millisecond GC pauses in every sample
 * set, which inflates it far beyond the run-to-run variation of the
 * percentiles we actually gate on — an allowance built from it swallows even a
 * 40% uniform slowdown. The percentile gap is a robust spread estimate:
 * outliers move p95 a little and p50 not at all.
 *
 * Scaled by `multiplier / 2`, so the default multiplier of 2 yields the full
 * p95−p50 gap. Calibrated by running the suite twice against unchanged code
 * and against a synthetic uniform 40% slowdown: this value produced no false
 * positives on the former while still failing the latter.
 */
export function noiseAllowance(baselineStats, multiplier) {
  const gap = baselineStats?.p95 - baselineStats?.p50;
  const fromSpread = Number.isFinite(gap) && gap > 0 ? (gap * multiplier) / 2 : 0;

  // A scenario may declare its own floor. The within-run percentile gap
  // measures variation *inside* one process; scenarios that cross a socket or
  // the scheduler also vary *between* runs by more than that, and no purely
  // within-run statistic can see it. `minAllowanceMs` is where that
  // between-run variation is stated explicitly, per scenario, rather than
  // being smuggled into a global constant that then over-protects everything
  // else.
  const declared = baselineStats?.minAllowanceMs;
  return Math.max(fromSpread, Number.isFinite(declared) ? declared : 0);
}

/**
 * Whether a scenario's baseline was too noisy to judge against at all.
 * Reported rather than silently ignored — a permanently noisy scenario is a
 * benchmark that needs fixing, not a result to quietly drop.
 */
export function isTooNoisy(baselineRsd, maxRsd) {
  return Number.isFinite(baselineRsd) && baselineRsd > maxRsd;
}
