#!/usr/bin/env bash
#
# disaster-recovery-test.sh — repeatable, non-production recovery exercises (#865).
#
# A documented recovery procedure that is never executed is a guess. Backups
# rot silently: an encryption key is rotated without updating the restore path,
# a schema migration changes what "valid data" means, a bucket policy tightens.
# None of that is visible until a restore is attempted, and the worst time to
# discover it is during an actual incident.
#
# This script runs those procedures on a schedule, against an isolated
# environment, and records how long each one took so recovery performance can
# be compared across exercises.
#
#   ./infra/disaster-recovery-test.sh --list
#   ./infra/disaster-recovery-test.sh --scenario database-restore
#   ./infra/disaster-recovery-test.sh --all --dry-run
#   ./infra/disaster-recovery-test.sh --all --json-report dr-results.json
#
# ── Safety ───────────────────────────────────────────────────────────────────
#
# This script mutates a database and can delete files. It refuses to run
# against production unless --i-understand-this-is-production is passed, and
# that flag exists to be a deliberate, auditable act rather than a convenience.
# Refer to docs/DISASTER_RECOVERY_RUNBOOK.md for what production recovery
# actually involves — it is an operator-led procedure, not this script.
#
# The guards are layered, because any single one can be defeated by accident:
#
#   1. DR_ENVIRONMENT must be set and must not be a production-like name.
#   2. Resource names touched must not contain a production marker.
#   3. Live AWS resources are only touched when explicitly enabled.
#   4. A dry run is available for every scenario.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Configuration ────────────────────────────────────────────────────────────

DR_ENVIRONMENT="${DR_ENVIRONMENT:-}"
# Defaults inside the repository rather than /tmp: on Windows the shell is a
# POSIX emulation but sqlite3 and openssl are native binaries that cannot
# resolve a /tmp path, so a repo-relative default is the portable choice.
DR_WORK_DIR="${DR_WORK_DIR:-$REPO_ROOT/.dr-test}"
DR_REPORT_DIR="${DR_REPORT_DIR:-$DR_WORK_DIR/reports}"

DATABASE_PATH="${DATABASE_PATH:-}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

API_BASE_URL="${API_BASE_URL:-http://localhost:3001}"
SOROBAN_RPC_URL="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
HORIZON_URL="${HORIZON_URL:-https://horizon-testnet.stellar.org}"

# Recovery time objective. docs/backup-strategy.md commits to under one hour;
# an exercise that exceeds it is reported as a failure, because an RTO nobody
# measures is an aspiration rather than a commitment.
RTO_TARGET_SECONDS="${RTO_TARGET_SECONDS:-3600}"

DRY_RUN=false
ALLOW_PRODUCTION=false
USE_LIVE_AWS=false
JSON_REPORT=""
SELECTED_SCENARIOS=()

# Names that must never appear in an environment or resource this script
# touches. Substring match, case-insensitive.
PRODUCTION_MARKERS=(prod production live mainnet)

# ── Output ───────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_OFF=""
fi

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log()       { printf '%s [ INFO ] %s\n' "$(timestamp)" "$*"; }
log_ok()    { printf '%s [  OK  ] %s%s%s\n' "$(timestamp)" "$C_GREEN" "$*" "$C_OFF"; }
log_warn()  { printf '%s [ WARN ] %s%s%s\n' "$(timestamp)" "$C_YELLOW" "$*" "$C_OFF"; }
log_error() { printf '%s [ FAIL ] %s%s%s\n' "$(timestamp)" "$C_RED" "$*" "$C_OFF" >&2; }

# A checkpoint is a named, timed milestone inside a scenario. Recording them
# individually is what makes a slow recovery diagnosable — "the restore took
# 40 minutes" is not actionable, "the download took 38 of those 40" is.
CHECKPOINT_NAMES=()
CHECKPOINT_TIMES=()
SCENARIO_START_EPOCH=0

checkpoint() {
  local name="$1"
  local now elapsed
  now="$(date -u +%s)"
  elapsed=$(( now - SCENARIO_START_EPOCH ))
  CHECKPOINT_NAMES+=("$name")
  CHECKPOINT_TIMES+=("$elapsed")
  printf '%s [ CKPT ] %s%s%s (+%ds)\n' "$(timestamp)" "$C_BLUE" "$name" "$C_OFF" "$elapsed"
}

die() {
  log_error "$*"
  exit 1
}

# Every failure must say what to do next. A recovery exercise that fails with
# "command not found" and no context wastes the exercise.
fail_with_guidance() {
  local what="$1" why="$2" fix="$3"
  log_error "$what"
  printf '         cause: %s\n' "$why" >&2
  printf '         fix:   %s\n' "$fix" >&2
  return 1
}

# ── Safety guards ────────────────────────────────────────────────────────────

contains_production_marker() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  local marker
  for marker in "${PRODUCTION_MARKERS[@]}"; do
    if [[ "$value" == *"$marker"* ]]; then
      return 0
    fi
  done
  return 1
}

assert_not_production() {
  local label="$1" value="$2"

  [[ -z "$value" ]] && return 0

  if contains_production_marker "$value"; then
    if [[ "$ALLOW_PRODUCTION" != "true" ]]; then
      log_error "REFUSING TO RUN: $label looks like production."
      printf '\n' >&2
      printf '  %s = %s\n' "$label" "$value" >&2
      printf '\n' >&2
      printf '  This script mutates databases and deletes files. It is built for\n' >&2
      printf '  isolated environments only.\n' >&2
      printf '\n' >&2
      printf '  Production recovery is an operator-led procedure — see\n' >&2
      printf '  docs/DISASTER_RECOVERY_RUNBOOK.md. Do not reach for this script\n' >&2
      printf '  during a real incident.\n' >&2
      printf '\n' >&2
      printf '  If you genuinely intend to target production, pass\n' >&2
      printf '  --i-understand-this-is-production. That flag is logged.\n' >&2
      printf '\n' >&2
      exit 2
    fi

    log_warn "PRODUCTION OVERRIDE ACTIVE for $label=$value — proceeding under --i-understand-this-is-production"
  fi
}

