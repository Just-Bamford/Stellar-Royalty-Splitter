# Rate Limiting

The API uses layered rate limits so expensive routes can be tuned without
changing the public default for every endpoint.

| Environment variable | Default | Applies to | Notes |
| --- | ---: | --- | --- |
| `RATE_LIMIT_WINDOW_MS` | `60000` | General public/API-key limiter | Health and readiness probes are skipped. |
| `RATE_LIMIT_MAX` | `100` | Anonymous general traffic | Per IP. |
| `RATE_LIMIT_AUTH_MAX` | `1000` | API-key traffic | Per `x-api-key`. |
| `RATE_LIMIT_WRITE_WINDOW_MS` | `60000` | Transaction-building routes | Configure separately from reads. |
| `RATE_LIMIT_WRITE_MAX` | `10` | Initialize, distribute, secondary royalty, webhooks, onboarding | Per IP. |
| `RATE_LIMIT_READ_MAX` | `30` | Analytics and history | Keeps large DB scans bounded. |
| `RATE_LIMIT_SIMULATE_WINDOW_MS` | `RATE_LIMIT_WINDOW_MS` | `/api/v1/simulate` | Soroban RPC dry-runs are read-only but comparatively expensive. |
| `RATE_LIMIT_SIMULATE_MAX` | `20` | `/api/v1/simulate` | Per IP or per API key. |
| `RATE_LIMIT_ADMIN_WINDOW_MS` | `60000` | Admin routes | Use a low ceiling for sensitive operations. |
| `RATE_LIMIT_ADMIN_MAX` | `5` | Admin routes | Per IP. |

## Endpoint tuning guidance

- Keep `/api/v1/health`, `/api/health`, `/health`, and `/ready` outside custom
  route limiters so platform probes do not trip production traffic limits.
- Lower `RATE_LIMIT_WRITE_MAX` when Freighter signing or RPC submission starts
  backing up.
- Lower `RATE_LIMIT_SIMULATE_MAX` before lowering general reads; simulation
  previews call Soroban RPC and can become the bottleneck first.
- Increase `RATE_LIMIT_AUTH_MAX` only for trusted API-key clients, because it is
  keyed by `x-api-key` instead of IP.
