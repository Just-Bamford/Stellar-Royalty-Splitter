# Benchmark baselines

Committed performance baselines, one file per runner configuration, named for
the environment that produced it:

```
ci-ubuntu-latest-node20.json
```

**No baseline is committed yet.** One captured on anything other than the CI
runner would be actively misleading — `compare.js` would detect the environment
mismatch and skip gating on every run, so the job would look green while
checking nothing.

Until a baseline exists here, Performance CI runs the suite, reports the
numbers in the job summary and the pull request comment, and passes without
gating.

## Establishing the first baseline

1. Merge the change that adds this suite.
2. Let Performance CI run on `main`.
3. Download the `benchmark-results-<run_id>` artifact from that run.
4. Commit its `bench-results.json` here under the name above.

Full instructions, including how to update an approved baseline later and what
environment each baseline assumes, are in
[`docs/PERFORMANCE.md`](../../../docs/PERFORMANCE.md).