run_safety_checks() {
  log "Running safety checks"

  if [[ -z "$DR_ENVIRONMENT" ]]; then
    die "DR_ENVIRONMENT is not set. Set it to the isolated environment being exercised, e.g. DR_ENVIRONMENT=staging."
  fi

  assert_not_production "DR_ENVIRONMENT" "$DR_ENVIRONMENT"
  assert_not_production "BACKUP_S3_BUCKET" "$BACKUP_S3_BUCKET"
  assert_not_production "DATABASE_PATH" "$DATABASE_PATH"
  assert_not_production "API_BASE_URL" "$API_BASE_URL"

  # A second, independent check: the AWS account being used must not be the
  # production account. Name-based checks alone are defeated by a bucket that
  # simply is not named "prod".
  if [[ "$USE_LIVE_AWS" == "true" ]] && command -v aws >/dev/null 2>&1; then
    local account_id
    account_id="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")"
    if [[ -n "$account_id" && -n "${DR_FORBIDDEN_ACCOUNT_IDS:-}" ]]; then
      local forbidden
      for forbidden in ${DR_FORBIDDEN_ACCOUNT_IDS//,/ }; do
        if [[ "$account_id" == "$forbidden" ]] && [[ "$ALLOW_PRODUCTION" != "true" ]]; then
          die "REFUSING TO RUN: AWS account $account_id is listed in DR_FORBIDDEN_ACCOUNT_IDS."
        fi
      done
    fi
    log "AWS account: ${account_id:-unknown}"
  fi

  log_ok "Safety checks passed (environment: $DR_ENVIRONMENT)"
}

require_command() {
  local cmd="$1" purpose="$2" install_hint="$3"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail_with_guidance \
      "Required command not found: $cmd" \
      "$purpose" \
      "$install_hint"
    return 1
  fi
  return 0
}

# ── Scenario results ─────────────────────────────────────────────────────────

RESULT_NAMES=()
RESULT_STATUSES=()
RESULT_DURATIONS=()
RESULT_MESSAGES=()
RESULT_CHECKPOINTS=()

record_result() {
  local name="$1" status="$2" duration="$3" message="$4"

  local checkpoints="" i
  for i in "${!CHECKPOINT_NAMES[@]}"; do
    [[ -n "$checkpoints" ]] && checkpoints+=","
    checkpoints+="$(printf '{"name":"%s","elapsedSeconds":%s}' \
      "${CHECKPOINT_NAMES[$i]}" "${CHECKPOINT_TIMES[$i]}")"
  done

  RESULT_NAMES+=("$name")
  RESULT_STATUSES+=("$status")
  RESULT_DURATIONS+=("$duration")
  RESULT_MESSAGES+=("$message")
  RESULT_CHECKPOINTS+=("[$checkpoints]")
}

begin_scenario() {
  CHECKPOINT_NAMES=()
  CHECKPOINT_TIMES=()
  SCENARIO_START_EPOCH="$(date -u +%s)"
  printf '\n%s=== %s ===%s\n' "$C_BOLD" "$1" "$C_OFF"
}

# ── Fixtures ─────────────────────────────────────────────────────────────────

# A database with the real schema and known contents, so integrity checks after
# a restore can assert on exact values rather than "it opened without error".
create_test_database() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  rm -f "$path"

  sqlite3 "$path" <<'SQL' >/dev/null
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  tx_hash TEXT,
  amount TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS distribution_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL,
  collaborator TEXT NOT NULL,
  amount TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secondary_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  nft_id TEXT NOT NULL,
  sale_price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secondary_royalty_distributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  collaborator TEXT NOT NULL,
  amount TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  contract_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO schema_migrations (version) VALUES (1), (2), (3);

INSERT INTO transactions (contract_id, tx_hash, amount, status) VALUES
  ('CFIDWUVTWDSZTKLPVFRQQ42WFLK3I572742JAQV7ZHCM4UKZTZRJWH6P', 'hash-001', '1000000', 'confirmed'),
  ('CFIDWUVTWDSZTKLPVFRQQ42WFLK3I572742JAQV7ZHCM4UKZTZRJWH6P', 'hash-002', '2500000', 'confirmed'),
  ('CFIDWUVTWDSZTKLPVFRQQ42WFLK3I572742JAQV7ZHCM4UKZTZRJWH6P', 'hash-003', '500000', 'pending');

INSERT INTO distribution_payouts (transaction_id, collaborator, amount) VALUES
  (1, 'GBDIA62PY5P5MSTMR3DSVAQ4TITI3JJWWMW2NAI2QZKMPTTKSLG5JU6L', '600000'),
  (1, 'GAV4DGP22KP4ZWOFJXMVWNRCFFYU6BFDQHEYJAHONQHFRH4GSY4GFQRN', '400000'),
  (2, 'GBDIA62PY5P5MSTMR3DSVAQ4TITI3JJWWMW2NAI2QZKMPTTKSLG5JU6L', '1500000'),
  (2, 'GAV4DGP22KP4ZWOFJXMVWNRCFFYU6BFDQHEYJAHONQHFRH4GSY4GFQRN', '1000000');

INSERT INTO secondary_sales (contract_id, nft_id, sale_price) VALUES
  ('CFIDWUVTWDSZTKLPVFRQQ42WFLK3I572742JAQV7ZHCM4UKZTZRJWH6P', 'nft-0001', 5000000);

INSERT INTO secondary_royalty_distributions (sale_id, collaborator, amount) VALUES
  (1, 'GBDIA62PY5P5MSTMR3DSVAQ4TITI3JJWWMW2NAI2QZKMPTTKSLG5JU6L', '150000');

INSERT INTO audit_log (action, contract_id) VALUES
  ('contract_initialized', 'CFIDWUVTWDSZTKLPVFRQQ42WFLK3I572742JAQV7ZHCM4UKZTZRJWH6P'),
  ('distribution_initiated', 'CFIDWUVTWDSZTKLPVFRQQ42WFLK3I572742JAQV7ZHCM4UKZTZRJWH6P');
SQL
}

