# Stellar Royalty Splitter

A Soroban smart contract on the Stellar network that automatically distributes NFT sale proceeds among multiple collaborators based on predefined percentage allocations.

---

## How it works

1. Deploy the contract
2. Call `initialize` with collaborator addresses and their shares (in basis points)
3. When a sale occurs, funds are sent to the contract address
4. Call `distribute` — funds split instantly, on-chain, with no intermediaries

Shares are expressed in **basis points** (1 bp = 0.01%). They must sum to **10,000** (100%).

---

## Project structure

```
├── src/lib.rs                        # Soroban contract (Rust)
├── tests/integration_test.rs
├── scripts/deploy.sh
├── Cargo.toml
├── frontend/                         # React + Vite UI
│   └── src/
│       ├── App.tsx
│       ├── api.ts                    # Backend client
│       └── components/
│           ├── WalletConnect.tsx     # Freighter wallet connect
│           ├── InitializeForm.tsx    # Set up collaborators
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

## Deploy to Testnet

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

---

## Contract API

### `initialize(collaborators: Vec<Address>, shares: Vec<u32>)`

Sets up the revenue split. Can only be called once.

- `collaborators` — list of recipient wallet addresses
- `shares` — basis-point allocation per collaborator (must sum to 10,000)

### `distribute(token: Address, amount: i128)`

Transfers `amount` of `token` from the contract to all collaborators proportionally.

### `get_collaborators() → Vec<Address>`

Returns all registered collaborator addresses.

### `get_share(collaborator: Address) → u32`

Returns the basis-point share for a given address.

---

## Usage Examples

### Example 1: Initialize a 3-way split

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

### Example 2: Distribute XLM proceeds

```bash
# Distribute 1000 XLM from a sale
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source seller \
  --network testnet \
  -- distribute \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --amount 10000000000
```

### Example 3: Check collaborator share

```bash
# Get share percentage for a collaborator
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source anyone \
  --network testnet \
  -- get_share \
  --collaborator GARTIST...
```

### Example 4: Record secondary sale royalty

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

### Example 5: Distribute accumulated secondary royalties

```bash
# Distribute all pending secondary royalties to collaborators
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source anyone \
  --network testnet \
  -- distribute_secondary_royalties \
  --token CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

---

## Rounding

Integer division is used for each collaborator's payout. Any rounding dust (1–2 stroops) is assigned to the last collaborator in the list to ensure the full amount is always distributed.

---

## Running the frontend & backend

```bash
# Backend
cd backend
cp .env.example .env   # fill in your keys
npm install
npm run dev            # http://localhost:3001

# Frontend (separate terminal)
cd frontend
npm install
npm run dev            # http://localhost:5173
```

The frontend proxies `/api/*` to the backend automatically via Vite config.

The backend builds unsigned transaction XDR and returns it to the frontend. Freighter signs and submits — your private key never leaves the browser.

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in the values:

| Variable           | Description                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `PORT`             | Port the backend API listens on (default: `3001`)                           |
| `STELLAR_NETWORK`  | `testnet` or `mainnet`                                                      |
| `HORIZON_URL`      | Horizon REST endpoint for the chosen network                                |
| `SOROBAN_RPC_URL`  | Soroban RPC endpoint used to simulate and prepare transactions              |
| `SERVER_SECRET_KEY`| Server-side keypair used only for read-only simulations — never signs user transactions |

See [`backend/.env.example`](backend/.env.example) for a ready-to-copy template.

---

## What's built

- ✅ Secondary market resale royalty hooks
- ✅ Dashboard UI for earnings tracking

## Roadmap

- [ ] Dynamic royalty adjustments via governance
- [ ] Role-based contributor management

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, branch naming conventions, and the PR checklist.

---

## License

MIT
