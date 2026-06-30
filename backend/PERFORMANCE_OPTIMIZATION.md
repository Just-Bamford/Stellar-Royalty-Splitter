# Query Performance Optimization Guide

This backend profiles SQLite statements automatically through the shared database
connection. Any query executed with `db.prepare(...).get()`, `.all()`, `.run()`,
or `.iterate()` is timed and added to the in-process query profiler metrics.

## Slow Query Threshold

Queries taking `100ms` or longer are treated as slow by default.

Override the threshold for local load testing:

```bash
SLOW_QUERY_THRESHOLD_MS=50 npm run dev
```

## Metrics Endpoint

Use the health metrics endpoint to inspect query behavior:

```bash
curl http://localhost:3001/api/v1/health/query-performance
```

The response includes:

- `totalQueries`: total profiled statement executions since process start.
- `slowQueries`: number of executions over the threshold.
- `averageDurationMs`: average query duration.
- `maxDurationMs`: slowest observed query duration.
- `operations`: per-operation metrics for `get`, `all`, `run`, and `iterate`.
- `slowQuerySamples`: recent slow queries with recommendations.

## Logs

Slow queries are logged as structured warning events:

```text
Slow database query detected
```

Each event includes the normalized SQL, operation, duration, threshold, timestamp,
and optimization recommendations.

## Optimization Workflow

1. Reproduce the slow flow in staging or locally with realistic data volume.
2. Check `/api/v1/health/query-performance` for the slowest samples.
3. Run `EXPLAIN QUERY PLAN` for the slow SQL shape.
4. Add or adjust a narrow composite index that matches the query's `WHERE`,
   `JOIN`, `GROUP BY`, or `ORDER BY` columns.
5. Rerun the flow and confirm lower `durationMs`, lower `slowQueries`, or both.
6. Keep indexes focused. Avoid adding broad indexes that duplicate an existing
   prefix or slow down write-heavy paths.

## Optimized Query Shapes

Issue #500 adds composite indexes for the highest-risk analytics and history
queries:

- confirmed transaction analytics by `contractId`, `status`, `timestamp`, and `type`
- distribution payout joins by `transactionId` and `collaboratorAddress`
- secondary sale lookups by `contractId`, `distributed`, and `timestamp`
- secondary royalty distribution history by `contractId` and `timestamp`

These indexes cover the slowest aggregate and history query shapes without
changing API behavior.
