# Load Tests — Stellar Royalty Splitter

This directory contains [k6](https://k6.io) load-test scripts for the Node.js backend.

## Prerequisites

Install k6 (macOS / Linux):

```bash
# macOS (Homebrew)
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] \
  https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

See [k6 installation docs](https://k6.io/docs/get-started/installation/) for other platforms.

## Running the distribute load test

1. Start the backend server in a separate terminal:

   ```bash
   cd backend
   npm start
   # or: node src/index.js
   ```

2. Run the load test against `http://localhost:3000` (default):

   ```bash
   k6 run tests/load/distribute-load.js
   ```

3. Override the target URL:

   ```bash
   BASE_URL=http://localhost:4000 k6 run tests/load/distribute-load.js
   ```

4. Run against a staging environment:

   ```bash
   BASE_URL=https://api.staging.example.com \
     k6 run tests/load/distribute-load.js
   ```

## Test parameters

| Parameter  | Value   | Description                         |
|------------|---------|-------------------------------------|
| VUs        | 100     | Concurrent virtual users            |
| Duration   | 30 s    | Total test duration                 |
| p95 target | < 200ms | 95th-percentile response time limit |
| p99 target | < 500ms | 99th-percentile response time limit |
| Error rate | < 1%    | Maximum acceptable 5xx rate         |

## Interpreting results

k6 prints a summary table at the end of the run.  The test **passes** only when
all configured thresholds are met (marked with `✓`).  Any `✗` indicates a
threshold violation.

Key metrics to watch:

- `http_req_duration` — end-to-end request latency (p50, p90, p95, p99, max)
- `http_req_failed` — fraction of requests that failed at the HTTP layer
- `distribute_errors` — custom rate for 5xx responses from the distribute endpoint
- `distribute_response_time` — custom trend mirror of `http_req_duration` for
  the distribute endpoint specifically

## Ramp scenario

An alternative ramping configuration is included in `distribute-load.js` as a
commented-out `options` block.  Uncomment it (and comment out the constant-VU
block) to run a ramp-up / hold / ramp-down scenario instead.
