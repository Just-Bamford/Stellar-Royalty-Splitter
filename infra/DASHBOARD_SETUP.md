# Grafana Metrics Dashboard — Setup Guide (#478)

This guide explains how to run the Prometheus + Grafana observability stack for
Stellar Royalty Splitter and use the pre-built operations dashboard.

---

## Quick Start

### 1. Start the backend

```bash
cd backend
cp .env.example .env    # fill in SERVER_SECRET_KEY etc.
npm install
npm run dev             # listens on http://localhost:3001
```

Verify the metrics endpoint is live:
```bash
curl http://localhost:3001/metrics
```
You should see Prometheus text-format output starting with
`stellar_distribute_calls_total`.

### 2. Start the observability stack

```bash
docker compose -f infra/docker-compose.observability.yml up -d
```

This starts:
- **Prometheus** at http://localhost:9090 — scrapes `/metrics` every 15 s
- **Grafana** at http://localhost:3000 — pre-loaded with the dashboard and alerts

> **Note:** If the backend is running outside Docker, update `prometheus.yml`
> to target `host.docker.internal:3001` instead of `backend:3001`.

### 3. Open the dashboard

1. Navigate to http://localhost:3000
2. Log in with `admin` / `admin` (change on first login)
3. Go to **Dashboards → Stellar → Stellar Royalty Splitter — Operations**

The dashboard auto-refreshes every 30 seconds.

---

## Dashboard Panels

### Overview row (top)
| Panel | Metric | Description |
|---|---|---|
| Total Distribute Calls | `stellar_distribute_calls_total` | Cumulative distribute invocations |
| Failed Transactions | `stellar_transactions_failed_total` | Transaction build failures |
| Successful Transactions | `stellar_transactions_successful_total` | Transaction build successes |
| Avg Horizon Response | `stellar_horizon_response_time_average_ms` | Rolling average Horizon RTT |
| Transaction Success Rate | derived | successful / (successful + failed) |
| HTTP p99 Latency | `stellar_http_response_time_p99_ms` | 99th-percentile response time |

### Distribution Activity row
| Panel | Queries | Description |
|---|---|---|
| Distribute Calls — Rate | `rate(stellar_distribute_calls_total[1m])` | Calls/min, success/min, failures/min |
| HTTP Requests by Route | `rate(stellar_http_requests_total{path=...}[1m])` | Per-route traffic breakdown |

### Latency row
| Panel | Queries | Description |
|---|---|---|
| HTTP Response Percentiles | p50 / p95 / p99 gauges | End-to-end HTTP latency |
| Horizon & RPC Avg Latency | `stellar_horizon_response_time_average_ms`, `stellar_rpc_call_duration_ms_average` | External call performance |

### Error Rate row
| Panel | Queries | Description |
|---|---|---|
| Overall API Error Rate | `rate(4xx+5xx) / rate(total)` | 5-minute rolling error percentage |
| Errors by Status Code | per-status `stellar_http_requests_total` | 400 / 401 / 429 / 500 / 503 / 504 breakdown |

### Stellar RPC Health row
| Panel | Queries | Description |
|---|---|---|
| RPC Calls by Operation | `stellar_rpc_calls_total` | Total and failure calls per operation |
| RPC Success Rate | success / total per operation | Detect degraded RPC operations |

### Webhook Delivery row
| Panel | Queries | Description |
|---|---|---|
| Webhook Requests | `stellar_http_requests_total{path=~/webhooks.*}` | Success vs error request rates |
| Webhook Success Rate | derived from status=200 | Rolling 5-minute delivery rate |

### Cache Efficiency row
| Panel | Queries | Description |
|---|---|---|
| Cache Hits vs Misses | `stellar_cache_hits_total`, `stellar_cache_misses_total` | Per-cache hit/miss rates |
| Cache Hit Rate | hits / (hits + misses) | Efficiency per cache (`contract_state`, `collaborators`) |

### Traffic Volume row
| Panel | Queries | Description |
|---|---|---|
| Request / Response Bytes | `stellar_http_request_bytes_total`, `stellar_http_response_bytes_total` | Network throughput |
| Requests by Status Class | 2xx / 4xx / 5xx rate/min | High-level traffic health |

---

## Alert Rules

Six alerts are pre-configured via `provisioning/alerting/alerts.yml`:

