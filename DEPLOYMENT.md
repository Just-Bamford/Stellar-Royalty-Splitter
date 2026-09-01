# Deployment Guide

Checklist and tooling for deploying the Stellar Royalty Splitter contract to
testnet or mainnet. Use this alongside `scripts/deploy.sh` and
`scripts/validate-deployment.sh`.

## Table of Contents

- [Pre-Deployment Checklist](#pre-deployment-checklist)
- [Running Validation](#running-validation)
- [Deploying](#deploying)
- [Post-Deployment Checklist](#post-deployment-checklist)
- [Rollback Procedure](#rollback-procedure)

## Pre-Deployment Checklist

- [ ] Rust toolchain and `wasm32-unknown-unknown` target installed
- [ ] Stellar CLI installed (`cargo install --locked stellar-cli`)
- [ ] Signing identity exists (`stellar keys show <identity>`) and is funded
      on the target network
- [ ] Contract builds cleanly (`cargo build --target wasm32-unknown-unknown --release`)
- [ ] WASM optimizes cleanly (`stellar contract optimize`)
- [ ] Collaborator addresses and share basis points are finalized and sum to
      10,000 (100.00%)
- [ ] The first collaborator in the list is the intended admin — `initialize()`
      requires that address's auth
- [ ] Simulated contract upload succeeds (no funds spent, catches permission
      or balance issues early)
- [ ] `backend/.env` target (`ROYALTY_CONTRACT_ID`, `STELLAR_NETWORK`) is the
      one you intend to update

Run all of the above automatically with:

```bash
STELLAR_NETWORK=testnet STELLAR_IDENTITY=deployer ./scripts/validate-deployment.sh pre
```

## Running Validation

`scripts/validate-deployment.sh` has two modes:

```bash
# Before deploying: build, WASM, identity/balance, simulated upload
./scripts/validate-deployment.sh pre

# After deploying: on-chain state checks against a live contract ID
./scripts/validate-deployment.sh post <CONTRACT_ID>
```

Each check prints `[✓]` on success or `[✗]` on failure, and the script exits
non-zero if any check fails — safe to wire into CI or a release runbook.
Respects the same `STELLAR_NETWORK` / `STELLAR_IDENTITY` environment
variables as `scripts/deploy.sh`.

## Deploying

Once `pre` validation passes:

```bash
STELLAR_NETWORK=testnet STELLAR_IDENTITY=deployer ./scripts/deploy.sh
```

This builds, optimizes, deploys, and writes the resulting `CONTRACT_ID` to
`.contract-id` and `backend/.env`. It prints the `initialize` invocation you
still need to run manually (admin auth can't be scripted safely).

## Post-Deployment Checklist

- [ ] `is_initialized()` returns `true` after calling `initialize`
- [ ] `get_admin()` returns the expected first-collaborator address
- [ ] Collaborators/shares match what was intended (spot-check via
      `stellar contract invoke -- get_collaborators` if available, or the
      backend `/api/collaborators/:contractId` endpoint)
- [ ] `backend/.env` `ROYALTY_CONTRACT_ID` and `STELLAR_NETWORK` match this
      deployment
- [ ] Backend restarted / redeployed so it picks up the new contract ID
- [ ] A test distribution on testnet succeeds end-to-end before treating a
      mainnet deployment as final

Run the automated portion with:

```bash
STELLAR_NETWORK=testnet STELLAR_IDENTITY=deployer ./scripts/validate-deployment.sh post <CONTRACT_ID>
```

## Rollback Procedure

Soroban contracts are immutable once deployed — there is no in-place revert.
If a deployment is misconfigured or broken:

1. **Do not point the backend at the bad contract.** If `backend/.env` was
   already updated, revert `ROYALTY_CONTRACT_ID` to the previous known-good
   contract ID (check `.contract-id` history / git history of `backend/.env`
   if tracked, or your deployment log) and restart the backend.
2. **If `initialize()` was never called** on the bad contract, it's inert —
   no funds can be distributed through it. Simply stop referencing it; no
   further action is required on-chain.
3. **If `initialize()` succeeded but the configuration is wrong** (wrong
   collaborators/shares), deploy a corrected contract from scratch using
   `scripts/deploy.sh` and repeat the full checklist above. Do not attempt to
   "fix" the live contract — Soroban contract state/logic for a deployed
   WASM cannot be changed without an explicit upgrade path, and this
   contract does not expose one for its core split configuration.
4. **If funds were already sent to the bad contract** before the issue was
   caught, they are recoverable only via whatever withdrawal/admin function
   the contract exposes (see `is_initialized`/`get_admin` and the contract's
   own README for any admin-only recovery calls) — there is no generic
   rollback for on-chain state.
5. **Record the incident**: keep the bad `CONTRACT_ID`, the network, the
   timestamp, and the root cause in your team's deployment log so future
   `pre` validation runs can be extended to catch the same class of mistake.

---

## Blue-Green Deployment

Soroban contracts are immutable and cannot be reverted in place. That is
exactly what makes blue-green work here rather than being bolted on:

- **Blue** — the contract `ROYALTY_CONTRACT_ID` currently points at. Serving.
- **Green** — the newly deployed candidate. On-chain, but not yet serving.

Both exist simultaneously. *Switching traffic* means repointing the backend at
green; *rolling back* means pointing it back at blue, which never stopped
existing. Cutover destroys nothing, so the rollback window costs only
configuration.

```bash
./scripts/blue-green-deploy.sh status     # what is serving, what can be restored
./scripts/blue-green-deploy.sh deploy     # deploy, validate, cut over, monitor
./scripts/blue-green-deploy.sh rollback   # restore the previous contract
```

### Deploy sequence

| Step | What runs | On failure |
|---|---|---|
| 1. Pre-flight | `validate-deployment.sh pre` | Abort; nothing deployed |
| 2. Deploy green | `deploy.sh` | Abort; blue still serving |
| 3. Readiness | Poll `/api/v1/health` until it responds | Abort before cutover |
| 4. Validation | `validate-deployment.sh post` + dependency reachability | Abort; **traffic never switched** |
| 5. Cutover | Repoint `ROYALTY_CONTRACT_ID` at green | — |
| 6. Monitoring | Poll `/api/v1/health/detailed` for `ROLLBACK_WINDOW` seconds | **Automatic rollback to blue** |

Traffic is switched only after step 4 passes. A candidate that fails
validation is left inert on-chain and blue keeps serving — the failure costs
a deploy, not an outage.

`/api/v1/health/detailed` returns 503 when any critical component is
unhealthy, so its HTTP status is a sufficient gate. Critical external
dependencies (`SOROBAN_RPC_URL`, `HORIZON_URL`) are checked too: a green
contract behind an unreachable RPC endpoint is not a successful deploy.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HEALTH_URL` | `http://localhost:3001/api/v1/health` | Endpoint polled for readiness and health |
| `READINESS_TIMEOUT` | `120` | Seconds to wait for the backend to respond |
| `ROLLBACK_WINDOW` | `300` | Seconds to monitor after cutover before declaring success |

State lives in `.deploy-state` at the repo root (gitignored — it is
per-deployment-host state, not source), so a rollback does not depend on
anyone remembering the previous address.

### Migrations and rollback safety

**A deployment is only rollback-safe if the previous application version can
still read the current database.** Rolling the contract back does not roll
back the database.

Migrations are declared inline in `backend/src/database/core.js` against the
`schema_migrations` table. The deploy workflow warns when that file changes.
Before deploying a schema change, confirm it is backward-compatible:

- **Safe:** adding a nullable column, adding a table, adding an index.
- **Unsafe:** dropping or renaming a column the previous version reads,
  narrowing a type, adding a `NOT NULL` column without a default.

For an unsafe change, split it across two releases — expand, deploy, migrate
data, then contract in a later release — so that at no point is a live
version reading a schema it does not understand.

### Emergency manual rollback

If the automated path is unavailable (script missing, state file lost, runner
gone):

1. Find the last known-good contract ID — `.deploy-state`, the `.contract-id`
   history, or the deploy log for the previous release.
2. Set it in the serving environment:
   ```bash
   # backend/.env, or the environment variable in your process manager
   ROYALTY_CONTRACT_ID=<previous-known-good-contract-id>
   ```
3. Restart the backend.
4. Confirm recovery: `curl -fsS "$HEALTH_URL/detailed"` must return 200.
5. Record the incident — contract ID, network, timestamp, root cause — per
   [Rollback Procedure](#rollback-procedure) step 5.

The failed contract stays on-chain and inert. Provided `initialize()` was
never called against it, no funds can move through it.

### Verification status

The rollback mechanism — repointing `ROYALTY_CONTRACT_ID` and restoring
recorded state — has been exercised locally, including the failure case where
no previous version is recorded (the script refuses to act and directs the
operator to the manual procedure above rather than silently continuing).

Zero-downtime cutover under live traffic has **not** been verified: doing so
requires a deployed staging environment with a funded signing identity, which
does not exist yet. The `deploy` path's on-chain steps are therefore
unproven in a real environment and should be exercised on testnet before
first production use.
