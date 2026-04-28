#!/usr/bin/env bash
# deploy.sh — Build and deploy the Stellar Royalty Splitter to Stellar Testnet
#
# Prerequisites:
#   - Rust + wasm32-unknown-unknown target  (rustup target add wasm32-unknown-unknown)
#   - Stellar CLI                           (cargo install --locked stellar-cli)
#   - A funded testnet identity             (stellar keys generate --global deployer)
#
# Usage:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh

set -euo pipefail

NETWORK="testnet"
IDENTITY="deployer"
CONTRACT_NAME="stellar_royalty_splitter"

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
  echo "   Then fund it: https://friendbot.stellar.org/?addr=\$(stellar keys address $IDENTITY)"
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
