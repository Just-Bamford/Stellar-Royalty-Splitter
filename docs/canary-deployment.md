# Canary deployments (#936)

New API versions no longer go straight to 100% of production traffic. They
start as a **canary** that receives 1% of requests, and traffic moves up only
while the canary stays as healthy as the version it is replacing.

```
1% ── 30 min ──▶ 5% ── 10 min ──▶ 25% ── 10 min ──▶ 100% ──▶ promoted
 │                │                 │
 └────────────────┴─────────────────┴──▶ any regression ──▶ 0% (rolled back)
```

## How it fits this deployment

The API writes a single SQLite file on a single EBS volume, so a canary cannot
be a second host. It runs as a **second process on the same instance**:

| | Stable | Canary |
|---|---|---|
| pm2 name | `royalty-splitter-api` | `royalty-splitter-api-canary` |
| Port | 3001 | 3002 |
| Target group | environment's `target_group_arn` | `canary_target_group_arn` (`infra/terraform/canary-deployment.tf`) |
| Prometheus label | `deployment="stable"` | `deployment="canary"` |

Both processes use the same database in WAL mode, which SQLite supports safely
across processes on one host. The ALB listener rule created by
`canary-deployment.tf` forwards with weights; Terraform creates it at 100/0 and
then ignores the weights, which `infra/canary-controller.js` owns.

**Schema changes must be backward compatible** while a canary is live, because
both versions read and write the same tables. Use expand → deploy → contract:
add columns/tables in one release, stop using the old ones in the next, drop
them in a third.

## What decides promotion or rollback

Every minute the controller compares the canary with stable over the last
5 minutes (`--metrics prometheus`) or since its previous scrape
(`--metrics direct`):

| Check | Rolls back when | Flag |
|---|---|---|
| Canary 5xx ratio | > 5% | `--max-error-rate` |
| Canary vs stable 5xx | > 2 percentage points worse | `--max-error-rate-increase` |
| Canary p95 latency | > 2000 ms | `--max-p95-ms` |
| Canary vs stable p95 | > 1.5× slower | `--max-latency-ratio` |

- Ratios are judged only once a window has ≥ 20 canary requests
  (`--min-requests`), so one unlucky request at 1% cannot trigger a rollback.
- Two consecutive failing checks roll back (`--failure-threshold`); one blip
  does not.
- A stage that never gets enough traffic to judge **rolls back** unless
  `--allow-low-traffic` is set. No evidence is not the same as healthy.
- If the controller itself errors (Prometheus unreachable, canary crashed), it
  rolls back.

Health-check and `/metrics` traffic is excluded from every ratio.

## Traffic shadowing

Before any user is routed to the canary, stable can mirror its read traffic to
it. Set on the **stable** process:

```
SHADOW_TARGET_URL=http://127.0.0.1:3002
SHADOW_SAMPLE_RATE=1        # fraction of eligible requests
```

After stable has answered, a copy of each `GET`/`HEAD` request is replayed
against the canary with `X-Shadow-Request: 1` and the answer is discarded.
Only the status class is compared (`stellar_shadow_requests_total{result="match|mismatch|error"}`);
`RoyaltySplitterShadowTrafficMismatch` fires above 5% mismatches.

Writes are **never** mirrored: both versions share the database, so replaying
a `POST` would record every distribution or sale twice. `/admin` and
`/metrics` are excluded, credentials (`Authorization`) are not forwarded, and
a mirrored request is never mirrored again.

## Pipeline

`.github/workflows/deploy.yml` → **Deploy to production**, when the
production environment variable `CANARY_ENABLED` is `true`:

1. Start the new version as the canary at 0% and enable shadowing.
2. `node infra/canary-controller.js run --router alb --metrics prometheus …`
   (exits 0 when promoted, 1 when rolled back).
3. On failure: force weight 0 and stop the canary. The job fails.
4. On success: deploy the release onto stable, return the rule to 100/0, and
   retire the canary.

Required production variables: `AWS_DEPLOY_ROLE_ARN`, `CANARY_RULE_ARN`,
`STABLE_TARGET_GROUP_ARN`, `CANARY_TARGET_GROUP_ARN`, `PROMETHEUS_URL`, and
optionally `PUSHGATEWAY_URL`. Attach the `canary_controller_policy_json`
Terraform output to the deploy role (or set `deployer_role_name`).

## Watching a rollout

- **Grafana → "Stellar Royalty Splitter — Canary Deployment"** shows the
  rollout state, the current traffic percentage and stage, consecutive failed
  checks, and stable vs canary error rate, p95 latency, request rate and
  shadow results. Controller state reaches it through the Pushgateway.
- **The workflow run summary** holds a table of every stage and the last ten
  checks; `canary-status.json` is uploaded as an artifact.
- **Alerts** (`monitoring/canary-alerts.yml`, and CloudWatch alarms on the
  canary target group) page a human if a canary is unhealthy while still in
  rotation, e.g. because the controller died mid-rollout.

## Manual controls

```bash
# Emergency rollback — all traffic to stable immediately
node infra/canary-controller.js set-weight 0 --router alb \
  --rule-arn "$CANARY_RULE_ARN" --stable-tg "$STABLE_TG" --canary-tg "$CANARY_TG"

# Rehearse on the host without touching the load balancer
node infra/canary-controller.js run --router none --metrics direct \
  --stable-metrics-url http://127.0.0.1:3001/metrics \
  --canary-metrics-url http://127.0.0.1:3002/metrics \
  --stages 5:300,100:0 --check-interval 30

# Render a saved status as markdown
node infra/canary-controller.js status --status-file canary-status.json --markdown
```

## Tests

`infra/tests/canary-e2e.test.js` runs real HTTP servers for stable and canary
behind a weighted proxy, drives traffic through it, and checks that a healthy
canary goes 1% → 5% → 25% → 100%, and that an error spike (at 1% or starting
mid-rollout), a latency regression, or a crashed canary each end at 0%, with
users then seeing only the stable version.
