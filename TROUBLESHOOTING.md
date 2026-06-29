# Stellar Royalty Splitter — Troubleshooting Guide

Self-service guide for diagnosing and fixing common issues. Each entry includes symptoms, root cause, and step-by-step resolution.

**Quick links**
- [Environment & Configuration](#1-environment--configuration)
- [Smart Contract (Rust / Soroban)](#2-smart-contract-rust--soroban)
- [Distribution & Shares](#3-distribution--shares)
- [Backend (Express API)](#4-backend-express-api)
- [Frontend (React / Vite)](#5-frontend-react--vite)
- [Wallet & Freighter](#6-wallet--freighter)
- [Secondary Royalties](#7-secondary-royalties)
- [Contract Upgrades](#8-contract-upgrades)
- [Tests](#9-tests)
- [Deployment & CI/CD](#10-deployment--cicd)
- [Debug Checklist](#debug-checklist)
- [Getting Help](#getting-help)

---

## 1. Environment & Configuration

### 1.1 Backend fails to start — missing or placeholder env vars

**Symptom**
```
Error: SERVER_SECRET_KEY is required
```
or the server starts but all Soroban calls return connection errors.

**Cause**  
`backend/.env` was not created from the example, or required variables are still at their placeholder values.

**Fix**
```bash
cd backend
cp .env.example .env
# Open .env and set at minimum:
#   SERVER_SECRET_KEY=S...
#   SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
#   STELLAR_NETWORK=testnet
```

---

### 1.2 Frontend shows wrong network on first load

**Symptom**  
The network badge shows `mainnet` but you intended `testnet` (or vice versa).

**Cause**  
`VITE_STELLAR_NETWORK` in `frontend/.env` is set to the wrong value, or the file doesn't exist.

**Fix**
```bash
cd frontend
cp .env.example .env
# Set: VITE_STELLAR_NETWORK=testnet
```
This only sets the initial value — users can toggle the network in the UI at runtime.

---

### 1.3 Backend health check returns `"network": "testnet"` on production

**Symptom**
```bash
curl http://localhost:3001/health
# {"status":"ok","network":"testnet"}   ← wrong for production
```

**Fix**  
In `backend/.env`:
```
STELLAR_NETWORK=mainnet
HORIZON_URL=https://horizon.stellar.org
SOROBAN_RPC_URL=https://soroban-rpc.mainnet.stellar.gateway.fm
```
Restart the backend. Confirm with another `curl /health`.

---

### 1.4 CORS errors from the frontend

**Symptom**
```
Access to fetch at 'http://localhost:3001/api/...' from origin 'http://localhost:5173'
has been blocked by CORS policy
```

**Fix**  
Set `FRONTEND_ORIGIN` in `backend/.env`:
```
FRONTEND_ORIGIN=http://localhost:5173
```
For multiple origins, add a comma-separated list if your backend version supports it. Restart the backend after changing this value.

---

### 1.5 `ADMIN_ROTATE_TOKEN` left empty — hot-reload endpoint unprotected

**Symptom**  
`POST /admin/rotate-key` succeeds without any auth header.

**Fix**  
Generate a strong token and set it before deploying:
```bash
openssl rand -hex 32
# paste the output as ADMIN_ROTATE_TOKEN in backend/.env
```

---

## 2. Smart Contract (Rust / Soroban)

### 2.1 Build fails — `wasm32-unknown-unknown` target missing

**Symptom**
```
error[E0463]: can't find crate for `std`
```

**Fix**
```bash
rustup target add wasm32-unknown-unknown
cargo build --target wasm32-unknown-unknown --release
```

---

### 2.2 Deploy fails — insufficient XLM on testnet

**Symptom**
```
OperationResultCode: opUNDERFUNDED
```

**Fix**  
Fund the deployer account via Friendbot:
```bash
curl "https://friendbot.stellar.org?addr=$(stellar keys address deployer)"
```
Then re-run `./scripts/deploy.sh`.

---

### 2.3 `initialize` fails — shares do not sum to 10,000

**Symptom**
```
Error: shares must sum to 10000
```

**Cause**  
Basis-point allocations passed to `initialize` don't add up to 10,000 (100%).

**Fix**  
Recalculate shares. Example — 3-way split:
```
5000 (50%) + 3000 (30%) + 2000 (20%) = 10000 ✓
```
Then retry:
```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- initialize \
  --collaborators '["GADDR1...","GADDR2...","GADDR3..."]' \
  --shares '[5000,3000,2000]'
```

---

### 2.4 `initialize` fails — empty collaborators array

**Symptom**
```
Error: collaborators list must not be empty
```

**Cause**  
An empty `[]` was passed as `--collaborators`. Added in PR #377.

**Fix**  
Pass at least one collaborator address.

---

### 2.5 `initialize` can only be called once

**Symptom**
```
Error: contract already initialized
```

**Cause**  
The contract stores state after the first `initialize` call and rejects subsequent calls.

**Fix**  
This is by design — shares are immutable once set. If you need to change shares, deploy a new contract instance and call `initialize` on it.

---

### 2.6 `distribute` fails — contract has insufficient token balance

**Symptom**
```
Error: insufficient balance
```

**Cause**  
The `amount` passed to `distribute` exceeds the contract's current token balance.

**Fix**  
Check the contract's token balance first, then distribute only what is available:
```bash
# Check balance via Stellar CLI or Horizon
stellar contract invoke \
  --id <TOKEN_CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- balance \
  --id <ROYALTY_CONTRACT_ID>
```

---

### 2.7 `distribute` requires admin authorization

**Symptom**
```
Error: unauthorized
```

**Cause**  
`distribute` requires the calling account to be an admin. The source signing the transaction is not an admin.

**Fix**  
Sign with the admin key used during `initialize`:
```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_IDENTITY> \
  --network testnet \
  -- distribute \
  --token <TOKEN_ADDRESS> \
  --amount 10000000000
```

---

### 2.8 Token address validation error

**Symptom**
```
Error: invalid token address
```

**Cause**  
The `--token` argument is malformed. Added in PR #376.

**Fix**  
Use the full Soroban contract address for the token (a `C...` address, not a Stellar classic asset code):
```bash
# XLM native asset wrapper on testnet:
--token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

---

## 3. Distribution & Shares

### 3.1 Collaborator receives 0 stroops despite non-zero share

**Symptom**  
A collaborator with a small basis-point share (e.g. 1 bp = 0.01%) receives nothing on a small distribution.

**Cause**  
Integer division — `amount * share / 10000` truncates to 0 for very small amounts.

**Fix**  
This is expected behaviour for tiny distributions. The rounding dust goes to the last collaborator. To ensure all collaborators receive something, distribute larger amounts or choose shares that don't result in sub-stroop payouts.

---

### 3.2 Total distributed amount does not equal `amount` passed to `distribute`

**Symptom**  
The sum of all collaborator transfers is 1–2 stroops less than `amount`.

**Cause**  
This was a known rounding issue in early versions. Current versions assign all rounding dust to the last collaborator so the full input amount is always distributed.

**Fix**  
Pull the latest `main` and rebuild. Verify with a test distribution.

---

### 3.3 `distribute_with_override` rejected — invalid override shares

**Symptom**
```
Error: override shares must sum to 10000
```

**Cause**  
The per-call share override passed to `distribute_with_override` doesn't sum to 10,000. Added in PR #381.

**Fix**  
Ensure override shares sum to exactly 10,000 before calling. Use the same basis-point arithmetic as `initialize`.

---

## 4. Backend (Express API)

### 4.1 `503 Service Unavailable` on all API endpoints

**Symptom**  
Every request returns 503 immediately after startup.

**Cause**  
`REQUEST_TIMEOUT_MS` is set too low, or the Soroban RPC endpoint is unreachable.

**Fix**
```bash
# Check RPC reachability
curl https://soroban-testnet.stellar.org

# If RPC is slow, increase the timeout in backend/.env
REQUEST_TIMEOUT_MS=60000
```

---

### 4.2 `429 Too Many Requests`

**Symptom**  
API returns `429` with a `Retry-After` header.

**Fix**  
For development, relax rate limits in `backend/.env`:
```
RATE_LIMIT_MAX=500
RATE_LIMIT_WRITE_MAX=100
RATE_LIMIT_WINDOW_MS=60000
```
In production, respect the `Retry-After` header.

---

### 4.3 Transaction polling times out

**Symptom**
```
Error: transaction polling timed out after 60000ms
```

**Cause**  
The Horizon endpoint is congested or the transaction fee was too low to be included quickly.

**Fix**  
Increase the polling timeout in `backend/.env`:
```
TRANSACTION_POLL_TIMEOUT_MS=120000
TRANSACTION_POLL_INTERVAL_MS=3000
```

---

### 4.4 Webhook delivery failing silently

**Symptom**  
Webhooks are registered but the target URL never receives requests.

**Debug steps**
1. Check backend logs for webhook delivery errors.
2. Ensure the webhook URL is reachable from the backend process.
3. Adjust retry and timeout settings in `backend/.env`:
```
WEBHOOK_MAX_RETRIES=5
WEBHOOK_RETRY_BASE_MS=2000
WEBHOOK_TIMEOUT_MS=15000
```

---

### 4.5 Database file locked or corrupted

**Symptom**
```
Error: SQLITE_BUSY: database is locked
```

**Cause**  
Multiple backend processes are running against the same SQLite file, or the previous process crashed without releasing the lock.

**Fix**
```bash
# Kill all backend processes
pkill -f "node.*index"

# Remove stale lock files
rm -f audit.db-shm audit.db-wal

# Restart
npm run dev
```

---

### 4.6 `POST /admin/rotate-key` returns `401 Unauthorized`

**Symptom**
```json
{"error": "Unauthorized"}
```

**Cause**  
The `Authorization: Bearer <token>` header does not match `ADMIN_ROTATE_TOKEN` in `.env`.

**Fix**  
Pass the correct token:
```bash
curl -X POST http://localhost:3001/admin/rotate-key \
  -H "Authorization: Bearer $(grep ADMIN_ROTATE_TOKEN backend/.env | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"newKey":"S..."}'
```

---

## 5. Frontend (React / Vite)

### 5.1 `npm run dev` fails — port 5173 already in use

**Fix**
```bash
# Kill the process on 5173
npx kill-port 5173
npm run dev

# Or use a different port
npm run dev -- --port 5174
```

---

### 5.2 API calls fail with network errors — backend not running

**Symptom**  
Browser console shows `Failed to fetch` on all `/api/*` calls.

**Fix**  
Start the backend first:
```bash
cd backend && npm run dev
```
The Vite dev server proxies `/api/*` to `http://localhost:3001` automatically.

---

### 5.3 Frontend builds but shows blank page in production

**Cause**  
`dist/` was built against the wrong API base URL, or `VITE_STELLAR_NETWORK` is missing.

**Fix**
```bash
cd frontend
# Ensure .env is correct, then rebuild
npm run build
```
Serve `dist/` from your web server — do not open `index.html` directly via `file://`.

---

### 5.4 `CollaboratorTable` shows no data after `initialize`

**Symptom**  
The collaborator table is empty even though `initialize` succeeded on-chain.

**Cause**  
The frontend calls `GET /api/collaborators` which reads from the backend, and the backend uses the contract ID from `ROYALTY_CONTRACT_ID` (or `CONTRACT_ID`) in `.env`. If that variable isn't set, the query targets no contract.

**Fix**  
Set the contract ID in `backend/.env`:
```
ROYALTY_CONTRACT_ID=C...    # the deployed contract address
```
Restart the backend.

---

### 5.5 E2E tests fail — Playwright browsers not installed

**Symptom**
```
Error: browserType.launch: Executable doesn't exist at ...
```

**Fix**
```bash
cd frontend
npx playwright install --with-deps
npm run test:e2e
```

---

## 6. Wallet & Freighter

### 6.1 "Freighter not detected" — connect button does nothing

**Symptom**  
Clicking Connect Wallet shows no popup or an error about Freighter not being installed.

**Fix**
1. Install [Freighter](https://freighter.app) browser extension.
2. Refresh the page.
3. Make sure the extension is enabled for the current site.

---

### 6.2 Transaction rejected by user

**Symptom**
```
Error: Transaction cancelled by user
```

**Cause**  
The Freighter popup was dismissed or the user clicked Reject.

**Fix**  
This is intentional user action. Retry the operation and approve it in the Freighter popup.

---

### 6.3 Wrong network in Freighter

**Symptom**  
Transactions fail with network passphrase mismatch or the wrong account balance is shown.

**Fix**  
In Freighter: click the network selector → choose **Testnet** (for development) or **Mainnet** (for production). This must match `VITE_STELLAR_NETWORK` in `frontend/.env`.

---

### 6.4 Freighter shows "Account not found"

**Symptom**  
Freighter popup shows "Account not found" when trying to sign.

**Cause**  
The account has no on-chain record — it has never received any XLM.

**Fix**  
Fund the account on testnet:
```bash
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

---

### 6.5 Signed transaction not submitting

**Symptom**  
Freighter signs the transaction but the UI never confirms it on-chain.

**Cause**  
The frontend submits the signed XDR to the backend, which polls Horizon. If `TRANSACTION_POLL_TIMEOUT_MS` is too short or the network is congested, the poll expires before inclusion.

**Fix**  
Increase `TRANSACTION_POLL_TIMEOUT_MS` in `backend/.env` (see [4.3](#43-transaction-polling-times-out)).

---

## 7. Secondary Royalties

### 7.1 `record_secondary_sale` has no effect on collaborator balances

**Symptom**  
Secondary sales are recorded but collaborators don't see pending balances.

**Cause**  
`record_secondary_sale` only accumulates the royalty amount. You must separately call `distribute_secondary_royalties` to push the funds.

**Fix**
```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source anyone \
  --network testnet \
  -- distribute_secondary_royalties \
  --token <TOKEN_ADDRESS>
```

---

### 7.2 Secondary royalty amount is zero after recording

**Symptom**  
`distribute_secondary_royalties` runs but transfers 0 tokens.

**Cause**  
`record_secondary_sale` was called with `sale_price = 0`, or no royalty rate is configured.

**Fix**  
Check the royalty rate set on the contract and ensure `sale_price` reflects the actual sale amount in stroops.

---

## 8. Contract Upgrades

### 8.1 `update_wasm` fails — hash not found on network

**Symptom**
```
Error: wasm hash not found
```

**Cause**  
The WASM must be uploaded to the network before invoking `update_wasm`. The hash is returned by `stellar contract upload`.

**Fix**
```bash
# Step 1: upload the compiled wasm
stellar contract upload \
  --source deployer \
  --wasm target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm \
  --network testnet
# → prints the wasm hash, e.g. aa24c812...

# Step 2: upgrade using that hash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- update_wasm \
  --wasm_hash aa24c812...
```

---

### 8.2 `update_wasm` fails — not admin

**Symptom**
```
Error: unauthorized
```

**Fix**  
Sign with the admin key used at deployment:
```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_IDENTITY> \   # the deployer identity
  --network testnet \
  -- update_wasm \
  --wasm_hash <HASH>
```

---

## 9. Tests

### 9.1 `cargo test` fails — `wasm32-unknown-unknown` not installed

**Fix**
```bash
rustup target add wasm32-unknown-unknown
cargo test
```

---

### 9.2 Auth rejection tests fail on Windows

**Symptom**  
`#[should_panic]` auth tests panic for the wrong reason or don't panic at all on Windows.

**Cause**  
This is a known limitation of how the Soroban test mock handles `require_auth()` on Windows. Tests guarded with `#[cfg(not(target_os = "windows"))]` are intentionally skipped on Windows.

**Fix**  
Run the full test suite on Linux, macOS, or WSL2 to confirm correctness:
```bash
wsl cargo test
```
Do not remove the `cfg` guards — they are intentional.

---

### 9.3 Backend tests fail — `Cannot find module`

**Symptom**
```
Cannot find module '../src/stellar'
```

**Fix**
```bash
cd backend
npm install
npm test
```

---

### 9.4 Frontend tests fail — Vitest cannot find component

**Symptom**
```
Error: Failed to resolve import "@/components/DistributeForm"
```

**Fix**
```bash
cd frontend
npm install
npm run test:coverage
```
Ensure `tsconfig.json` has the correct `paths` alias for `@/`.

---

### 9.5 Test snapshots are stale after a contract change

**Symptom**  
Tests fail with snapshot mismatch errors referencing files in `test_snapshots/`.

**Fix**
```bash
# Update snapshots
cargo test -- --update-snapshots

# Or delete stale snapshots and let them regenerate
rm test_snapshots/*.json
cargo test
```

---

## 10. Deployment & CI/CD

### 10.1 `deploy.sh` fails — `STELLAR_IDENTITY` not found

**Symptom**
```
Error: identity 'deployer' not found
```

**Fix**
```bash
# Create the identity
stellar keys generate --global deployer --network testnet

# Fund it
curl "https://friendbot.stellar.org?addr=$(stellar keys address deployer)"

# Re-run deploy
./scripts/deploy.sh
```

---

### 10.2 WASM size too large for deployment

**Symptom**
```
Error: wasm size exceeds maximum
```

**Fix**  
Optimize the WASM before deploying:
```bash
# Option A — wasm-opt
wasm-opt -Oz \
  target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm \
  -o target/wasm32-unknown-unknown/release/stellar_royalty_splitter.optimized.wasm

# Option B — Stellar CLI
stellar contract optimize \
  --wasm target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm

# Then deploy with the optimized file
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_royalty_splitter.optimized.wasm \
  --source deployer \
  --network testnet
```

---

### 10.3 Push rejected — no push access to `Just-Bamford/Stellar-Royalty-Splitter`

**Symptom**
```
remote: Permission to Just-Bamford/Stellar-Royalty-Splitter.git denied.
```

**Cause**  
You are pushing to the upstream repo directly. Use the fork-based PR workflow.

**Fix**
```bash
# Push to your fork
git push -u origin your-branch

# Open a PR against the upstream
gh pr create --repo Just-Bamford/Stellar-Royalty-Splitter \
  --head YOUR_USERNAME:your-branch \
  --base main
```

---

### 10.4 Contract paused after an incident — how to unpause

**Symptom**  
All `distribute` calls return an error about the contract being paused.

**Fix**
```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_IDENTITY> \
  --network mainnet \
  -- unpause
```
See `SECURITY.md` for the full incident response process before unpausing on Mainnet.

---

## Debug Checklist

Run through this list when something is broken and the source isn't obvious.

```
[ ] Does backend/.env exist? (cp backend/.env.example backend/.env)
[ ] Is SERVER_SECRET_KEY set to a valid S... secret key?
[ ] Is STELLAR_NETWORK correct? (testnet for dev, mainnet for prod)
[ ] Is the Soroban RPC endpoint reachable?
    curl https://soroban-testnet.stellar.org
[ ] Is the Horizon endpoint reachable?
    curl https://horizon-testnet.stellar.org
[ ] Is ROYALTY_CONTRACT_ID / CONTRACT_ID set in backend/.env?
[ ] Does the deployer account have sufficient XLM?
    curl "https://friendbot.stellar.org?addr=<YOUR_KEY>"
[ ] Is Freighter set to the correct network (testnet / mainnet)?
[ ] Does the backend start without errors?
    cd backend && npm run dev
[ ] Does the health endpoint respond correctly?
    curl http://localhost:3001/health
[ ] Do cargo tests pass?
    cargo test
[ ] Are npm dependencies installed in both backend/ and frontend/?
    cd backend && npm install
    cd frontend && npm install
```

---

## Getting Help

If your issue is not covered here:

1. **Search existing issues** — [github.com/Just-Bamford/Stellar-Royalty-Splitter/issues](https://github.com/Just-Bamford/Stellar-Royalty-Splitter/issues)
2. **Read the API docs** — [`backend/API.md`](backend/API.md)
3. **Check the deployment guide** — [`DEPLOYMENT.md`](DEPLOYMENT.md) for mainnet-specific issues
4. **Check the security guide** — [`SECURITY.md`](SECURITY.md) for auth and key management issues
5. **Open a new issue** using the bug report template — include error output, your OS, Node/Rust versions, and a sanitised `.env` (remove secret keys)

> **Security vulnerabilities** — do not open a public issue. Follow the responsible disclosure process in [`SECURITY.md`](SECURITY.md).
