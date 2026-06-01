# Mainnet Deployment Checklist

This document covers every step required to deploy the Stellar Royalty Splitter from Testnet to
Stellar Mainnet. Work through each section in order. Mark each checkbox before proceeding to the
next step.

---

## Prerequisites

- [ ] Rust toolchain installed (`rustup show` — stable channel)
- [ ] `wasm32-unknown-unknown` target added: `rustup target add wasm32-unknown-unknown`
- [ ] Stellar CLI installed: `cargo install --locked stellar-cli`
- [ ] `wasm-opt` available (optional but recommended): install via
      [binaryen](https://github.com/WebAssembly/binaryen/releases) or `brew install binaryen`
- [ ] Freighter wallet extension installed and updated to the latest version
- [ ] Mainnet deployer account funded with sufficient XLM (minimum ~10 XLM for deployment fees)
- [ ] `backend/.env` file prepared (see [Environment Variable Checklist](#3-environment-variable-checklist))

---

## 1. WASM Optimization

The optimized WASM artifact is smaller, which reduces ledger-entry fees on every contract
invocation. Always deploy the optimized build.

### 1a. Build in release mode

```bash
cargo build --target wasm32-unknown-unknown --release
```

Output: `target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm`

### 1b. Optimize the WASM

**Option A — standalone `wasm-opt` (preferred):**

```bash
wasm-opt -Oz \
  target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm \
  -o target/wasm32-unknown-unknown/release/stellar_royalty_splitter.optimized.wasm
```

**Option B — Stellar CLI bundled optimizer:**

```bash
stellar contract optimize \
  --wasm target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm
```

This produces `stellar_royalty_splitter.optimized.wasm` in the same directory.

**Option C — Makefile target (runs both build + optimize):**

```bash
make optimize          # build + wasm-opt -Oz (or CLI fallback)
make check-size        # print raw vs optimised byte counts
make deploy-ready      # gate: fails if optimised artifact is missing
```

- [ ] Optimized WASM artifact confirmed present:
      `target/wasm32-unknown-unknown/release/stellar_royalty_splitter.optimized.wasm`
- [ ] Size reduction verified (`make check-size` or `wc -c` on both artifacts)

---

## 2. Contract Deployment

### 2a. Create / verify Mainnet identity

```bash
# Check existing identities
stellar keys ls

# Generate a new Mainnet identity (skip if you already have one)
stellar keys generate --global mainnet-deployer

# Display the public address to fund it
stellar keys address mainnet-deployer
```

Fund the address with XLM on Mainnet before continuing. Minimum recommended balance: **10 XLM**.

- [ ] Mainnet deployer identity exists and is funded

### 2b. Deploy the optimized contract

```bash
STELLAR_NETWORK=mainnet STELLAR_IDENTITY=mainnet-deployer ./scripts/deploy.sh
```

Or invoke directly:

```bash
CONTRACT_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_royalty_splitter.optimized.wasm \
  --source mainnet-deployer \
  --network mainnet)

echo "Contract ID: $CONTRACT_ID"
echo "$CONTRACT_ID" > .contract-id
```

- [ ] Deployment succeeded without errors
- [ ] Contract ID recorded (saved to `.contract-id` and noted below)

**Contract ID:** `_________________________________`

### 2c. Initialize the contract

The first collaborator address **must** be the `--source` (or co-sign the transaction) because
`initialize` calls `require_auth()` on `collaborators[0]`.

```bash
stellar contract invoke \
  --id "$(cat .contract-id)" \
  --source mainnet-deployer \
  --network mainnet \
  -- initialize \
  --collaborators '["<ADDR_1>","<ADDR_2>","<ADDR_3>"]' \
  --shares '[5000,3000,2000]'
```

Replace `<ADDR_1>` … with real collaborator Mainnet public keys. Shares are in basis points and
**must sum to 10,000**.

- [ ] `initialize` transaction confirmed on Mainnet
- [ ] Transaction hash recorded: `_________________________________`

---

## 3. Environment Variable Checklist

Copy the example file and fill in every variable before starting the backend:

```bash
cp backend/.env.example backend/.env
```

| Variable | Mainnet value | Notes |
|---|---|---|
| `PORT` | `3001` (or your chosen port) | Must match reverse-proxy / load-balancer config |
| `STELLAR_NETWORK` | `mainnet` | **Must not be `testnet`** |
| `HORIZON_URL` | `https://horizon.stellar.org` | Stellar Foundation public Mainnet endpoint |
| `SOROBAN_RPC_URL` | `https://soroban-rpc.mainnet.stellar.gateway.fm` | Or your own RPC node |
| `SERVER_SECRET_KEY` | Your server keypair secret | Use `SIGNING_KEY_FILE` in production |
| `SIGNING_KEY_FILE` | `/run/secrets/signing_key` | Preferred over `SERVER_SECRET_KEY`; secrets-manager path |
| `ADMIN_ROTATE_TOKEN` | Strong random string | `openssl rand -hex 32` |

**Security reminders:**

- [ ] `STELLAR_NETWORK=mainnet` confirmed (not `testnet`)
- [ ] `HORIZON_URL` points to `https://horizon.stellar.org`
- [ ] `SOROBAN_RPC_URL` points to a Mainnet RPC endpoint
- [ ] `SERVER_SECRET_KEY` or `SIGNING_KEY_FILE` set (never both hardcoded in plain text)
- [ ] `ADMIN_ROTATE_TOKEN` set to a strong random value
- [ ] `.env` is in `.gitignore` and has not been committed

Generate a secure `ADMIN_ROTATE_TOKEN`:

```bash
openssl rand -hex 32
```

---

## 4. Freighter Network Switch

Before testing from the frontend, switch Freighter to Mainnet.

1. Open Freighter and click the network selector (top-right, shows "TESTNET" by default).
2. Select **"MAINNET"**.
3. Confirm the network indicator turns green and displays **"Mainnet"**.
4. Verify your Mainnet account balance is displayed correctly.

- [ ] Freighter switched to **Mainnet**
- [ ] Correct Mainnet account selected in Freighter
- [ ] Account balance reflects expected XLM balance on Mainnet

---

## 5. Post-Deployment Verification

### 5a. Contract state verification

```bash
# Confirm collaborators are registered
stellar contract invoke \
  --id "$(cat .contract-id)" \
  --source mainnet-deployer \
  --network mainnet \
  -- get_collaborators

# Confirm paused state is false (contract is active)
stellar contract invoke \
  --id "$(cat .contract-id)" \
  --source mainnet-deployer \
  --network mainnet \
  -- is_paused
```

- [ ] `get_collaborators` returns the expected list of addresses
- [ ] `is_paused` returns `false`

### 5b. Backend health check

```bash
curl -s http://localhost:3001/health | jq .
```

Expected response:

```json
{ "status": "ok", "network": "mainnet" }
```

- [ ] Health endpoint responds with `"network": "mainnet"`

### 5c. Explorer verification

1. Open [Stellar Expert](https://stellar.expert/explorer/public) or
   [StellarChain](https://stellarchain.io).
2. Search for your Contract ID.
3. Confirm the contract appears with the correct Wasm hash and creation ledger.

- [ ] Contract visible on Mainnet explorer
- [ ] Wasm hash matches the hash of `stellar_royalty_splitter.optimized.wasm`

### 5d. End-to-end smoke test

Perform a small test distribution with a trivial token amount before announcing the deployment:

```bash
stellar contract invoke \
  --id "$(cat .contract-id)" \
  --source mainnet-deployer \
  --network mainnet \
  -- distribute \
  --token "<TOKEN_CONTRACT_ID>" \
  --amount 100
```

- [ ] Test distribution completed without error
- [ ] Each collaborator address received the correct proportional amount on-chain

---

## 6. Post-Deployment Checklist Summary

| # | Item | Done |
|---|---|---|
| 1 | Optimized WASM built and size-checked | ☐ |
| 2 | Contract deployed to Mainnet | ☐ |
| 3 | Contract ID saved to `.contract-id` | ☐ |
| 4 | `initialize` called with correct collaborators and shares | ☐ |
| 5 | All backend env variables set for Mainnet | ☐ |
| 6 | Freighter switched to Mainnet | ☐ |
| 7 | `get_collaborators` returns expected addresses | ☐ |
| 8 | `is_paused` returns `false` | ☐ |
| 9 | Backend health endpoint confirms Mainnet | ☐ |
| 10 | Contract visible on Mainnet block explorer | ☐ |
| 11 | Smoke-test distribution executed successfully | ☐ |
| 12 | `stellar.toml` updated with Mainnet contract address | ☐ |

---

## Rollback / Emergency Pause

If a critical issue is found after deployment, pause the contract immediately:

```bash
stellar contract invoke \
  --id "$(cat .contract-id)" \
  --source mainnet-deployer \
  --network mainnet \
  -- pause
```

This halts all `distribute` calls until `unpause` is called by the admin. Refer to
`SECURITY.md` for the incident response process.

---

*Keep this document in sync whenever the contract interface or backend configuration changes.*