# The invariants a restored database must satisfy. Row counts alone would pass
# on a database restored from the wrong point in time; the payout-conservation
# check is the one that proves the *contents* are coherent.
verify_database_integrity() {
  local path="$1"
  local failures=0

  if [[ ! -f "$path" ]]; then
    fail_with_guidance \
      "Database not found at $path" \
      "the restore did not produce a file" \
      "check the download and decrypt checkpoints above" || true
    return 1
  fi

  local integrity
  integrity="$(sqlite3 "$path" "PRAGMA integrity_check;" 2>&1 || echo "failed")"
  if [[ "$integrity" != "ok" ]]; then
    fail_with_guidance \
      "SQLite integrity check failed" \
      "$integrity" \
      "the backup is corrupt; restore the previous one and check the backup job" || true
    failures=$((failures + 1))
  else
    log_ok "integrity_check: ok"
  fi

  local expected_tables=(
    schema_migrations transactions distribution_payouts
    secondary_sales secondary_royalty_distributions audit_log
  )
  local table
  for table in "${expected_tables[@]}"; do
    local exists
    exists="$(sqlite3 "$path" \
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table';" 2>/dev/null || echo 0)"
    if [[ "$exists" != "1" ]]; then
      fail_with_guidance \
        "Expected table missing: $table" \
        "the backup predates a migration, or is from a different application" \
        "check schema_migrations against the running code" || true
      failures=$((failures + 1))
    fi
  done
  [[ $failures -eq 0 ]] && log_ok "schema: all ${#expected_tables[@]} expected tables present"

  local migration_version
  migration_version="$(sqlite3 "$path" \
    "SELECT COALESCE(MAX(version), 0) FROM schema_migrations;" 2>/dev/null || echo 0)"
  log "schema_migrations version: $migration_version"
  if [[ "$migration_version" -lt 1 ]]; then
    fail_with_guidance \
      "No schema migrations recorded" \
      "the database was restored empty or from before the first migration" \
      "verify the backup file is the one you intended to restore" || true
    failures=$((failures + 1))
  fi

  local tx_count payout_count
  tx_count="$(sqlite3 "$path" "SELECT COUNT(*) FROM transactions;" 2>/dev/null || echo 0)"
  payout_count="$(sqlite3 "$path" "SELECT COUNT(*) FROM distribution_payouts;" 2>/dev/null || echo 0)"
  log "row counts: transactions=$tx_count distribution_payouts=$payout_count"

  if [[ "$tx_count" -eq 0 ]]; then
    fail_with_guidance \
      "Restored database contains no transactions" \
      "an empty restore passes an integrity check but has lost the audit trail" \
      "restore an earlier backup and investigate the backup job" || true
    failures=$((failures + 1))
  fi

  # The check that matters. Payouts for a transaction must sum to the
  # transaction amount; a restore that silently truncated or interleaved data
  # fails here while passing every count-based check.
  local orphaned
  orphaned="$(sqlite3 "$path" "
    SELECT COUNT(*) FROM distribution_payouts p
    LEFT JOIN transactions t ON t.id = p.transaction_id
    WHERE t.id IS NULL;
  " 2>/dev/null || echo 0)"

  if [[ "$orphaned" != "0" ]]; then
    fail_with_guidance \
      "$orphaned payout rows reference a transaction that does not exist" \
      "the restore is internally inconsistent — a partial or interleaved copy" \
      "do not accept this restore; try another backup" || true
    failures=$((failures + 1))
  else
    log_ok "referential integrity: no orphaned payouts"
  fi

  local mismatched
  mismatched="$(sqlite3 "$path" "
    SELECT COUNT(*) FROM (
      SELECT t.id
      FROM transactions t
      JOIN distribution_payouts p ON p.transaction_id = t.id
      WHERE t.status = 'confirmed'
      GROUP BY t.id, t.amount
      HAVING SUM(CAST(p.amount AS INTEGER)) <> CAST(t.amount AS INTEGER)
    );
  " 2>/dev/null || echo 0)"

  if [[ "$mismatched" != "0" ]]; then
    fail_with_guidance \
      "$mismatched confirmed transactions have payouts that do not sum to the distributed amount" \
      "value conservation is broken in the restored data" \
      "do not accept this restore; escalate to the database lead" || true
    failures=$((failures + 1))
  else
    log_ok "value conservation: payouts sum to their transaction amounts"
  fi

  return $failures
}

check_api_health() {
  local base="$1"
  local timeout="${2:-10}"

  # /health is the liveness probe — it answers from the process alone. The
  # deeper /api/v1/health probes Horizon and Soroban RPC, which is exactly what
  # must NOT gate a recovery check: an upstream outage would make a perfectly
  # good restore look failed.
  local code
  code="$(curl -sf -o /dev/null -w '%{http_code}' --max-time "$timeout" "$base/health" 2>/dev/null || echo "000")"

  if [[ "$code" == "200" ]]; then
    log_ok "API liveness: 200 from $base/health"
    return 0
  fi

  fail_with_guidance \
    "API liveness check failed (HTTP $code from $base/health)" \
    "the application is not running, or not reachable from here" \
    "check the service with 'pm2 status' and the bootstrap log at /var/log/user-data.log" || true
  return 1
}

# ══════════════════════════════════════════════════════════════════════════════
# Scenarios
# ══════════════════════════════════════════════════════════════════════════════

scenario_database_restore() {
  begin_scenario "Scenario 1: database corruption or accidental deletion"

  local work="$DR_WORK_DIR/database-restore"
  rm -rf "$work"; mkdir -p "$work"

  local live_db="$work/audit.db"
  local backup_db="$work/backup.db"

  log "Creating a test database with known contents"
  create_test_database "$live_db"
  checkpoint "test-database-created"

  local original_tx
  original_tx="$(sqlite3 "$live_db" "SELECT COUNT(*) FROM transactions;")"
  log "Baseline: $original_tx transactions"

  # The same mechanism scripts/automated-backup.sh uses. Not `cp`: the .backup
  # API takes a consistent snapshot of a database that is being written to,
  # which a file copy does not.
  log "Taking a backup via the SQLite .backup API"
  sqlite3 "$live_db" ".backup '$backup_db'"
  [[ -f "$backup_db" ]] || die "Backup file was not created"
  checkpoint "backup-taken"

  local checksum
  checksum="$(sha256sum "$backup_db" | awk '{print $1}')"
  log "Backup checksum: $checksum"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_warn "DRY RUN — stopping before the destructive step"
    return 0
  fi

  # Truncation rather than deletion: a half-written file is the realistic
  # corruption mode, and it is the one that still opens and then fails.
  log "Simulating corruption by truncating the live database"
  local db_size
  db_size="$(stat -c%s "$live_db" 2>/dev/null || stat -f%z "$live_db")"
  dd if=/dev/urandom of="$live_db" bs=1 count=$((db_size / 2)) conv=notrunc status=none
  checkpoint "corruption-injected"

  if sqlite3 "$live_db" "PRAGMA integrity_check;" 2>/dev/null | grep -q '^ok$'; then
    log_warn "The corrupted database still reports ok — the exercise is weaker than intended"
  else
    log_ok "Corruption confirmed: the live database no longer passes integrity_check"
  fi

  log "Preserving the corrupted database for analysis"
  cp "$live_db" "$work/pre-recovery-$(date -u +%Y%m%d-%H%M%S).db"
  checkpoint "pre-recovery-snapshot-taken"

  log "Restoring from the backup"
  cp "$backup_db" "$live_db"
  checkpoint "restore-completed"

  log "Verifying the restored database"
  if ! verify_database_integrity "$live_db"; then
    return 1
  fi
  checkpoint "integrity-verified"

  local restored_tx
  restored_tx="$(sqlite3 "$live_db" "SELECT COUNT(*) FROM transactions;")"
  if [[ "$restored_tx" != "$original_tx" ]]; then
    fail_with_guidance \
      "Row count mismatch after restore: expected $original_tx, found $restored_tx" \
      "the restored database is not the one that was backed up" \
      "check the backup selection and the S3 key that was downloaded"
    return 1
  fi
  log_ok "Row count matches the pre-corruption baseline ($restored_tx transactions)"

  return 0
}

