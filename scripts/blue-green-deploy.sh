#!/bin/bash
# Blue-green deployment for the Stellar Royalty Splitter (#872).
#
# Soroban contracts are immutable once deployed and there is no in-place
# revert (see DEPLOYMENT.md § Rollback Procedure). That property is what
# makes blue-green natural here rather than bolted on:
#
#   BLUE  — the contract ROYALTY_CONTRACT_ID currently points at; serving.
#   GREEN — the newly deployed candidate contract; not yet serving.
#
# Both exist on-chain simultaneously. "Switching traffic" means repointing
# the backend's ROYALTY_CONTRACT_ID at green; "rolling back" means pointing
# it back at blue, which never stopped existing. Nothing is destroyed on
# cutover, so the rollback window costs only configuration.
#
# Usage:
#   ./scripts/blue-green-deploy.sh deploy      # deploy green, validate, cut over
#   ./scripts/blue-green-deploy.sh rollback    # restore the previous contract
#   ./scripts/blue-green-deploy.sh status      # show blue/green state
#
# Environment:
#   STELLAR_NETWORK   testnet | mainnet      (default: testnet)
#   STELLAR_IDENTITY  stellar keys identity  (default: deployer)
#   HEALTH_URL        backend health endpoint to poll
#                     (default: http://localhost:3001/api/v1/health)
#   READINESS_TIMEOUT seconds to wait for readiness   (default: 120)
#   ROLLBACK_WINDOW   seconds to monitor after cutover (default: 300)
#
# IMPORTANT: never prints a secret. Contract IDs and network names are public.

set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
IDENTITY="${STELLAR_IDENTITY:-deployer}"
HEALTH_URL="${HEALTH_URL:-http://localhost:3001/api/v1/health}"
READINESS_TIMEOUT="${READINESS_TIMEOUT:-120}"
ROLLBACK_WINDOW="${ROLLBACK_WINDOW:-300}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="${REPO_ROOT}/.deploy-state"
BACKEND_ENV="${REPO_ROOT}/backend/.env"

ok()     { echo "  [✓] $1"; }
fail()   { echo "  [✗] $1" >&2; }
info()   { echo "▶ $1"; }
notice() { echo ""; echo "== $1 =="; }

# --- State -----------------------------------------------------------------
# .deploy-state records which contract is live and which one it replaced, so
# a rollback does not depend on someone remembering the previous address.
# It is gitignored: it is per-deployment-host state, not source.

read_state() {
  local key="$1"
  [[ -f "$STATE_FILE" ]] || return 1
  grep -E "^${key}=" "$STATE_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || return 1
}

write_state() {
  local blue="$1" green="$2"
  cat > "$STATE_FILE" <<EOF
# Blue-green deployment state — written by scripts/blue-green-deploy.sh
# BLUE  = contract currently serving traffic
# GREEN = previous contract, retained for the rollback window
BLUE=${blue}
GREEN=${green}
NETWORK=${NETWORK}
EOF
}

current_contract() {
  # Prefer explicit env, fall back to backend/.env, then .contract-id.
  if [[ -n "${ROYALTY_CONTRACT_ID:-}" ]]; then
    echo "$ROYALTY_CONTRACT_ID"
  elif [[ -f "$BACKEND_ENV" ]] && grep -qE '^ROYALTY_CONTRACT_ID=' "$BACKEND_ENV"; then
    grep -E '^ROYALTY_CONTRACT_ID=' "$BACKEND_ENV" | tail -n1 | cut -d= -f2-
  elif [[ -f "${REPO_ROOT}/.contract-id" ]]; then
    cat "${REPO_ROOT}/.contract-id"
  else
    echo ""
  fi
}

point_backend_at() {
  local contract_id="$1"
  if [[ ! -f "$BACKEND_ENV" ]]; then
    fail "backend/.env not found — cannot repoint traffic"
    return 1
  fi
  if grep -qE '^ROYALTY_CONTRACT_ID=' "$BACKEND_ENV"; then
    # BSD/GNU-portable in-place edit.
    sed -i.bak -E "s|^ROYALTY_CONTRACT_ID=.*|ROYALTY_CONTRACT_ID=${contract_id}|" "$BACKEND_ENV"
    rm -f "${BACKEND_ENV}.bak"
  else
    echo "ROYALTY_CONTRACT_ID=${contract_id}" >> "$BACKEND_ENV"
  fi
  ok "backend now points at ${contract_id}"
}

# --- Health ----------------------------------------------------------------

wait_for_readiness() {
  local deadline=$(( SECONDS + READINESS_TIMEOUT ))
  info "Waiting for backend readiness (timeout ${READINESS_TIMEOUT}s)"
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      ok "backend is responding"
      return 0
    fi
    sleep 3
  done
  fail "backend did not become ready within ${READINESS_TIMEOUT}s"
  return 1
}

check_health() {
  # /api/v1/health/detailed returns 503 when any critical component is
  # unhealthy, so the HTTP status alone is a sufficient gate.
  local url="${HEALTH_URL%/}/detailed"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo "000")
  if [[ "$status" == "200" ]]; then
    ok "health check passed (200)"
    return 0
  fi
  fail "health check returned HTTP ${status}"
  return 1
}

