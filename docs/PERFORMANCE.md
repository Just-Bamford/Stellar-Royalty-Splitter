# Performance Regression Detection

Automated performance regression detection for the backend API (#867).

Functional CI proves the code is *correct*. This suite proves it has not got
*slower*: a change to validation, serialization, or the request path can add
latency while every functional test still passes.

> **Scope.** This covers the JavaScript backend. Soroban contract performance is
> measured separately by the Criterion benches in `benches/` — see
> [BENCHMARKS.md](BENCHMARKS.md).

---

## Running locally

All commands run from `backend/`.

```bash
npm run bench                          # full suite, ~2 min, prints a table
npm run bench -- --filter validation   # one group
npm run bench -- --quick               # 1/10 iterations, for fast iteration
npm run bench:ci                       # 3 passes, best of each — what CI runs
```

First-time setup — `shared/` is a separate package with its own dependency on
the Stellar SDK:

```bash
cd backend && npm ci
cd ../shared && npm ci
```

### Comparing against a baseline

```bash
cd backend
npm run bench:ci -- --json /tmp/current.json
npm run bench:compare -- \
  --baseline benchmarks/baselines/ci-ubuntu-latest-node20.json \
  --current /tmp/current.json
```

Exit status is `0` when nothing regressed and `1` when something did, so it
works as a pre-push check.

> Comparing a local run against a **CI** baseline will report an environment
> mismatch and skip gating — the numbers are not comparable across machines.
> To check your own change locally, capture a baseline on your own machine
> from the parent commit and compare against that.

---

## Layout

```
backend/benchmarks/
├── index.js              CLI entry point
├── runner.js             Timing loop, warmup, best-of-N, environment capture
├── stats.js              Percentiles and the regression decision
├── compare.js            Baseline comparison and the CI gate
├── thresholds.json       Configurable thresholds
├── baselines/            Committed baselines, one per runner configuration
└── scenarios/
    ├── validation.bench.js       Zod schemas on the write path
    ├── serialization.bench.js    ScVal construction and XDR encode/decode
    └── http.bench.js             Real requests through the middleware chain
```

---

## Scenarios

19 scenarios in three groups. Each was chosen because it runs on a hot path,
not to inflate coverage.

### `validation` — 7 scenarios

Every write request passes through `validate()` before reaching any business
logic, so a regression here is paid by every caller on every request.
`initializeSchema` is measured at both 1 and 10 collaborators because its cost
scales with the collaborator count (each address goes through a full StrKey
checksum validation). The rejected-body case is included separately because
zod's error-collection path is materially more expensive than the accept path,
and it is what a misbehaving client hits.

### `serialization` — 7 scenarios

Every contract invocation converts arguments to ScVal and encodes them to XDR.
For a 50-operation batch that happens 150+ times per request, so a small
per-conversion regression is multiplied by the batch size. The
`batch-args/50-operations` scenario measures the whole shape of one
`/batch-distribute` request's argument construction.

### `http` — 5 scenarios

Real requests over a loopback socket to a real Express server, through body
parsing, size limiting, schema validation, and the project's standard error
handlers. Terminal handlers are trivial on purpose: this group measures the
framework and validation overhead every request pays.

**Not benchmarked:** Soroban RPC calls, Horizon queries, and database access.
These are network- and IO-bound, so their timings would measure the network
rather than the code and could not support a 10% threshold. RPC behaviour under
failure is covered by the chaos tests; end-to-end latency against a live
deployment is covered by the k6 scenarios in `backend/load-testing/`.

---

## Metrics

| Metric | Reported | Gated | Why |
|---|---|---|---|
| p50 | ✅ | ✅ | The typical case. Most stable statistic available. |
| p95 | ✅ | ✅ | Catches a fattened tail that p50 hides. |
| p99 | ✅ | ❌ | Measured, but too sensitive to a single GC pause on a shared runner to gate on. |
| ops/sec | ✅ | ❌ | Throughput, derived from p50. Reported for context. |
| mean, min, max, stdDev | ✅ | ❌ | Context and noise assessment. |
| heap delta | ✅ | ❌ | Indicative only — see below. |

The mean is deliberately *not* gated. It is dominated by the occasional
multi-millisecond GC pause and hides the typical case entirely.

**Memory** is recorded as a heap delta across the measured loop. It is not a
leak detector: without `--expose-gc` it includes garbage not yet collected. The
`heapMeasurementReliable` field records whether GC was available. `#867` asks
for memory "where measurable", and this is the honest extent of it in-process.

---

## How a regression is decided

The hard part is not measuring — it is deciding whether a difference is real. A
shared CI runner varies run to run for reasons unrelated to the code, and a
naive "10% slower → fail" rule produces mostly false positives and gets muted
within a week.

Four mechanisms, in order of how much they contribute:

**1. Best-of-N passes.** CI runs the suite three times and keeps each
scenario's fastest pass. Measurement noise is one-sided — an unlucky pass is
slowed by GC or a competing process, but nothing makes code faster than it
really is — so the minimum converges on the true cost while a single pass
converges on "the true cost plus whatever else the machine was doing". This is
by far the most effective of the four.

**2. Batching for fast operations.** An operation taking ~1 µs cannot be timed
individually: two `hrtime` calls cost as much as the work. Such scenarios
declare a `batch`, so each recorded sample covers many operations and the
per-operation cost is recovered by division.

**3. An absolute floor.** A change must move the metric by at least
`absoluteFloorMs`, or by the scenario's own noise allowance, whichever is
larger. Without this, a 0.02 ms → 0.03 ms move reads as a 50% regression.

**4. A noise gate.** If the baseline's own spread exceeded `maxBaselineRsd`, the
scenario is reported but does not gate. A benchmark that unstable cannot
support a 10% verdict.

### Measured behaviour

Calibrated by running the suite against unchanged code and against synthetic
uniform slowdowns:

| Comparison | Regressions flagged | Job result |
|---|---|---|
| Unchanged code | 0 | pass |
| +15% slowdown | 1 | fail |
| +40% slowdown | 4 | fail |

A uniform slowdown does not flag every scenario, and that is the intended
behaviour: scenarios whose absolute times are microseconds are correctly
suppressed by the absolute floor. The gate is tuned to catch regressions that
matter in wall-clock terms, not every relative change.

---

## Configuration

`backend/benchmarks/thresholds.json`:

| Setting | Default | Meaning |
|---|---|---|
| `thresholdPercent` | `10` | Relative slowdown counting as a regression. |
| `absoluteFloorMs` | `0.05` | Minimum absolute movement to be considered. |
| `gatedMetrics` | `["p50","p95"]` | Which metrics block a merge. |
| `maxBaselineRsd` | `1.5` | Baseline spread above which a scenario is not gated. |
| `noiseMultiplier` | `2` | Scales the per-scenario noise allowance. |

Every value can be overridden per invocation (`--threshold`, `--floor`,
`--metrics`, `--max-rsd`), which is what the workflow's manual-dispatch inputs
use. Changing a default is a one-line reviewable diff.

A scenario may also declare `minAllowanceMs` — between-run noise beyond what
its within-run spread reveals. The HTTP scenarios use it, because loopback
timings vary between runs by more than any statistic computed inside a single
run can detect.

---

## Baselines

Baselines live in `backend/benchmarks/baselines/`, one file per runner
configuration, named for the environment that produced it:

```
ci-ubuntu-latest-node20.json
```

Each records the environment that produced it — platform, arch, Node version,
CPU model, whether it ran in CI. `compare.js` checks these before gating and
downgrades to report-only if they differ materially, because a baseline from a
different machine cannot support a verdict.

### Environment assumptions

The committed baseline assumes:

- **Runner:** GitHub-hosted `ubuntu-latest`, 2 vCPU, ~7 GB RAM.
- **Node:** 20.x. Pinned in the workflow — a Node major bump shifts V8
  performance by more than the threshold and invalidates every baseline.
- **Concurrency:** the job takes the runner to itself; the workflow's
  `concurrency` group prevents two performance runs competing.
- **No external services.** Every scenario is in-process. No database, no RPC,
  no network beyond loopback.

A baseline is only valid for the configuration it was captured on. Comparing
across machines is reported, never gated.

### Updating an approved baseline

Baselines are **not** updated automatically. A regression that slipped through
must not silently become the new normal, so promoting a baseline is a
deliberate, reviewable act.

1. **Confirm the change is intentional.** If the numbers moved, either it was a
   deliberate trade-off, or it is a regression to fix. Do not update the
   baseline to make a red job green.

2. **Get the candidate.** Every `push` to `main` uploads a
   `benchmark-results-<run_id>` artifact from the correct hardware. Download
   `bench-results.json` from the run whose numbers you want to adopt.

   Never commit a baseline captured on a developer machine. It will not match
   the runner, and every subsequent comparison will be skipped as an
   environment mismatch.

3. **Commit it** under the name matching its environment:

   ```bash
   cp ~/Downloads/bench-results.json \
     backend/benchmarks/baselines/ci-ubuntu-latest-node20.json
   ```

4. **Open a pull request** explaining *why* the baseline moved — which change
   caused it and why it is acceptable. The diff shows the numbers; the
   description must supply the reason.

### Establishing the first baseline

No baseline is committed initially, because one captured anywhere other than
the CI runner would be actively misleading. Until one exists, the job runs the
suite, reports the numbers, and passes without gating — the missing baseline is
called out in the job summary.

To establish it: merge this change, let Performance CI run on `main`, then
follow **Updating an approved baseline** using that run's artifact.

---

## Adding a scenario

1. Add it to the relevant file in `benchmarks/scenarios/`, or create a new
   group and register it in `index.js`.
2. Use fixed, deterministic inputs. A scenario whose input varies run to run
   cannot support a threshold.
3. Set `batch` if a single operation takes less than ~10 µs.
4. Say in the description *why this path matters* — a benchmark nobody can
   justify is a benchmark nobody will maintain.
5. Run `npm run bench:ci` twice and check the scenario's `rsd`. If it is wildly
   unstable, raise `iterations` or `batch` before committing; do not rely on the
   noise gate to hide it.
6. A new scenario is reported as "no baseline yet" until the baseline is next
   updated. It does not gate before then.

---

## Interpreting a failure

A red Performance CI job means one or more scenarios regressed past the
threshold. It is reported separately from functional CI, so the two are never
confused.

1. **Read the pull request comment.** It names the scenario, the metric, the
   baseline and current values, and the percentage change.
2. **Reproduce locally.** `npm run bench:ci -- --filter <group>` against your
   branch and against its merge base.
3. **Then decide:**
   - a real regression → fix it;
   - an intentional trade-off → say so in the pull request and update the
     baseline after merge;
   - runner noise → re-run the job. Persistent flakiness on one scenario means
     the scenario needs more iterations, not a looser threshold.
