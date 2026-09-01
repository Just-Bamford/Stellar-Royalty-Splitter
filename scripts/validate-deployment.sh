#!/usr/bin/env bash
# validate-deployment.sh — Pre- and post-deployment validation for the
# Stellar Royalty Splitter contract.
#
# Usage:
#   ./scripts/validate-deployment.sh pre                 # build + WASM checks
#   ./scripts/validate-deployment.sh post <CONTRACT_ID>   # on-chain state checks
#
# Environment variables (same as scripts/deploy.sh):
#   STELLAR_NETWORK   — target network: "testnet" (default) or "mainnet"
#   STELLAR_IDENTITY  — signing identity name (default: "deployer")
#
# See DEPLOYMENT.md for the full checklist and rollback procedure.

set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
IDENTITY="${STELLAR_IDENTITY:-deployer}"
CONTRACT_NAME="stellar_royalty_splitter"
WASM_PATH="target/wasm32-unknown-unknown/release/${CONTRACT_NAME}.wasm"
OPTIMISED_WASM="target/wasm32-unknown-unknown/release/${CONTRACT_NAME}.optimized.wasm"

PASS=0
FAIL=0

ok() {
  echo "[✓] $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "[✗] $1"
  FAIL=$((FAIL + 1))
}

summarize() {
  echo ""
  echo "── Summary ──────────────────────────────────────────────"
  echo "Passed: $PASS   Failed: $FAIL"
  if [[ "$FAIL" -gt 0 ]]; then
    echo "Validation FAILED — do not proceed with deployment."
    exit 1
  fi
  echo "Validation PASSED."
}

run_pre_checks() {
  echo "▶ Running PRE-deployment validation (network: $NETWORK, identity: $IDENTITY)"
  echo ""

  # ── Toolchain ──────────────────────────────────────────────────────────
  if command -v cargo >/dev/null 2>&1; then
    ok "cargo is installed ($(cargo --version))"
  else
    fail "cargo not found — install Rust: https://rustup.rs"
  fi

  if rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
    ok "wasm32-unknown-unknown target is installed"
  else
    fail "wasm32-unknown-unknown target missing — run: rustup target add wasm32-unknown-unknown"
  fi

  if command -v stellar >/dev/null 2>&1; then
    ok "stellar CLI is installed ($(stellar --version 2>&1 | head -n1))"
  else
    fail "stellar CLI not found — run: cargo install --locked stellar-cli"
  fi

  # ── Identity / permissions ────────────────────────────────────────────
  if stellar keys show "$IDENTITY" >/dev/null 2>&1; then
    ok "signing identity '$IDENTITY' exists"
  else
    fail "signing identity '$IDENTITY' not found — run: stellar keys generate --global $IDENTITY --network $NETWORK"
  fi

  local address=""
  if address=$(stellar keys address "$IDENTITY" 2>/dev/null); then
    ok "resolved address for '$IDENTITY': $address"

    if stellar_balance_output=$(stellar contract invoke \
        --id "$address" --source "$IDENTITY" --network "$NETWORK" \
        -- --help >/dev/null 2>&1); then
      : # not a meaningful check by itself, balance check happens below
    fi

    if balance=$(curl -sf "https://horizon-${NETWORK}.stellar.org/accounts/${address}" 2>/dev/null); then
      if echo "$balance" | grep -q '"balance"'; then
        ok "identity '$IDENTITY' is funded on $NETWORK"
      else
        fail "could not confirm a funded balance for '$IDENTITY' on $NETWORK"
      fi
    else
      fail "could not reach Horizon ($NETWORK) to verify account balance — check network connectivity"
    fi
  else
    fail "could not resolve an address for identity '$IDENTITY'"
  fi

  # ── Build ──────────────────────────────────────────────────────────────
  echo ""
  echo "▶ Building contract (release)..."
  if cargo build --target wasm32-unknown-unknown --release; then
    ok "cargo build succeeded"
  else
    fail "cargo build failed"
    summarize
  fi

  if [[ -f "$WASM_PATH" ]]; then
    ok "WASM artifact exists at $WASM_PATH"
  else
    fail "WASM artifact not found at $WASM_PATH"
    summarize
  fi

  echo "▶ Optimising WASM..."
  if stellar contract optimize --wasm "$WASM_PATH"; then
    ok "stellar contract optimize succeeded"
  else
    fail "stellar contract optimize failed"
  fi

  if [[ -f "$OPTIMISED_WASM" ]]; then
    ok "optimised WASM artifact exists at $OPTIMISED_WASM"
  else
    fail "optimised WASM artifact not found at $OPTIMISED_WASM"
  fi

  # ── Simulated upload (dry run) ──────────────────────────────────────────
  echo "▶ Simulating contract upload (dry run, no state change)..."
  if stellar contract upload \
      --wasm "$OPTIMISED_WASM" \
      --source "$IDENTITY" \
      --network "$NETWORK" \
      --sim-only >/dev/null 2>&1; then
    ok "simulated upload succeeded (WASM is uploadable, no funds spent)"
  else
    fail "simulated upload failed — check identity permissions and balance"
  fi

  summarize
}

run_post_checks() {
  local contract_id="${1:-}"
  if [[ -z "$contract_id" ]]; then
    echo "Usage: $0 post <CONTRACT_ID>"
    exit 1
  fi

  echo "▶ Running POST-deployment validation for contract $contract_id (network: $NETWORK)"
  echo ""

  local initialized=""
  if initialized=$(stellar contract invoke \
      --id "$contract_id" --source "$IDENTITY" --network "$NETWORK" \
      -- is_initialized 2>/dev/null); then
    if [[ "$initialized" == "true" ]]; then
      ok "contract reports is_initialized() = true"
    else
      fail "contract reports is_initialized() = false — initialize() may not have run"
    fi
  else
    fail "is_initialized() call failed — contract may not be deployed or reachable"
  fi

  local admin=""
  if admin=$(stellar contract invoke \
      --id "$contract_id" --source "$IDENTITY" --network "$NETWORK" \
      -- get_admin 2>/dev/null); then
    ok "contract reports get_admin() = $admin"
  else
    fail "get_admin() call failed"
  fi

  echo ""
  echo "Manually confirm before declaring the deployment complete:"
  echo "  - get_admin() above matches the expected collaborator address"
  echo "  - collaborators/shares match what was intended (see DEPLOYMENT.md checklist)"
  echo "  - backend/.env ROYALTY_CONTRACT_ID and STELLAR_NETWORK match this deployment"

  summarize
}

case "${1:-}" in
  pre)
    run_pre_checks
    ;;
  post)
    run_post_checks "${2:-}"
    ;;
  *)
    echo "Usage: $0 <pre|post> [CONTRACT_ID]"
    echo "  pre                 — run build/WASM/identity validation before deploying"
    echo "  post <CONTRACT_ID>  — verify on-chain state after deploying"
    exit 1
    ;;
esac