| Alert | Condition | Severity | For |
|---|---|---|---|
| High API Error Rate | 5xx rate > 5% | critical | 5 min |
| Transaction Failure Spike | failures > 5/min | warning | 5 min |
| High HTTP p99 Latency | p99 > 3 000 ms | warning | 10 min |
| Horizon Response Time Degraded | avg > 2 000 ms | warning | 10 min |
| Stellar RPC Failures | failure rate > 10% | critical | 5 min |
| Low Cache Hit Rate | hit rate < 30% | info | 15 min |

To receive alert notifications, configure a **Contact Point** in Grafana:
**Alerting → Contact points → New contact point** (Slack, PagerDuty, email, etc.)

Then assign it to an **Alert policy** that matches `team=backend` or
`team=infrastructure`.

---

## Sample PromQL Queries

Useful queries to run directly in Grafana Explore or Prometheus:

```promql
# Distributions per hour (last 24h)
increase(stellar_distribute_calls_total[1h])

# 5xx error rate over last 5 minutes
rate(stellar_http_requests_total{status=~"5.."}[5m])
  / clamp_min(rate(stellar_http_requests_total[5m]), 0.001)

# p95 HTTP latency
stellar_http_response_time_p95_ms

# Horizon average response time
stellar_horizon_response_time_average_ms

# RPC failure rate by operation
rate(stellar_rpc_calls_total{result="failure"}[5m])
  / clamp_min(rate(stellar_rpc_calls_total{result!~"success|failure"}[5m]), 0.001)

# Cache hit rate — contract_state cache
stellar_cache_hits_total{cache="contract_state"}
  / clamp_min(
      stellar_cache_hits_total{cache="contract_state"}
      + stellar_cache_misses_total{cache="contract_state"},
      1
    )

# Webhook API error rate
rate(stellar_http_requests_total{path=~"/api/v1/webhooks.*",status=~"4..|5.."}[5m])
  / clamp_min(rate(stellar_http_requests_total{path=~"/api/v1/webhooks.*"}[5m]), 0.001)

# Transaction success rate
stellar_transactions_successful_total
  / clamp_min(
      stellar_transactions_successful_total + stellar_transactions_failed_total,
      1
    )

# Request throughput (bytes/sec)
rate(stellar_http_request_bytes_total[1m])
rate(stellar_http_response_bytes_total[1m])
```

---

## File Structure

```
infra/
├── prometheus.yml                              # Prometheus scrape config
├── docker-compose.observability.yml            # Prometheus + Grafana stack
├── DASHBOARD_SETUP.md                          # This file
└── grafana/
    ├── dashboards/
    │   └── royalty-splitter.json               # Pre-built Grafana dashboard
    └── provisioning/
        ├── datasources/
        │   └── prometheus.yml                  # Auto-registers Prometheus datasource
        ├── dashboards/
        │   └── dashboards.yml                  # Auto-loads dashboards from disk
        └── alerting/
            └── alerts.yml                      # 6 pre-configured alert rules
```

---

## Importing the Dashboard Manually

If you prefer to import rather than use auto-provisioning:

1. Open Grafana → **Dashboards → Import**
2. Upload `infra/grafana/dashboards/royalty-splitter.json`
3. Select the **Prometheus** datasource when prompted
4. Click **Import**

---

## Metrics Reference

All metrics are exposed at `GET /metrics` (Prometheus text format).

| Metric | Type | Description |
|---|---|---|
| `stellar_distribute_calls_total` | counter | Total distribute endpoint calls |
| `stellar_transactions_successful_total` | counter | Successful transaction builds |
| `stellar_transactions_failed_total` | counter | Failed transaction builds |
| `stellar_horizon_response_time_average_ms` | gauge | Rolling average Horizon RTT |
| `stellar_horizon_response_time_count` | counter | Horizon call count |
| `stellar_http_response_time_p50_ms` | gauge | 50th-percentile HTTP response time |
| `stellar_http_response_time_p95_ms` | gauge | 95th-percentile HTTP response time |
| `stellar_http_response_time_p99_ms` | gauge | 99th-percentile HTTP response time |
| `stellar_http_response_time_observations_total` | counter | Response time sample count |
| `stellar_http_request_bytes_total` | counter | Total request body bytes |
| `stellar_http_response_bytes_total` | counter | Total response body bytes |
| `stellar_http_requests_total{method,path,status}` | counter | Per-route HTTP request count |
| `stellar_rpc_calls_total{operation,result}` | counter | Stellar RPC calls by operation and result |
| `stellar_rpc_call_duration_ms_average{operation}` | gauge | Average RPC call duration |
| `stellar_cache_hits_total{cache}` | counter | Cache hits per cache name |
| `stellar_cache_misses_total{cache}` | counter | Cache misses per cache name |
