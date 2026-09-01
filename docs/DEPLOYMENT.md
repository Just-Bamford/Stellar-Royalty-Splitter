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

| Variable             | Mainnet value                                    | Notes                                                    |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| `PORT`               | `3001` (or your chosen port)                     | Must match reverse-proxy / load-balancer config          |
| `STELLAR_NETWORK`    | `mainnet`                                        | **Must not be `testnet`**                                |
| `HORIZON_URL`        | `https://horizon.stellar.org`                    | Stellar Foundation public Mainnet endpoint               |
| `SOROBAN_RPC_URL`    | `https://soroban-rpc.mainnet.stellar.gateway.fm` | Or your own RPC node                                     |
| `SERVER_SECRET_KEY`  | Your server keypair secret                       | Use `SIGNING_KEY_FILE` in production                     |
| `SIGNING_KEY_FILE`   | `/run/secrets/signing_key`                       | Preferred over `SERVER_SECRET_KEY`; secrets-manager path |
| `ADMIN_ROTATE_TOKEN` | Strong random string                             | `openssl rand -hex 32`                                   |

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

| #   | Item                                                      | Done |
| --- | --------------------------------------------------------- | ---- |
| 1   | Optimized WASM built and size-checked                     | ☐    |
| 2   | Contract deployed to Mainnet                              | ☐    |
| 3   | Contract ID saved to `.contract-id`                       | ☐    |
| 4   | `initialize` called with correct collaborators and shares | ☐    |
| 5   | All backend env variables set for Mainnet                 | ☐    |
| 6   | Freighter switched to Mainnet                             | ☐    |
| 7   | `get_collaborators` returns expected addresses            | ☐    |
| 8   | `is_paused` returns `false`                               | ☐    |
| 9   | Backend health endpoint confirms Mainnet                  | ☐    |
| 10  | Contract visible on Mainnet block explorer                | ☐    |
| 11  | Smoke-test distribution executed successfully             | ☐    |
| 12  | `stellar.toml` updated with Mainnet contract address      | ☐    |

---

## 7. Pre-Deployment Security Checklist

Before deploying to Mainnet, verify all security requirements are met:

### Contract Security

- [ ] All security audit findings reviewed (see `SECURITY_AUDIT.md`)
- [ ] Priority 1 & 2 remediations completed or documented with deferral justification
- [ ] No known critical vulnerabilities
- [ ] Formal verification completed if applicable
- [ ] Contract code audit by third party (recommended)

### RPC & Infrastructure

- [ ] Multiple RPC endpoints configured (minimum 2, recommended 3)
- [ ] RPC failover/health check logic implemented
- [ ] RPC response validation enabled
- [ ] Circuit breaker pattern implemented for RPC calls
- [ ] Rate limiting configured on RPC calls

### Authentication & Authorization

- [ ] Request signature verification implemented (ed25519)
- [ ] Admin key stored in hardware wallet (NOT in .env)
- [ ] Multi-signature setup for admin (2-of-3 recommended) OR time-lock enabled
- [ ] Key rotation procedure documented
- [ ] Emergency access procedures defined

### Rate Limiting & DDoS

- [ ] Rate limiting configured appropriately (see `SECURITY.md`)
- [ ] IP-based rate limits in place
- [ ] Per-user rate limits configured for authenticated users
- [ ] CAPTCHA or similar protection for sensitive endpoints
- [ ] DDoS mitigation provider configured (Cloudflare, AWS Shield, etc.)

### Database & Backups

- [ ] Database backups configured and tested
- [ ] Backup retention policy defined (minimum 7 years for audit logs)
- [ ] Database encryption enabled
- [ ] Database access restricted to backend only
- [ ] Regular backup restore drills scheduled

### Monitoring & Alerting

- [ ] Monitoring and alerting set up for:
  - [ ] Contract events (distributions, admin transfers)
  - [ ] API error rates
  - [ ] RPC failures and rate limits
  - [ ] Database connectivity
  - [ ] Suspicious request patterns
- [ ] Alert escalation procedures defined
- [ ] On-call rotation established
- [ ] Incident response procedures documented

### Logging & Audit

- [ ] Structured JSON logging enabled
- [ ] Log aggregation configured
- [ ] Log integrity protection enabled (hashing/immutability)
- [ ] Audit logs retained for minimum 7 years
- [ ] Log access restricted and monitored
- [ ] GDPR compliance verified if applicable

### Frontend & Client

- [ ] HTTPS with valid certificates enforced
- [ ] CORS policy correctly configured
- [ ] Frontend served from secure CDN
- [ ] Content Security Policy (CSP) headers set
- [ ] No secrets in frontend code

### Environment & Secrets

- [ ] `STELLAR_NETWORK=mainnet` confirmed
- [ ] `HORIZON_URL` points to Mainnet
- [ ] `SOROBAN_RPC_URL` points to Mainnet RPC
- [ ] `SERVER_SECRET_KEY` or `SIGNING_KEY_FILE` set securely
- [ ] `ADMIN_ROTATE_TOKEN` set to strong random value
- [ ] All secrets stored in secrets manager (NOT in .env in production)
- [ ] `.env` file is in `.gitignore` and never committed

### Testing & Validation

- [ ] All unit tests passing (100% pass rate)
- [ ] E2E tests covering all major flows
- [ ] Load testing completed
- [ ] Security testing (OWASP top 10) completed
- [ ] Penetration testing completed (recommended)
- [ ] Fuzz testing completed on contract (recommended)
- [ ] Smoke test performed on Testnet before Mainnet deployment

### Documentation & Communication

- [ ] All documentation updated for Mainnet
- [ ] Runbooks created for common operational tasks
- [ ] Incident response procedures documented
- [ ] Communication plan for incidents/outages defined
- [ ] Stakeholders notified of Mainnet launch date
- [ ] Support channels established

### Compliance & Legal

- [ ] Terms of Service reviewed and updated
- [ ] Privacy Policy reviewed and updated
- [ ] Data retention policies defined
- [ ] Regulatory requirements for jurisdiction verified
- [ ] KYC/AML requirements assessed and implemented if needed
- [ ] Compliance audit completed (recommended)

---

## Note: Recent Updates (Wave 3)

Recent PRs have added important improvements (June 2026):

- **PR #377**: Non-empty collaborators array validation
- **PR #376**: Token address format validation
- **PR #375**: UI/UX enhancements with loading states
- **PR #381**: `distribute_with_override` share validation

**All Wave 3 changes must be tested on Testnet before Mainnet deployment.**

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

_Keep this document in sync whenever the contract interface or backend configuration changes._