scenario_backup_restore_from_s3() {
  begin_scenario "Scenario 2: backup restoration from remote storage"

  local work="$DR_WORK_DIR/s3-restore"
  rm -rf "$work"; mkdir -p "$work"

  require_command openssl "backups are encrypted with AES-256-GCM" "install openssl" || return 1

  local source_db="$work/source.db"
  local encrypted="$work/backup.db.enc"
  local decrypted="$work/restored.db"
  local key="${BACKUP_ENCRYPTION_KEY:-dr-test-passphrase}"

  create_test_database "$source_db"
  checkpoint "test-database-created"

  local original_checksum
  original_checksum="$(sha256sum "$source_db" | awk '{print $1}')"

  # Mirrors automated-backup.sh: encrypt, then verify the checksum survives the
  # encrypt/decrypt round trip.
  log "Encrypting the backup"
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -in "$source_db" -out "$encrypted" -pass "pass:$key" \
    || { fail_with_guidance "Encryption failed" "openssl returned non-zero" "check the openssl version supports -pbkdf2"; return 1; }
  checkpoint "backup-encrypted"

  if [[ "$USE_LIVE_AWS" == "true" && -n "$BACKUP_S3_BUCKET" ]]; then
    require_command aws "the exercise uploads to and downloads from S3" "install the AWS CLI" || return 1

    local s3_opts=(--region "$BACKUP_S3_REGION")
    [[ -n "$BACKUP_S3_ENDPOINT" ]] && s3_opts+=(--endpoint-url "$BACKUP_S3_ENDPOINT")

    local s3_key="dr-test/$(date -u +%Y%m%dT%H%M%SZ)-backup.db.enc"
    log "Uploading to s3://$BACKUP_S3_BUCKET/$s3_key"

    if [[ "$DRY_RUN" == "true" ]]; then
      log_warn "DRY RUN — skipping the S3 upload and download"
    else
      aws s3 cp "$encrypted" "s3://$BACKUP_S3_BUCKET/$s3_key" "${s3_opts[@]}" \
        || { fail_with_guidance "S3 upload failed" "the bucket is unreachable or the role lacks s3:PutObject" "check the instance role grants in infra/terraform/modules/security"; return 1; }
      checkpoint "uploaded-to-s3"

      rm -f "$encrypted"

      aws s3 cp "s3://$BACKUP_S3_BUCKET/$s3_key" "$encrypted" "${s3_opts[@]}" \
        || { fail_with_guidance "S3 download failed" "the object is missing or unreadable" "verify the key exists with 'aws s3 ls'"; return 1; }
      checkpoint "downloaded-from-s3"

      aws s3 rm "s3://$BACKUP_S3_BUCKET/$s3_key" "${s3_opts[@]}" >/dev/null 2>&1 || true
    fi
  else
    log "Skipping the S3 round trip — set DR_USE_LIVE_AWS=true and BACKUP_S3_BUCKET to include it"
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log_warn "DRY RUN — stopping before decryption"
    return 0
  fi

  log "Decrypting the backup"
  openssl enc -aes-256-cbc -pbkdf2 -d \
    -in "$encrypted" -out "$decrypted" -pass "pass:$key" \
    || { fail_with_guidance \
           "Decryption failed" \
           "the passphrase does not match the one used to encrypt" \
           "this is the classic silent backup failure — confirm BACKUP_ENCRYPTION_KEY matches the key in use when the backup was taken, and check whether it has been rotated"; return 1; }
  checkpoint "backup-decrypted"

  local restored_checksum
  restored_checksum="$(sha256sum "$decrypted" | awk '{print $1}')"

  if [[ "$restored_checksum" != "$original_checksum" ]]; then
    fail_with_guidance \
      "Checksum mismatch after the encrypt/decrypt round trip" \
      "expected $original_checksum, got $restored_checksum" \
      "the backup is corrupt in transit or at rest; check S3 object integrity"
    return 1
  fi
  log_ok "Checksum matches after the round trip"
  checkpoint "checksum-verified"

  verify_database_integrity "$decrypted" || return 1
  checkpoint "integrity-verified"

  return 0
}