check_dependencies() {
  # The candidate is only healthy if its critical external dependencies are
  # reachable too — a green contract behind a dead RPC endpoint is not a
  # successful deploy.
  local failures=0
  for url in "${SOROBAN_RPC_URL:-}" "${HORIZON_URL:-}"; do
    [[ -z "$url" ]] && continue
    if curl -fsS --max-time 10 "$url" >/dev/null 2>&1; then
      ok "dependency reachable: ${url}"
    else
      fail "dependency unreachable: ${url}"
      failures=$(( failures + 1 ))
    fi
  done
  return $(( failures > 0 ))
}

smoke_test() {
  local contract_id="$1"
  info "Running smoke tests against ${contract_id}"
  # Reuses the existing post-deployment validation rather than duplicating
  # on-chain assertions here.
  if STELLAR_NETWORK="$NETWORK" STELLAR_IDENTITY="$IDENTITY" \
     "${REPO_ROOT}/scripts/validate-deployment.sh" post "$contract_id"; then
    ok "post-deployment validation passed"
    return 0
  fi
  fail "post-deployment validation failed"
  return 1
}

# --- Commands --------------------------------------------------------------

cmd_status() {
  notice "Blue-green status"
  local blue green
  blue="$(read_state BLUE || true)"
  green="$(read_state GREEN || true)"
  echo "  Network:           ${NETWORK}"
  echo "  Serving (blue):    ${blue:-<unknown>}"
  echo "  Previous (green):  ${green:-<none>}"
  echo "  backend/.env:      $(current_contract || echo '<unset>')"
  echo "  Health URL:        ${HEALTH_URL}"
}

cmd_deploy() {
  notice "Blue-green deploy (network: ${NETWORK})"

  local blue
  blue="$(current_contract)"
  if [[ -z "$blue" ]]; then
    info "No current contract found — this is an initial deploy, not a cutover"
  else
    ok "current (blue) contract: ${blue}"
  fi

  # 1. Pre-flight.
  notice "1/6 Pre-deployment validation"
  STELLAR_NETWORK="$NETWORK" STELLAR_IDENTITY="$IDENTITY" \
    "${REPO_ROOT}/scripts/validate-deployment.sh" pre

  # 2. Deploy the candidate. deploy.sh writes .contract-id and backend/.env,
  #    so capture the previous value first and restore it until cutover.
  notice "2/6 Deploying green (candidate)"
  STELLAR_NETWORK="$NETWORK" STELLAR_IDENTITY="$IDENTITY" \
    "${REPO_ROOT}/scripts/deploy.sh"

  local green
  green="$(cat "${REPO_ROOT}/.contract-id")"
  if [[ -z "$green" ]]; then
    fail "deploy.sh did not produce a contract id"
    exit 1
  fi
  ok "green contract deployed: ${green}"

  # Keep serving blue until the candidate has proven itself.
  if [[ -n "$blue" ]]; then
    point_backend_at "$blue"
    info "traffic still on blue while green is validated"
  fi

  # 3. Readiness.
  notice "3/6 Readiness"
  wait_for_readiness || { fail "aborting before cutover"; exit 1; }

  # 4. Validate the candidate.
  notice "4/6 Candidate validation"
  local validation_failed=0
  smoke_test "$green"      || validation_failed=1
  check_dependencies       || validation_failed=1

  if (( validation_failed )); then
    fail "green failed validation — traffic was never switched"
    info "blue (${blue:-none}) is still serving; green (${green}) is inert"
    exit 1
  fi

  # 5. Cut over.
  notice "5/6 Cutover"
  point_backend_at "$green"
  write_state "$green" "${blue:-}"
  info "restart the backend to pick up the new contract id"

  # 6. Post-cutover monitoring, with automatic rollback on failure.
  notice "6/6 Post-cutover monitoring (${ROLLBACK_WINDOW}s)"
  if ! wait_for_readiness; then
    fail "backend did not come back after cutover — rolling back"
    cmd_rollback
    exit 1
  fi

  local deadline=$(( SECONDS + ROLLBACK_WINDOW ))
  while (( SECONDS < deadline )); do
    if ! check_health; then
      fail "post-cutover health check failed — rolling back"
      cmd_rollback
      exit 1
    fi
    sleep 15
  done

  ok "green healthy for ${ROLLBACK_WINDOW}s — deployment complete"
  info "blue (${blue:-none}) remains on-chain and can still be restored"
}

cmd_rollback() {
  notice "Rollback"
  local previous
  previous="$(read_state GREEN || true)"

  if [[ -z "$previous" ]]; then
    fail "no previous contract recorded in ${STATE_FILE}"
    fail "restore ROYALTY_CONTRACT_ID manually — see DEPLOYMENT.md § Emergency manual rollback"
    return 1
  fi

  point_backend_at "$previous"
  local failed_contract
  failed_contract="$(read_state BLUE || true)"
  write_state "$previous" ""

  ok "traffic restored to ${previous}"
  info "restart the backend to complete the rollback"
  info "failed contract ${failed_contract:-<unknown>} remains on-chain and inert"
  echo ""
  echo "Record the incident: contract id, network, timestamp, root cause."
  echo "See DEPLOYMENT.md § Rollback Procedure step 5."
}

case "${1:-}" in
  deploy)   cmd_deploy ;;
  rollback) cmd_rollback ;;
  status)   cmd_status ;;
  *)
    echo "Usage: $0 <deploy|rollback|status>"
    echo "  deploy    — deploy green, validate, cut over, monitor, auto-rollback on failure"
    echo "  rollback  — restore the previously serving contract"
    echo "  status    — show current blue/green state"
    exit 1
    ;;
esac
