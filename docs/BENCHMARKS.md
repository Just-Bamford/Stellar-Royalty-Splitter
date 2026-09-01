# Performance Benchmarks

Benchmarks measure execution time for the `distribute` entrypoint across the
supported collaborator counts (1, 5, and 10). They are kept separate from unit
tests so they do not inflate normal CI runtimes.

> **Scope.** This document covers the **Soroban contract** benchmarks (Criterion,
> `benches/`). Backend API performance — validation, serialization, and the HTTP
> request path — is measured separately and gated in CI; see
> [PERFORMANCE.md](PERFORMANCE.md).

## Running benchmarks

```bash
cargo bench --features testutils
```

Criterion writes an HTML report to `target/criterion/report/index.html`.

To run only the distribution benchmarks:

```bash
cargo bench --features testutils -- distribute
```

To run only the full-lifecycle benchmarks:

```bash
cargo bench --features testutils -- full_lifecycle
```

## Benchmark groups

| Group | What is timed |
|---|---|
| `distribute/collaborators/N` | `distribute()` call only — setup excluded |
| `full_lifecycle/collaborators/N` | environment setup + initialise + distribute |

## Establishing a baseline

Run the benchmarks on the target machine and save the Criterion HTML report.
Criterion automatically stores the baseline in `target/criterion/`. On subsequent
runs it prints a regression or improvement summary.

To explicitly save a named baseline:

```bash
cargo bench --features testutils -- --save-baseline main
```

To compare against a saved baseline:

```bash
cargo bench --features testutils -- --baseline main
```

## Detecting regressions

A regression is flagged when a subsequent run shows a statistically significant
slowdown (outside Criterion's noise threshold). The default confidence interval
is 95%. Any slowdown greater than 5% on `distribute` warrants investigation
before merging.

## Contributing

Do not optimise contract code based on assumptions. Let benchmark results guide
any performance changes. When submitting a PR that touches distribution logic,
run `cargo bench` locally and include the Criterion summary in the PR description.