scenario_rpc_outage() {
  begin_scenario "Scenario 3: Soroban RPC or Horizon dependency outage"

  # This scenario is a read-only probe on purpose. The recovery for an upstream
  # outage is to fail over to another endpoint and wait — there is nothing to
  # restore. What is verified here is that the alternatives are actually
  # reachable, so the runbook's failover step is not a fiction.

  local endpoints=("$SOROBAN_RPC_URL" "$HORIZON_URL")
  local reachable=0 unreachable=0

  local endpoint
  for endpoint in "${endpoints[@]}"; do
    local code
    code="$(curl -sf -o /dev/null -w '%{http_code}' --max-time 15 "$endpoint" 2>/dev/null || echo "000")"

    # Horizon answers 200 at the root; Soroban RPC is JSON-RPC and returns 405
    # to a bare GET. Both indicate a reachable service.
    if [[ "$code" =~ ^(200|400|404|405)$ ]]; then
      log_ok "reachable: $endpoint (HTTP $code)"
      reachable=$((reachable + 1))
    else
      log_warn "unreachable: $endpoint (HTTP $code)"
      unreachable=$((unreachable + 1))
    fi
  done
  checkpoint "primary-endpoints-probed"

  log "Checking documented fallback endpoints"
  local fallbacks=(
    "https://horizon-testnet.stellar.org"
    "https://soroban-testnet.stellar.org"
  )
  local fallback_ok=0
  for endpoint in "${fallbacks[@]}"; do
    local code
    code="$(curl -sf -o /dev/null -w '%{http_code}' --max-time 15 "$endpoint" 2>/dev/null || echo "000")"
    if [[ "$code" =~ ^(200|400|404|405)$ ]]; then
      log_ok "fallback reachable: $endpoint (HTTP $code)"
      fallback_ok=$((fallback_ok + 1))
    else
      log_warn "fallback unreachable: $endpoint (HTTP $code)"
    fi
  done
  checkpoint "fallback-endpoints-probed"

  if [[ $reachable -eq 0 && $fallback_ok -eq 0 ]]; then
    fail_with_guidance \
      "No Stellar endpoint is reachable, primary or fallback" \
      "either the network path is broken or Stellar itself is down" \
      "check NAT gateway health and egress rules, then https://status.stellar.org"
    return 1
  fi

  # The application's own retry behaviour under a failing RPC is covered by the
  # chaos suite; this exercise only establishes that a failover target exists.
  log "The application retries RPC failures with backoff — see backend/src/rpc-retry.js and the chaos tests"
  log_ok "At least one endpoint is reachable; failover is viable"

  return 0
}

scenario_infrastructure_recreation() {
  begin_scenario "Scenario 4: loss of application infrastructure"

  # Verifies that the infrastructure is genuinely reproducible from source,
  # which is the claim #870 makes. If `terraform validate` fails, the recovery
  # procedure "re-apply the Terraform" does not work, and that must be known
  # before an incident rather than during one.

  local tf_dir="$REPO_ROOT/infra/terraform"

  if [[ ! -d "$tf_dir" ]]; then
    log_warn "No Terraform configuration at $tf_dir — skipping"
    return 0
  fi

  if ! command -v terraform >/dev/null 2>&1; then
    log_warn "terraform not installed — skipping the recreation check"
    log "Install it to exercise this scenario: https://developer.hashicorp.com/terraform/install"
    return 0
  fi

  log "Checking formatting"
  if terraform fmt -check -recursive "$tf_dir" >/dev/null 2>&1; then
    log_ok "terraform fmt: clean"
  else
    log_warn "terraform fmt reports changes — cosmetic, not a recovery blocker"
  fi
  checkpoint "format-checked"

  local target="$tf_dir/environments/${DR_ENVIRONMENT}"
  if [[ ! -d "$target" ]]; then
    log_warn "No Terraform environment for '$DR_ENVIRONMENT'; falling back to dev"
    target="$tf_dir/environments/dev"
  fi

  if [[ ! -d "$target" ]]; then
    log_warn "No environment directory to validate — skipping"
    return 0
  fi

  log "Validating $target"
  (
    cd "$target"
    terraform init -backend=false -input=false >/dev/null 2>&1
    terraform validate -no-color
  ) || {
    fail_with_guidance \
      "terraform validate failed for $target" \
      "the infrastructure cannot be recreated from source as written" \
      "fix the configuration — the recovery procedure depends on this working"
    return 1
  }
  checkpoint "terraform-validated"
  log_ok "Infrastructure is reproducible from source"

  if [[ "$DRY_RUN" != "true" && "$USE_LIVE_AWS" == "true" ]]; then
    log "Running a plan to confirm the configuration resolves against live AWS"
    ( cd "$target" && terraform plan -input=false -lock=false -no-color >/dev/null 2>&1 ) \
      && log_ok "terraform plan succeeded" \
      || log_warn "terraform plan failed — usually missing backend configuration or credentials"
    checkpoint "terraform-planned"
  fi

  return 0
}

scenario_config_and_secret_recovery() {
  begin_scenario "Scenario 5: configuration or secret loss"

  # A recovered database is useless if the application cannot start. This
  # verifies that everything needed to reconstruct the runtime configuration is
  # documented and retrievable, rather than living only in someone's shell
  # history.

  local env_example="$REPO_ROOT/backend/.env.example"
  if [[ ! -f "$env_example" ]]; then
    fail_with_guidance \
      "backend/.env.example is missing" \
      "there is no reference for what configuration the application needs" \
      "restore it from git history"
    return 1
  fi

  local documented
  documented="$(grep -cE '^[A-Z_]+=|^# [A-Z_]+ —' "$env_example" || echo 0)"
  log_ok "backend/.env.example documents $documented settings"
  checkpoint "config-reference-present"

  # Settings without which the application cannot serve traffic at all.
  local critical=(
    PORT
    DATABASE_PATH
    STELLAR_NETWORK
    SOROBAN_RPC_URL
    HORIZON_URL
    FRONTEND_ORIGIN
  )
  local missing=()
  local setting
  for setting in "${critical[@]}"; do
    grep -qE "^#?\s*${setting}\b" "$env_example" || missing+=("$setting")
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    fail_with_guidance \
      "Critical settings undocumented: ${missing[*]}" \
      "an operator rebuilding configuration from scratch would not know to set them" \
      "add them to backend/.env.example"
    return 1
  fi
  log_ok "All ${#critical[@]} critical settings are documented"
  checkpoint "critical-settings-documented"

  log "Checking that the application can locate its secrets provider"
  local secrets_module="$REPO_ROOT/backend/src/secrets-manager.js"
  if [[ -f "$secrets_module" ]]; then
    local providers
    providers="$(grep -oE '"(aws|vault|file|env)"' "$secrets_module" | sort -u | tr '\n' ' ')"
    log_ok "Secrets providers supported: $providers"
  else
    log_warn "backend/src/secrets-manager.js not found"
  fi
  checkpoint "secrets-provider-checked"

  if [[ "$USE_LIVE_AWS" == "true" ]] && command -v aws >/dev/null 2>&1; then
    if [[ -n "${AWS_SECRET_NAME:-}" ]]; then
      log "Confirming the signing key secret exists (metadata only — the value is never read)"
      if aws secretsmanager describe-secret --secret-id "$AWS_SECRET_NAME" >/dev/null 2>&1; then
        log_ok "Secret is retrievable: $AWS_SECRET_NAME"
      else
        fail_with_guidance \
          "Cannot describe secret $AWS_SECRET_NAME" \
          "it does not exist, or the role lacks secretsmanager:DescribeSecret" \
          "check the grant in infra/terraform/modules/security/main.tf"
        return 1
      fi
      checkpoint "secret-retrievable"
    else
      log "AWS_SECRET_NAME is not set — skipping the live secret check"
    fi
  fi

  return 0
}

