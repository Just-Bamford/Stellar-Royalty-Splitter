#!/bin/bash
# Environment validation for local development (#668).
#
# Checks that required tooling (Rust/Soroban, Node.js/npm) and required
# environment configuration are present before development or a build/test
# run starts, so contributors get one clear report instead of a late,
# confusing failure mid-build.
#
# Usage:
#   ./scripts/validate-env.sh
#
# Exits non-zero if any required check fails.
#
# IMPORTANT: never print the value of an environment variable, only
# whether it is present/valid. This script must not leak secrets.

set -u

FAILURES=0
WARNINGS=0

MIN_NODE_MAJOR=20
REQUIRED_WASM_TARGET="wasm32-unknown-unknown"

# Required keys per env file. Only presence/non-emptiness is checked —
# values are never printed.
BACKEND_ENV_FILE="backend/.env"
BACKEND_ENV_EXAMPLE="backend/.env.example"
REQUIRED_BACKEND_VARS=(
  PORT
  DATABASE_PATH
  STELLAR_NETWORK
  STELLAR_IDENTITY
  SOROBAN_RPC_URL
  HORIZON_URL
  FRONTEND_ORIGIN
)

FRONTEND_ENV_FILE="frontend/.env"
FRONTEND_ENV_EXAMPLE="frontend/.env.example"
REQUIRED_FRONTEND_VARS=(
  VITE_STELLAR_NETWORK
)

pass() { echo "  [OK]   $1"; }
fail() { echo "  [FAIL] $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo "  [WARN] $1"; WARNINGS=$((WARNINGS + 1)); }

section() {
  echo ""
  echo "== $1 =="
}

# --- Rust / Soroban tooling ------------------------------------------------

section "Rust & Soroban tooling"

if command -v rustc >/dev/null 2>&1; then
  pass "rustc found ($(rustc --version))"
else
  fail "rustc not found. Install from https://rustup.rs"
fi

if command -v cargo >/dev/null 2>&1; then
  pass "cargo found ($(cargo --version))"
else
  fail "cargo not found. Install from https://rustup.rs"
fi

if command -v rustup >/dev/null 2>&1; then
  if rustup target list --installed 2>/dev/null | grep -qx "$REQUIRED_WASM_TARGET"; then
    pass "rustup target '$REQUIRED_WASM_TARGET' installed"
  else
    fail "rustup target '$REQUIRED_WASM_TARGET' not installed. Run: rustup target add $REQUIRED_WASM_TARGET"
  fi
else
  warn "rustup not found; cannot verify the '$REQUIRED_WASM_TARGET' target is installed"
fi

if command -v stellar >/dev/null 2>&1; then
  pass "stellar CLI found ($(stellar --version 2>&1 | head -n1))"
elif command -v soroban >/dev/null 2>&1; then
  pass "soroban CLI found ($(soroban --version 2>&1 | head -n1))"
else
  fail "Stellar CLI not found. Install from https://developers.stellar.org/docs/build/smart-contracts#using-stellar-cli"
fi

# --- Node.js / package manager ---------------------------------------------

section "Node.js & package manager"

if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node --version) # e.g. v20.11.0
  NODE_MAJOR=$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')
  if [ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    pass "node found ($NODE_VERSION)"
  else
    fail "node $NODE_VERSION is below the required v${MIN_NODE_MAJOR}.x. Install Node ${MIN_NODE_MAJOR} LTS."
  fi
else
  fail "node not found. Install Node ${MIN_NODE_MAJOR} LTS from https://nodejs.org"
fi

if command -v npm >/dev/null 2>&1; then
  pass "npm found ($(npm --version))"
else
  fail "npm not found. It ships with Node.js — reinstall Node ${MIN_NODE_MAJOR} LTS."
fi

# --- Environment variables --------------------------------------------------

check_env_file() {
  local label="$1"
  local env_file="$2"
  local example_file="$3"
  shift 3
  local required_vars=("$@")

  if [ ! -f "$env_file" ]; then
    fail "$label: $env_file not found. Run: cp $example_file $env_file"
    return
  fi
  pass "$label: $env_file present"

  local missing=()
  for var in "${required_vars[@]}"; do
    # Match KEY=value with a non-empty value, ignoring commented-out lines.
    if ! grep -qE "^${var}=.+" "$env_file"; then
      missing+=("$var")
    fi
  done

  if [ ${#missing[@]} -eq 0 ]; then
    pass "$label: all required variables are set (${#required_vars[@]} checked)"
  else
    fail "$label: missing or empty required variable(s): ${missing[*]} (see $example_file)"
  fi
}

section "Environment variables"

check_env_file "Backend" "$BACKEND_ENV_FILE" "$BACKEND_ENV_EXAMPLE" "${REQUIRED_BACKEND_VARS[@]}"
check_env_file "Frontend" "$FRONTEND_ENV_FILE" "$FRONTEND_ENV_EXAMPLE" "${REQUIRED_FRONTEND_VARS[@]}"

# --- Summary ----------------------------------------------------------------

section "Summary"

if [ "$FAILURES" -eq 0 ]; then
  echo "  All required checks passed. ($WARNINGS warning(s))"
  exit 0
else
  echo "  $FAILURES required check(s) failed, $WARNINGS warning(s)."
  echo "  Fix the [FAIL] items above before running the app or its build/test suites."
  exit 1
fi
