# Operations observability

The backend exposes Prometheus-compatible metrics at `/metrics` and detailed dependency health at `/api/v1/health`. Prometheus should scrape both endpoints using `monitoring/prometheus.yml`; Grafana can import `monitoring/grafana/royalty-splitter-dashboard.json`.

## Signals and ownership

| Signal | Primary metric or endpoint | Operator meaning |
|---|---|---|
| Availability | `up`, `/health` | Process and network reachability |
| Request latency | `http_request_duration_seconds` | User-visible API latency |
| Application failures | `http_requests_total{status=~"5.."}` | Unhandled route or dependency failures |
| Soroban RPC | `stellar_rpc_operation_duration_seconds_*` | RPC latency and provider degradation |
| Database | `stellar_db_health_*`, `/api/v1/health` | Query health, consecutive failures, and pool saturation |
| Transaction outcomes | `stellar_transactions_successful_total`, `stellar_transactions_failed_total` | Distribution success and failure trends |
| Resources | `process_resident_memory_bytes`, Node heap metrics | Memory pressure and leak indicators |

## Alert response map

| Alert | First response | Escalation / recovery |
|---|---|---|
| `RoyaltySplitterApiDown` | Confirm deployment and container logs; check `/health` from the same network. | Roll back the latest release if the process does not recover within five minutes; preserve logs and traces. |
| `RoyaltySplitterHighRequestLatency` | Compare request latency with RPC and database panels; identify the slow route. | Scale the API or dependency, disable non-essential expensive work, and open a performance incident if p95 remains high. |
| `RoyaltySplitterHighErrorRate` | Inspect correlated application logs using `X-Correlation-ID`; check recent deploys and dependency status. | Pause write traffic or roll back when errors are release-related; notify the on-call owner. |
| `RoyaltySplitterRpcLatencyHigh` | Check the RPC provider status and timeout metrics. | Fail over to the configured provider or increase timeout capacity according to provider policy; do not blindly retry writes. |
| `RoyaltySplitterDatabaseDegraded` | Check database reachability, migration version, pool queue, and active connections. | Drain or restart API workers only after capturing evidence; apply the database recovery procedure. |
| `RoyaltySplitterProcessMemoryHigh` | Compare resident memory, heap usage, traffic, and cache growth. | Capture a heap profile, scale out, and restart through the deployment controller if memory does not fall. |

## Runbook principles

Every incident should record the alert name, first-seen time, affected environment, correlation IDs, deployment revision, and the operator action taken. Liveness checks are intentionally cheap; detailed health checks may contact Horizon, Soroban, and the database and should be scraped at a lower operational priority. Alert notifications must never contain private keys, API keys, wallet secrets, or full request bodies.

## Local verification

Start the API, then verify `curl http://localhost:3001/health` and `curl http://localhost:3001/metrics`. Import the dashboard into Grafana and point it at the Prometheus data source. For a local alert-rule check, run `promtool check rules monitoring/royalty-splitter-alerts.yml` when Prometheus tooling is installed.

## Distribution analytics dashboard (#935)

`monitoring/grafana-dashboards/royalty-analytics.json` (provisioned by `infra/terraform/grafana.tf`, or import it manually) refreshes every 60 seconds and covers:

| Panel | Metric |
|---|---|
| Request latency heatmap and p50/p95/p99 | `http_request_duration_seconds` (labelled by route pattern, e.g. `/api/v1/history/:contractId`) |
| Distributions over time | `stellar_distributions_total{outcome="built|confirmed|failed"}` |
| Distribution latency by phase | `stellar_distribution_latency_seconds{phase="simulation|build|submission"}`; submission = recorded → confirmed on-chain |
| Gas per distribution | `stellar_distribution_gas_stroops` (simulated Soroban resource fee) |
| Secondary royalty pool growth | `stellar_secondary_royalty_pool_pending` (read from the DB at scrape time), `stellar_secondary_royalty_{accrued,distributed}_total` |
| Secondary sale processing time | `stellar_secondary_sale_processing_seconds` |
| Collaborator earnings and payout frequency | `stellar_collaborator_{earnings,payouts}_total` (collaborator label capped by `METRICS_MAX_COLLABORATOR_SERIES`, default 500; the rest are grouped as `other`) |
| Contract state changes timeline | `stellar_contract_state_changes_total{action}`, one increment per audited action |
| Anomaly z-scores | recording rules in `anomaly-detection-rules.yml` |

Note: `stellar_collaborator_*` is recorded where payouts are written (`addDistributionPayout`); those panels stay empty until a route records per-collaborator payouts.

**Retention.** The dashboard's 30-day views need Prometheus to keep 30 days of samples. Start Prometheus with `--storage.tsdb.retention.time=30d` (the default is 15 days).

**Anomaly detection.** `anomaly-detection-rules.yml` compares distribution rate, request p95, gas per distribution and 5xx ratio with a baseline from the hour ending 10 minutes ago, and alerts on z > 3 (`RoyaltySplitter*Anomaly`). Firing anomaly alerts are drawn as annotations on the dashboard. `promtool test rules monitoring/tests/*.test.yml` exercises spike and no-spike cases.

## Canary deployments (#936)

The `royalty-splitter-api-canary` scrape job labels the canary process `deployment="canary"`. `canary-alerts.yml` and the "Canary Deployment" dashboard compare it with stable; see `docs/canary-deployment.md`.

| Alert | First response |
|---|---|
| `RoyaltySplitterCanaryErrorRateHigh` / `…AboveStable` / `…LatencyRegression` | Confirm the controller rolled back; if not, `node infra/canary-controller.js set-weight 0 --router alb …`. |
| `RoyaltySplitterCanaryStalled` | The controller stopped reporting mid-rollout; set weight 0 manually and rerun the deploy. |
| `RoyaltySplitterShadowTrafficMismatch` | Hold the rollout; diff canary vs stable responses for the affected routes. |

## Immutable audit trail (#938)

| Alert | First response |
|---|---|
| `RoyaltySplitterAuditTrailTampered` | Treat as a security incident. Preserve the host and `AUDIT_TRAIL_DB_PATH`, compare with the daily exports in the Object Lock archive bucket, and do not restart or "fix" the file. |
| `RoyaltySplitterAuditTrailWriteFailures` | Check disk space and permissions on `AUDIT_TRAIL_DB_PATH`. State changes made while this fires are missing from the compliance record. |
| `RoyaltySplitterAuditTrailVerificationStale` | Run `POST /admin/audit-trail/verify` and check the API logs for `audit_trail_*` events. |
