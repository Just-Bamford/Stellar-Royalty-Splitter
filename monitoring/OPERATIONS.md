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
