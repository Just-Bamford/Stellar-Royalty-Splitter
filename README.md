<div align="center">

<h1>Stellar Royalty Splitter</h1>

<p><strong>On-chain royalty distribution for NFT collaborators on Stellar.</strong></p>

<p>
  A Soroban smart contract that automatically splits NFT sale proceeds<br/>
  among multiple collaborators based on predefined percentage allocations —<br/>
  instantly, on-chain, with no intermediaries.
</p>

<p>
  <a href="https://github.com/Just-Bamford/Stellar-Royalty-Splitter/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  </a>
  <img src="https://img.shields.io/badge/soroban-smart%20contract-6f42c1" alt="Soroban" />
  <img src="https://img.shields.io/badge/language-Rust-orange" alt="Rust" />
  <img src="https://img.shields.io/badge/network-testnet%20%7C%20mainnet-brightgreen" alt="Stellar Networks" />
</p>

</div>

---

## Overview

Stellar Royalty Splitter solves the coordination problem in multi-collaborator NFT projects. Instead of relying on a central party to manually divide and send proceeds, the contract enforces the agreed split at the protocol level. Shares are defined once at initialization and cannot be altered — every distribution is deterministic, transparent, and verifiable on-chain.

The contract supports both primary sales and secondary market royalties, with rounding handled explicitly so the full amount is always distributed.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Build](#build)
- [Test](#test)
- [Deploy](#deploy)
- [Contract API](#contract-api)
- [Usage Examples](#usage-examples)
- [Rounding](#rounding)
- [Frontend & Backend](#frontend--backend)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## How It Works

```
Deploy contract
      │
      ▼
initialize(collaborators, shares)   ← one-time setup, basis points sum to 10,000
      │
      ▼
NFT sale occurs → funds sent to contract address
      │
      ▼
distribute(token, amount)           ← splits and transfers proportionally, on-chain
      │
      ▼
Each collaborator receives their share instantly
```

Shares are expressed in **basis points** (1 bp = 0.01%). They must sum to **10,000** (100%).

---

## Prerequisites

| Tool          | Install                                    |
| ------------- | ------------------------------------------ |
| Rust          | https://rustup.rs                          |
| wasm32 target | `rustup target add wasm32-unknown-unknown` |
| Stellar CLI   | `cargo install --locked stellar-cli`       |

---

## Build

```bash
cargo build --target wasm32-unknown-unknown --release
```

---

## Test

### Backend Tests (Node.js)

```bash
cd backend
npm test
```

**Status:** ✅ **152/152 tests passing (100%)**

### Frontend Unit Tests

```bash
cd frontend
npm run test:coverage
```

**Status:** ✅ Vitest + RTL configured, unit tests for core components.

### Frontend E2E Tests

```bash
cd frontend
npm run test:e2e
```

**Status:** 📋 18 tests configured (requires Playwright browsers)

### Rust Contract Tests

```bash
cargo test
```

**Status:** ❓ Requires Rust toolchain

---

## Deploy

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

The deploy script targets Stellar Testnet by default. See [Environment Variables](#environment-variables) to switch to Mainnet.

---

## Contract API

### `initialize(collaborators: Vec<Address>, shares: Vec<u32>)`

Sets up the revenue split. Can only be called once. Subsequent calls will be rejected.

| Parameter       | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `collaborators` | List of recipient wallet addresses                           |
| `shares`        | Basis-point allocation per collaborator (must sum to 10,000) |

### `distribute(token: Address, amount: i128)`

Transfers `amount` of `token` from the contract address to all collaborators proportionally. Any rounding dust is assigned to the last collaborator — see [Rounding](#rounding).

### `record_secondary_sale(nft_id, previous_owner, new_owner, sale_price, sale_token)`

Records a secondary market resale and accumulates the royalty amount owed to collaborators.

### `distribute_secondary_royalties(token: Address)`

Distributes all pending secondary royalties accumulated via `record_secondary_sale`.

### `get_collaborators() → Vec<Address>`

Returns all registered collaborator addresses.

### `get_share(collaborator: Address) → u32`

Returns the basis-point share for a given collaborator address.

### `update_wasm(wasm_hash: BytesN<32>)`

Replaces the contract's executable WASM while preserving all instance storage (admin, collaborators, shares, balances, etc.). Requires admin authorization. The replacement Wasm must be uploaded to the network first via `stellar contract upload`; use the returned hash as `wasm_hash`.

---

## Usage Examples

### Initialize a 3-way split

```bash
# 50% artist / 30% musician / 20% animator
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- initialize \
  --collaborators '["GARTIST...","GMUSICIAN...","GANIMATOR..."]' \
  --shares '[5000,3000,2000]'
```

### Distribute primary sale proceeds

```bash
# Distribute 1,000 XLM from a sale (amounts in stroops: 1 XLM = 10,000,000 stroops)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source seller \
  --network testnet \
  -- distribute \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --amount 10000000000
```

### Check a collaborator's share

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source anyone \
  --network testnet \
  -- get_share \
  --collaborator GARTIST...
```

### Upgrade contract WASM (admin only)

```bash
# 1. Build and upload the new contract Wasm
cargo build --target wasm32-unknown-unknown --release
stellar contract upload \
  --source deployer \
  --wasm target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm \
  --network testnet
# → aa24c81289997ad815489b29db337b53f284cca5aba86e9a8ae5cef7d31842c2

# 2. Invoke update_wasm with the uploaded hash (admin must sign)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- update_wasm \
  --wasm_hash aa24c81289997ad815489b29db337b53f284cca5aba86e9a8ae5cef7d31842c2
```

### Record a secondary sale royalty

```bash
# Record a 5% royalty from a 500 XLM resale
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source marketplace \
  --network testnet \
  -- record_secondary_sale \
  --nft_id "NFT_001" \
  --previous_owner GBUYER1... \
  --new_owner GBUYER2... \
  --sale_price 5000000000 \
  --sale_token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

### Distribute accumulated secondary royalties

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source anyone \
  --network testnet \
  -- distribute_secondary_royalties \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

---

## Rounding

Payouts use integer division. Any rounding dust (typically 1–2 stroops) is assigned to the last collaborator in the list, ensuring the full distributed amount always equals the input — no funds are ever left in the contract.

---

## Frontend & Backend

A React frontend and Express backend are included for interacting with the contract via a UI.

```bash
# Backend
cd backend
cp .env.example .env   # fill in your keys
npm install
npm run dev            # → http://localhost:3001

# Frontend (separate terminal)
cd frontend
npm install
npm run dev            # → http://localhost:5173
```

The frontend proxies `/api/*` to the backend automatically via the Vite config.

The backend builds unsigned transaction XDR and returns it to the frontend. **Freighter signs and submits client-side — your private key never leaves the browser.**

---

### Backend shutdown

The backend handles `SIGTERM` and `SIGINT` gracefully. On shutdown it stops accepting new HTTP connections, lets in-flight API requests finish through Node's `server.close()` drain behavior, checkpoints and closes the SQLite database, logs each shutdown step, and then exits. No additional shutdown timeout is configured, so container or process managers should provide any external termination deadline they require.

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env`:

```bash
cp backend/.env.example backend/.env
```

| Variable            | Description                                                                             |
| ------------------- | --------------------------------------------------------------------------------------- |
| `PORT`              | Port the backend API listens on (default: `3001`)                                       |
| `STELLAR_NETWORK`   | `testnet` or `mainnet`                                                                  |
| `HORIZON_URL`       | Horizon REST endpoint for the chosen network                                            |
| `SOROBAN_RPC_URL`   | Soroban RPC endpoint for simulating and preparing transactions                          |
| `SERVER_SECRET_KEY` | Server-side keypair used for read-only simulations only — never signs user transactions |
| `SIGNING_KEY_FILE` | Optional secrets-manager file path; takes precedence over `SERVER_SECRET_KEY` on load |
| `ADMIN_ROTATE_TOKEN` | Bearer token for `POST /admin/rotate-key` hot-reload without redeploy (#293) |
| `REQUEST_SIGNATURE_MAX_AGE_MS` | Maximum accepted age for signed write requests (default: `300000`) |

Frontend write requests must be signed with a Stellar secret key that matches
the request `walletAddress`. For local development, set this in `frontend/.env`:

```bash
VITE_REQUEST_SIGNING_SECRET=SB...
```

The API client signs every POST request with `x-srs-public-key`,
`x-srs-signature`, `x-srs-timestamp`, and `x-srs-nonce`. The backend verifies
the Ed25519 signature over the canonical request payload, rejects stale
timestamps, and rejects replayed nonces with `401`.

---

## Project Structure

```
Stellar-Royalty-Splitter/
├── src/
│   └── lib.rs                        # Soroban smart contract (Rust)
├── tests/
│   └── integration_test.rs
├── scripts/
│   └── deploy.sh
├── Cargo.toml
├── frontend/                         # React + Vite UI
│   └── src/
│       ├── App.tsx
│       ├── api.ts                    # Backend API client
│       └── components/
│           ├── WalletConnect.tsx     # Freighter wallet connection
│           ├── InitializeForm.tsx    # Collaborator setup
│           ├── DistributeForm.tsx    # Trigger distribution
│           └── CollaboratorTable.tsx # View current splits
└── backend/                          # Express API
    └── src/
        ├── index.js
        ├── stellar.js                # Soroban RPC helpers
        └── routes/
            ├── initialize.js
            ├── distribute.js
            └── collaborators.js
```

---

## Roadmap

- [x] Primary sale distribution
- [x] Secondary market resale royalty hooks
- [x] Dashboard UI for earnings tracking
- [x] Admin authorization on `set_royalty_rate` and `distribute`
- [ ] Dynamic royalty adjustments via governance
- [ ] Role-based contributor management

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, branch naming conventions, and the PR checklist.

---

## License

[MIT](LICENSE)