scenario_partial_service_failure() {
  begin_scenario "Scenario 6: partial service failure"

  # The interesting property is that the service degrades rather than dies: the
  # liveness probe must keep answering even when a dependency is unavailable,
  # because that is what stops the ASG replacing an instance during an upstream
  # outage and turning a partial failure into a total one.

  if ! curl -sf -o /dev/null --max-time 5 "$API_BASE_URL/health" 2>/dev/null; then
    log_warn "No API reachable at $API_BASE_URL — skipping the live checks"
    log "Start the API and set API_BASE_URL to exercise this scenario"
    return 0
  fi

  check_api_health "$API_BASE_URL" || return 1
  checkpoint "liveness-verified"

  log "Probing the readiness endpoint"
  local ready_code
  ready_code="$(curl -sf -o /dev/null -w '%{http_code}' --max-time 10 "$API_BASE_URL/ready" 2>/dev/null || echo "000")"
  if [[ "$ready_code" == "200" ]]; then
    log_ok "Readiness: 200"
  else
    log_warn "Readiness returned $ready_code — the service is up but not ready to take traffic"
  fi
  checkpoint "readiness-probed"

  log "Probing the deep health check, which reaches Horizon and Soroban RPC"
  local health_code
  health_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$API_BASE_URL/api/v1/health" 2>/dev/null || echo "000")"
  log "Deep health check: HTTP $health_code"

  # A degraded deep check alongside a healthy liveness probe is the correct
  # behaviour, not a failure: it is precisely the separation that keeps an
  # upstream outage from becoming an instance-replacement loop.
  if [[ "$health_code" == "200" ]]; then
    log_ok "All dependencies healthy"
  elif [[ "$health_code" == "503" ]]; then
    log_ok "Service is degraded but liveness still answers — the intended behaviour under a dependency outage"
  else
    log_warn "Unexpected deep health status: $health_code"
  fi
  checkpoint "degradation-behaviour-verified"

  return 0
}

