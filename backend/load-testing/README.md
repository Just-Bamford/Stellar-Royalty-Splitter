# Load Testing Framework — #611

This directory contains the load testing framework for Stellar Royalty Splitter,
using [k6](https://k6.io/) as the load testing tool.

## Prerequisites

- Install k6: https://grafana.com/docs/k6/latest/setup/install/
  ```bash
  # Linux
  sudo apt update && sudo apt install k6

  # macOS
  brew install k6

  # Docker
  docker pull grafana/k6
  ```

## Quick Start

The repository includes a portable runner. It validates the API before heavier tests and writes a JSON summary under `load-testing/reports/`:

```bash
cd backend
BASE_URL=http://localhost:3001 ./load-testing/run.sh smoke
./load-testing/run.sh normal
./load-testing/run.sh spike
./load-testing/run.sh sustained
```

The runner fails fast when k6 is unavailable, and all scenarios expose explicit failure-rate and latency thresholds so CI can fail on a measurable regression.


1. Start the API server (or point to a deployed instance):
   ```bash
   cd backend && npm run dev
   ```

2. Run the normal load test:
   ```bash
   k6 run load-testing/scenarios/normal-load.js
   ```

3. Run the spike test:
   ```bash
   k6 run load-testing/scenarios/spike-test.js
   ```

4. Run the sustained load test:
   ```bash
   k6 run load-testing/scenarios/sustained-load.js
   ```

5. Generate a performance report:
   ```bash
   k6 run load-testing/scenarios/normal-load.js --out json=load-testing/reports/report.json
   ```

## Test Scenarios

### Normal Load (`scenarios/normal-load.js`)
- Simulates typical daily traffic
- 50 virtual users (VUs)
- Gradual ramp-up over 30s
- Sustained load for 3 minutes
- Measures: API response times, error rates, throughput

### Spike Test (`scenarios/spike-test.js`)
- Simulates sudden traffic spikes
- Ramp up to 200 VUs in 10s
- Sustained for 1 minute
- Measures: system recovery, max throughput

### Sustained Load (`scenarios/sustained-load.js`)
- Long-running test for memory leak detection
- 30 VUs for 30 minutes
- Measures: memory usage, slow query detection

## Thresholds

Performance thresholds defined in each scenario:
- HTTP request failure rate: < 1%
- P95 response time: < 2000ms
- P99 response time: < 5000ms
- Database query time: < 100ms avg

## CI Integration

To run load tests in CI:
```bash
# Install k6 in CI pipeline
# Run tests with thresholds
k6 run load-testing/scenarios/normal-load.js --summary-export=load-testing/reports/ci-summary.json
```

## Reports

Performance reports are generated to `load-testing/reports/`:
- JSON reports for CI integration
- HTML summary (via k6 HTML output plugin)
- Trend data for baseline comparison