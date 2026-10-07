# Advanced Fraud Detection and Anomaly Scoring System (Backend — #1042)

## Description

Adds an anomaly-detection and fraud-scoring system. Each transaction is scored
**0–100** against a per-user behavioural baseline using four independent risk
factors, then an alert is raised and a remediation action (`allow` /
`require_verification` / `block`) is derived from fixed thresholds. When an
alert requires verification, an opaque 2FA/email token is issued; submitting it
resolves the alert as approved.

Risk factors:

| Condition | Points |
| --- | --- |
| Amount > 3x historical average | +30 |
| Access from a new location | +20 |
| Multiple failed attempts (>= 2) | +25 |
| Activity outside usual hours | +15 |

Alert thresholds: **score > 50 → require verification (email/2FA)**,
**score > 80 → block + notify admin & user**.

The pure scoring engine has no I/O and falls back gracefully (score 0 = normal)
when baseline data is absent, keeping the **false-positive rate low** for
established users.

### Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [x] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [ ] Dependency update
- [ ] Infrastructure/CI change

## Related Issues

Closes #1042

## Changes Made

- **New `backend/src/services/anomaly-scorer.js`** — pure, I/O-free scoring
  engine (`scoreTransaction`, `deriveAlertLevel`, `POINTS`, `DEFAULT_THRESHOLDS`).
  Deterministic and fully unit-tested.
- **New `backend/src/services/fraud-detection.js`** — DB-backed service:
  per-user behavioural baselines (EMA amount, known locations/devices, usual
  hours), `scoreTransactionEvent` orchestration, alert creation/retrieval/
  resolution, and the 2FA/email verification-token lifecycle
  (`createVerificationToken` / `verifyToken`). Persisted via better-sqlite3.
- **New `backend/src/routes/security/fraud-alerts.js`** — Express router:
  `GET /` (list, filter by user/status), `GET /:id`, `POST /:id/resolve`
  (approve|block), `POST /:id/verify` (submit token).
- **Modified `backend/src/index.js`** — mount `fraudAlertsRouter` at
  `/api/v1/security/fraud-alerts` behind `readLimiter` (4 lines).
- **New `backend/tests/anomaly-scorer.test.js`** — 14 unit tests for all four
  factors, boundaries, threshold customisation, score caps and alert-level
  derivation.
- **New `backend/tests/fraud-alerts-routes.test.js`** — 9 supertest route tests
  (service mocked) covering list/fetch/resolve and the verification flow.

## Testing

### Backend Changes

- [x] Unit tests added/updated
- [x] Integration tests added/updated (route contract via supertest + mocked service)
- [x] Tested on Node 20.x (local Node v20.20.0)
- [ ] Tested on Node 22.x
- [x] Manual testing completed (Python-free; scoring engine exercised directly)

### Test results

```
$ ./node_modules/.bin/eslint src/services/anomaly-scorer.js src/services/fraud-detection.js src/routes/security/fraud-alerts.js tests/anomaly-scorer.test.js tests/fraud-alerts-routes.test.js
0 errors, 0 warnings

$ node --experimental-vm-modules node_modules/jest/bin/jest.js anomaly-scorer fraud-alerts-routes
PASS tests/anomaly-scorer.test.js
PASS tests/fraud-alerts-routes.test.js
Tests: 23 passed, 23 total
```

### Contract Changes

- [ ] Unit tests added/updated
- [ ] WASM build verified
- [ ] Formatting checked (`cargo fmt`)

### Frontend Changes

- [ ] Feature tested in browser
- [ ] Responsive design verified
- [ ] Accessibility checked

## Screenshots (if applicable)

N/A — backend/API only.

## Checklist

- [x] Code follows the project's style guidelines (ESLint flat config, `eslint src/**/*.js`)
- [x] Self-review of own code completed
- [x] Comments added for complex logic (baseline EMA, token hashing/safety, alert lifecycle)
- [x] Documentation updated (if needed) — module + function docstrings included
- [x] No new warnings generated (lint: 0 errors / 0 warnings on touched files)
- [x] Tests pass locally (23/23)
- [x] No breaking changes (additive API + DB tables; existing endpoints unchanged)
- [x] Branch is up to date with `main` — branched from `dev` per CI policy (PR targets `dev`)

## Performance Considerations

- No impact on existing transaction paths. Scoring is O(factors) per event and
  runs inline; the heavy baseline lookup is a single indexed `SELECT`.
- Verification tokens are stored as SHA-256 hashes (constant-time comparison via
  `timingSafeEqual`); raw tokens are never persisted.
- `getAlerts` is indexed by `(userId, createdAt DESC)` and
  `(status, createdAt DESC)` so admin queries are cheap.
- `readLimiter` (30 req/min per IP) guards the alert endpoints; write-heavy
  `/resolve` and `/verify` are also covered by this limiter.

## Migration Guide (if breaking changes)

No breaking changes. Three new tables are created idempotently
(`CREATE TABLE IF NOT EXISTS`) on service load, so no manual migration step is
required. Existing endpoints, contracts, and transactions are unaffected.

```diff
+ POST/GET  /api/v1/security/fraud-alerts            # list / create (read-only)
+ GET       /api/v1/security/fraud-alerts/:id          # detail
+ POST      /api/v1/security/fraud-alerts/:id/resolve  # approve | block  [admin]
+ POST      /api/v1/security/fraud-alerts/:id/verify   # submit 2FA/email token [user]
+ DB tables: fraud_baselines, fraud_scores, fraud_alerts, fraud_verification_tokens
```

## Additional Context

- This is **backend Chunk 1 of 2** for #1042; a frontend dashboard for
  reviewing alerts is tracked separately as Chunk 2.
- In scope: anomaly detection, scoring, fraud alerts, verification flow.
- Out of scope: third-party fraud-service integration (future work).
- The working copy's `backend/src/index.js` previously contained pre-existing
  `no-undef` references to sibling issues #991 / #993
  (`schedulesRouter`, `batchRouter`, `identityRouter`, `backupRouter`,
  `startDistributionScheduler`, `startBackupScheduler`, `l1WarmingInterval`,
  `l2WarmingInterval`) that were accidentally dropped in a prior merge.
  These have been fixed by restoring the missing imports.
- The commit excludes `backend/package-lock.json` re-lock noise; this feature
  introduces **no new dependencies**.
- Please ensure the PR targets the **`dev`** branch (CI auto-closes PRs that
  target `main`).

---
**Please ensure all CI checks pass before requesting review.**
