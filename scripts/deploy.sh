#!/usr/bin/env bash
# deploy.sh — Build and deploy the Stellar Royalty Splitter to a Stellar network
#
# Prerequisites:
#   - Rust + wasm32-unknown-unknown target  (rustup target add wasm32-unknown-unknown)
#   - Stellar CLI                           (cargo install --locked stellar-cli)
#   - A funded identity                     (stellar keys generate --global deployer)
#
# Environment variables (override defaults via shell or .env):
#   STELLAR_NETWORK   — target network: "testnet" (default) or "mainnet"
#   STELLAR_IDENTITY  — signing identity name (default: "deployer")
#
# Usage:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
#
# Testnet example:
#   STELLAR_NETWORK=testnet STELLAR_IDENTITY=deployer ./scripts/deploy.sh
#
# Mainnet example:
#   STELLAR_NETWORK=mainnet STELLAR_IDENTITY=my-mainnet-key ./scripts/deploy.sh

set -euo pipefail

# ── Network configuration ────────────────────────────────────────────────────
# Load from environment; fall back to safe testnet defaults.
NETWORK="${STELLAR_NETWORK:-testnet}"
IDENTITY="${STELLAR_IDENTITY:-deployer}"
CONTRACT_NAME="stellar_royalty_splitter"

# Validate network value
if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "❌ STELLAR_NETWORK must be 'testnet' or 'mainnet' (got: '$NETWORK')"
  exit 1
fi

echo "▶ Target network : $NETWORK"
echo "▶ Signing identity: $IDENTITY"

# ── Preflight checks ────────────────────────────────────────────────────────

command -v cargo >/dev/null 2>&1 || {
  echo "❌ cargo not found. Install Rust: https://rustup.rs"
  exit 1
}

command -v stellar >/dev/null 2>&1 || {
  echo "❌ stellar CLI not found. Run: cargo install --locked stellar-cli"
  exit 1
}

if ! stellar keys show "$IDENTITY" >/dev/null 2>&1; then
  echo "⚠️  Identity '$IDENTITY' not found."
  echo "   Run: stellar keys generate --global $IDENTITY --network $NETWORK"
  if [[ "$NETWORK" == "testnet" ]]; then
    echo "   Then fund it: https://friendbot.stellar.org/?addr=\$(stellar keys address $IDENTITY)"
  else
    echo "   Fund the mainnet address before deploying."
  fi
  exit 1
fi

# ── Build ───────────────────────────────────────────────────────────────────

echo "▶ Building contract (release)..."
cargo build --target wasm32-unknown-unknown --release

WASM_PATH="target/wasm32-unknown-unknown/release/${CONTRACT_NAME}.wasm"

echo "▶ Optimising wasm..."
stellar contract optimize --wasm "$WASM_PATH"

OPTIMISED_WASM="target/wasm32-unknown-unknown/release/${CONTRACT_NAME}.optimized.wasm"

# ── Deploy ──────────────────────────────────────────────────────────────────

echo "▶ Deploying to $NETWORK..."
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$OPTIMISED_WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK")

echo ""
echo "✅ Contract deployed!"
echo "   Contract ID : $CONTRACT_ID"
echo "   Network     : $NETWORK"

# Persist contract ID so it isn't lost if the terminal is closed
echo "$CONTRACT_ID" > .contract-id
echo "   Saved to    : .contract-id"

# Write contract ID to backend/.env for the API server (#296)
ENV_FILE="backend/.env"
ENV_EXAMPLE="backend/.env.example"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo "   Created     : $ENV_FILE (from .env.example)"
  else
    touch "$ENV_FILE"
    echo "   Created     : $ENV_FILE"
  fi
fi

if grep -q '^ROYALTY_CONTRACT_ID=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^ROYALTY_CONTRACT_ID=.*|ROYALTY_CONTRACT_ID=$CONTRACT_ID|" "$ENV_FILE"
else
  echo "ROYALTY_CONTRACT_ID=$CONTRACT_ID" >> "$ENV_FILE"
fi

if grep -q '^STELLAR_NETWORK=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^STELLAR_NETWORK=.*|STELLAR_NETWORK=$NETWORK|" "$ENV_FILE"
else
  echo "STELLAR_NETWORK=$NETWORK" >> "$ENV_FILE"
fi

echo "   Updated     : $ENV_FILE (ROYALTY_CONTRACT_ID, STELLAR_NETWORK)"

echo ""
echo "Next — initialize the contract:"
echo ""
echo "  NOTE: The first collaborator address is the admin and MUST be the --source"
echo "  (or co-sign) so that require_auth() passes. Any other caller will be rejected."
echo ""
echo "  stellar contract invoke \\"
echo "    --id $CONTRACT_ID \\"
echo "    --source $IDENTITY \\"
echo "    --network $NETWORK \\"
echo "    -- initialize \\"
echo "    --collaborators '[\"<ADDR_1>\",\"<ADDR_2>\",\"<ADDR_3>\"]' \\"
echo "    --shares '[5000,3000,2000]'"