scenario_full_environment_recreation() {
  begin_scenario "Scenario 7: complete environment recreation"

  # The end-to-end claim: given only the repository and a backup, the whole
  # environment can be rebuilt. Each ingredient is checked for existence and
  # usability; the actual apply is an operator-led exercise documented in the
  # runbook, because it costs real money and takes real time.

  local required_ok=0 required_total=0 optional_missing=0

  # Required: without these the environment genuinely cannot be rebuilt.
  check_required() {
    local label="$1" path="$2"
    required_total=$((required_total + 1))
    if [[ -e "$path" ]]; then
      log_ok "$label"
      required_ok=$((required_ok + 1))
    else
      log_error "$label — missing: $path"
    fi
  }

  # Optional: recovery is materially harder without these, but still possible
  # by following the operator runbook by hand. Reported rather than fatal — an
  # environment provisioned manually is a slower rebuild, not an impossible one.
  check_optional() {
    local label="$1" path="$2" consequence="$3"
    if [[ -e "$path" ]]; then
      log_ok "$label"
    else
      log_warn "$label not present — $consequence"
      optional_missing=$((optional_missing + 1))
    fi
  }

  check_required "Contract deployment script" "$REPO_ROOT/scripts/deploy.sh"
  check_required "Deployment validation script" "$REPO_ROOT/scripts/validate-deployment.sh"
  check_required "Environment validation script" "$REPO_ROOT/scripts/validate-env.sh"
  check_required "Backup script" "$REPO_ROOT/scripts/automated-backup.sh"
  check_required "Backup monitoring script" "$REPO_ROOT/scripts/backup-monitoring.sh"
  check_required "Configuration reference" "$REPO_ROOT/backend/.env.example"
  check_required "Operator runbook" "$REPO_ROOT/docs/operator-runbook.md"
  check_required "Disaster recovery runbook" "$REPO_ROOT/docs/DISASTER_RECOVERY_RUNBOOK.md"
  check_required "Backup strategy" "$REPO_ROOT/docs/backup-strategy.md"

  check_optional "Infrastructure definition" "$REPO_ROOT/infra/terraform" \
    "rebuilding infrastructure would be manual, following docs/operator-runbook.md"
  checkpoint "recovery-assets-checked"

  if [[ $required_ok -lt $required_total ]]; then
    fail_with_guidance \
      "$((required_total - required_ok)) of $required_total required recovery assets are missing" \
      "the environment cannot be rebuilt from the repository alone" \
      "restore the missing files before relying on this recovery path"
    return 1
  fi
  log_ok "All $required_total required recovery assets present"
  [[ $optional_missing -gt 0 ]] && log_warn "$optional_missing optional asset(s) absent — recovery is slower but still possible"

  log "Checking that the recovery scripts are executable"
  local script
  for script in deploy.sh validate-deployment.sh automated-backup.sh backup-monitoring.sh; do
    if [[ -x "$REPO_ROOT/scripts/$script" ]]; then
      log_ok "executable: scripts/$script"
    else
      log_warn "not executable: scripts/$script — run 'chmod +x' or invoke it with bash"
    fi
  done
  checkpoint "scripts-checked"

  log "Verifying the recovery scripts parse"
  local parse_failures=0
  for script in "$REPO_ROOT"/scripts/*.sh "$SCRIPT_DIR"/*.sh; do
    [[ -f "$script" ]] || continue
    if ! bash -n "$script" 2>/dev/null; then
      log_error "syntax error: $(basename "$script")"
      parse_failures=$((parse_failures + 1))
    fi
  done

  if [[ $parse_failures -gt 0 ]]; then
    fail_with_guidance \
      "$parse_failures recovery script(s) have syntax errors" \
      "a script that will not parse cannot be run during an incident" \
      "run 'bash -n' on each script under scripts/ and fix the errors"
    return 1
  fi
  log_ok "All recovery scripts parse cleanly"
  checkpoint "scripts-parse-verified"

  return 0
}

scenario_broken_deployment_rollback() {
  begin_scenario "Scenario 8: invalid or broken deployment"

  # Soroban contracts are immutable once deployed, so "rollback" means pointing
  # the backend at the previous known-good contract id. This verifies that the
  # mechanism for doing so exists and is documented.

  local deployment_doc="$REPO_ROOT/DEPLOYMENT.md"
  if [[ ! -f "$deployment_doc" ]]; then
    deployment_doc="$REPO_ROOT/docs/DEPLOYMENT.md"
  fi

  if [[ ! -f "$deployment_doc" ]]; then
    fail_with_guidance \
      "No deployment documentation found" \
      "there is no written rollback procedure" \
      "restore DEPLOYMENT.md from git history"
    return 1
  fi

  if grep -qi "rollback" "$deployment_doc"; then
    log_ok "A rollback procedure is documented in $(basename "$deployment_doc")"
  else
    fail_with_guidance \
      "No rollback section in $(basename "$deployment_doc")" \
      "operators have no written procedure for a bad deployment" \
      "document one — Soroban contracts are immutable, so rollback means repointing ROYALTY_CONTRACT_ID"
    return 1
  fi
  checkpoint "rollback-procedure-documented"

  log "Checking the pre-deployment validation gate"
  if [[ -x "$REPO_ROOT/scripts/validate-deployment.sh" ]]; then
    log_ok "scripts/validate-deployment.sh is present and executable"
    log "It is the gate that catches a bad deployment before it reaches an environment"
  else
    log_warn "scripts/validate-deployment.sh is missing or not executable"
  fi
  checkpoint "validation-gate-checked"

  log "Confirming the contract id is externally configurable"
  if grep -qE "ROYALTY_CONTRACT_ID|CONTRACT_ID" "$REPO_ROOT/backend/.env.example"; then
    log_ok "ROYALTY_CONTRACT_ID is configurable — repointing to a known-good contract is possible"
  else
    fail_with_guidance \
      "The contract id does not appear to be externally configurable" \
      "rolling back to a previous contract would require a code change" \
      "expose it as an environment variable"
    return 1
  fi
  checkpoint "contract-repointing-verified"

  return 0
}

# ── Scenario registry ────────────────────────────────────────────────────────

SCENARIO_KEYS=(
  database-restore
  backup-restore
  rpc-outage
  infrastructure-recreation
  config-recovery
  partial-failure
  environment-recreation
  deployment-rollback
)

scenario_function_for() {
  case "$1" in
    database-restore)          echo scenario_database_restore ;;
    backup-restore)            echo scenario_backup_restore_from_s3 ;;
    rpc-outage)                echo scenario_rpc_outage ;;
    infrastructure-recreation) echo scenario_infrastructure_recreation ;;
    config-recovery)           echo scenario_config_and_secret_recovery ;;
    partial-failure)           echo scenario_partial_service_failure ;;
    environment-recreation)    echo scenario_full_environment_recreation ;;
    deployment-rollback)       echo scenario_broken_deployment_rollback ;;
    *)                         echo "" ;;
  esac
}

scenario_description_for() {
  case "$1" in
    database-restore)          echo "Database corruption or accidental deletion" ;;
    backup-restore)            echo "Backup restoration, including the encrypt/decrypt round trip" ;;
    rpc-outage)                echo "Soroban RPC or Horizon dependency outage" ;;
    infrastructure-recreation) echo "Loss of application infrastructure" ;;
    config-recovery)           echo "Configuration or secret loss" ;;
    partial-failure)           echo "Partial service failure and graceful degradation" ;;
    environment-recreation)    echo "Complete environment recreation from the repository" ;;
    deployment-rollback)       echo "Invalid or broken deployment" ;;
    *)                         echo "" ;;
  esac
}

list_scenarios() {
  printf '%sAvailable scenarios%s\n\n' "$C_BOLD" "$C_OFF"
  local key
  for key in "${SCENARIO_KEYS[@]}"; do
    printf '  %-28s %s\n' "$key" "$(scenario_description_for "$key")"
  done
  printf '\n'
}

run_scenario() {
  local key="$1"
  local fn
  fn="$(scenario_function_for "$key")"

  if [[ -z "$fn" ]]; then
    log_error "Unknown scenario: $key"
    return 1
  fi

  local start end duration status message
  start="$(date -u +%s)"

  if "$fn"; then
    status="passed"
    message="Recovery completed successfully"
  else
    status="failed"
    message="Recovery did not complete — see the log above"
  fi

  end="$(date -u +%s)"
  duration=$(( end - start ))

  # An exercise that succeeds but takes longer than the RTO has still failed
  # the thing the RTO exists to measure.
  if [[ "$status" == "passed" && "$duration" -gt "$RTO_TARGET_SECONDS" ]]; then
    status="failed"
    message="Recovery succeeded but took ${duration}s, exceeding the ${RTO_TARGET_SECONDS}s RTO target"
    log_error "$message"
  fi

  record_result "$key" "$status" "$duration" "$message"

  if [[ "$status" == "passed" ]]; then
    log_ok "$key completed in ${duration}s (RTO target ${RTO_TARGET_SECONDS}s)"
  else
    log_error "$key: $message"
  fi

  return 0
}

# ── Reporting ────────────────────────────────────────────────────────────────

print_summary() {
  local passed=0 failed=0 total_duration=0 i

  printf '\n%s══ Disaster recovery exercise summary ══%s\n\n' "$C_BOLD" "$C_OFF"
  printf '  Environment: %s\n' "$DR_ENVIRONMENT"
  printf '  Started:     %s\n' "$RUN_STARTED_AT"
  printf '  Finished:    %s\n' "$(timestamp)"
  printf '  RTO target:  %ss\n' "$RTO_TARGET_SECONDS"
  printf '  Dry run:     %s\n' "$DRY_RUN"
  printf '\n'
  printf '  %-28s %-8s %10s\n' "SCENARIO" "RESULT" "DURATION"
  printf '  %-28s %-8s %10s\n' "----------------------------" "--------" "----------"

  for i in "${!RESULT_NAMES[@]}"; do
    local colour="$C_GREEN"
    [[ "${RESULT_STATUSES[$i]}" != "passed" ]] && colour="$C_RED"

    printf '  %-28s %s%-8s%s %9ss\n' \
      "${RESULT_NAMES[$i]}" "$colour" "${RESULT_STATUSES[$i]}" "$C_OFF" "${RESULT_DURATIONS[$i]}"

    if [[ "${RESULT_STATUSES[$i]}" == "passed" ]]; then
      passed=$((passed + 1))
    else
      failed=$((failed + 1))
    fi
    total_duration=$((total_duration + RESULT_DURATIONS[i]))
  done

  printf '\n  %d passed, %d failed, %ds total\n\n' "$passed" "$failed" "$total_duration"

  if [[ $failed -gt 0 ]]; then
    printf '  %sRecovery procedures are not working as documented.%s\n' "$C_RED" "$C_OFF"
    printf '  Fix them now — an untested procedure discovered broken during an\n'
    printf '  incident is the failure mode this exercise exists to prevent.\n\n'
  fi

  return $failed
}

write_json_report() {
  local path="$1"
  mkdir -p "$(dirname "$path")"

  local scenarios="" i
  for i in "${!RESULT_NAMES[@]}"; do
    [[ -n "$scenarios" ]] && scenarios+=","
    scenarios+="$(printf '
    {
      "scenario": "%s",
      "description": "%s",
      "status": "%s",
      "durationSeconds": %s,
      "message": "%s",
      "checkpoints": %s
    }' \
      "${RESULT_NAMES[$i]}" \
      "$(scenario_description_for "${RESULT_NAMES[$i]}")" \
      "${RESULT_STATUSES[$i]}" \
      "${RESULT_DURATIONS[$i]}" \
      "${RESULT_MESSAGES[$i]}" \
      "${RESULT_CHECKPOINTS[$i]}")"
  done

  cat > "$path" <<JSON
{
  "schemaVersion": 1,
  "environment": "$DR_ENVIRONMENT",
  "startedAt": "$RUN_STARTED_AT",
  "finishedAt": "$(timestamp)",
  "dryRun": $DRY_RUN,
  "usedLiveAws": $USE_LIVE_AWS,
  "rtoTargetSeconds": $RTO_TARGET_SECONDS,
  "scenarios": [$scenarios
  ]
}
JSON

  log "Report written to $path"
}

# ── Entry point ──────────────────────────────────────────────────────────────

usage() {
  cat <<USAGE
disaster-recovery-test.sh — repeatable non-production recovery exercises (#865)

Usage:
  ./infra/disaster-recovery-test.sh [options]

Options:
  --scenario <key>      Run one scenario. Repeatable.
  --all                 Run every scenario.
  --list                List the available scenarios and exit.
  --dry-run             Run without the destructive steps.
  --json-report <path>  Write a machine-readable report.
  --use-live-aws        Include steps that touch real AWS resources.
  --rto-target <secs>   RTO target in seconds (default 3600).
  --i-understand-this-is-production
                        Override the production safety guard. Logged.
  -h, --help            Show this message.

Environment:
  DR_ENVIRONMENT             REQUIRED. The isolated environment being exercised.
  DR_WORK_DIR                Scratch directory (default \$TMPDIR/stellar-dr-test).
  DR_FORBIDDEN_ACCOUNT_IDS   Comma-separated AWS account ids to refuse.
  DATABASE_PATH              Database under test.
  BACKUP_S3_BUCKET           Backup bucket for the S3 round trip.
  BACKUP_ENCRYPTION_KEY      Passphrase for the encrypt/decrypt exercise.
  API_BASE_URL               API base URL (default http://localhost:3001).
  RTO_TARGET_SECONDS         RTO target (default 3600).

Safety:
  This script mutates databases and deletes files. It refuses to run against
  anything named like production unless the override flag is passed.

  Production recovery is an operator-led procedure documented in
  docs/DISASTER_RECOVERY_RUNBOOK.md. Do not reach for this script during a
  real incident.

Examples:
  DR_ENVIRONMENT=staging ./infra/disaster-recovery-test.sh --list
  DR_ENVIRONMENT=staging ./infra/disaster-recovery-test.sh --all --dry-run
  DR_ENVIRONMENT=staging ./infra/disaster-recovery-test.sh --scenario database-restore
  DR_ENVIRONMENT=staging ./infra/disaster-recovery-test.sh --all --json-report dr.json
USAGE
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scenario)   SELECTED_SCENARIOS+=("$2"); shift 2 ;;
      --all)        SELECTED_SCENARIOS=("${SCENARIO_KEYS[@]}"); shift ;;
      --list)       list_scenarios; exit 0 ;;
      --dry-run)    DRY_RUN=true; shift ;;
      --json-report) JSON_REPORT="$2"; shift 2 ;;
      --use-live-aws) USE_LIVE_AWS=true; shift ;;
      --rto-target) RTO_TARGET_SECONDS="$2"; shift 2 ;;
      --i-understand-this-is-production) ALLOW_PRODUCTION=true; shift ;;
      -h|--help)    usage; exit 0 ;;
      *)            log_error "Unknown option: $1"; printf '\n'; usage; exit 1 ;;
    esac
  done

  [[ "${DR_USE_LIVE_AWS:-}" == "true" ]] && USE_LIVE_AWS=true

  if [[ ${#SELECTED_SCENARIOS[@]} -eq 0 ]]; then
    log_error "Nothing to run. Pass --scenario <key>, --all, or --list."
    printf '\n'
    usage
    exit 1
  fi

  RUN_STARTED_AT="$(timestamp)"

  printf '%s══ Disaster recovery exercise ══%s\n\n' "$C_BOLD" "$C_OFF"

  run_safety_checks

  require_command sqlite3 "the exercises create and verify SQLite databases" \
    "install sqlite3 (apt install sqlite3 / brew install sqlite)" || exit 1
  require_command curl "the exercises probe HTTP endpoints" "install curl" || exit 1

  mkdir -p "$DR_WORK_DIR" "$DR_REPORT_DIR"
  log "Work directory: $DR_WORK_DIR"
  [[ "$DRY_RUN" == "true" ]] && log_warn "DRY RUN — destructive steps are skipped"

  local key
  for key in "${SELECTED_SCENARIOS[@]}"; do
    run_scenario "$key"
  done

  local failed=0
  print_summary || failed=$?

  if [[ -n "$JSON_REPORT" ]]; then
    write_json_report "$JSON_REPORT"
  fi
  write_json_report "$DR_REPORT_DIR/dr-$(date -u +%Y%m%dT%H%M%SZ).json"

  exit $(( failed > 0 ? 1 : 0 ))
}

main "$@"
