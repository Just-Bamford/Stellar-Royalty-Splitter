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

```bash
cargo test
```

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
