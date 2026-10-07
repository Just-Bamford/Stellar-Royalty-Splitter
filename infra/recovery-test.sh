#!/usr/bin/env bash
#
# recovery-test.sh — weekly automated recovery test (#937).
#
# A backup that has never been restored is a hope, not a backup. This script
# restores the newest backup, proves the data is intact, and measures the
# recovery against the documented targets (RTO < 1 hour, RPO < 15 minutes):
#
#   1. infra/backup-manager.js recovery-test
#        - locates the newest backup (daily or 15-minute PITR snapshot),
#        - downloads and decrypts it (AES-256-GCM authenticates every byte),
#        - checks PRAGMA integrity_check, and row counts + per-table checksums
#          against the manifest written at backup time,
#        - measures RPO: age of the newest backup and the largest gap between
#          PITR snapshots over the last 24 hours.
#   2. With --install: stops the staging API, installs the verified restore as
#      the staging database, starts the API again, and waits for its health
#      check. The RTO reported is then the full procedure, service restart
#      included — which is what an incident actually costs.
#
# Usage:
#   RECOVERY_ENVIRONMENT=staging ./infra/recovery-test.sh
#   RECOVERY_ENVIRONMENT=staging ./infra/recovery-test.sh --install
#   RECOVERY_ENVIRONMENT=staging ./infra/recovery-test.sh --dry-run
#
# Scheduled weekly by infra/terraform/backup.tf (EventBridge → SSM Run Command
# on the staging instance). Exit status is non-zero on any failure;
# backup-manager.js sends the alert and publishes the CloudWatch metrics that
# the "recovery test failed / missing" alarms watch.
#
# Environment:
#   RECOVERY_ENVIRONMENT     required; must not be production (see Safety)
#   RECOVERY_WORK_DIR        default: <repo>/.backup-work/recovery-test
#   RECOVERY_REPORT_DIR      default: <repo>/.backup-work/reports
#   RECOVERY_STOP_CMD        default: pm2 stop royalty-splitter-api
#   RECOVERY_START_CMD       default: pm2 start royalty-splitter-api
#   RECOVERY_HEALTH_URL      default: http://127.0.0.1:3001/health
#   RECOVERY_HEALTH_TIMEOUT  seconds to wait for health after restart (default 300)
#   RTO_TARGET_SECONDS       default 3600
#   plus everything backup-manager.js reads (BACKUP_ENCRYPTION_KEY, BACKUP_S3_BUCKET, …)
#
# Safety: installing a restore replaces a database. The script refuses to run
# when RECOVERY_ENVIRONMENT looks like production unless
# --i-understand-this-is-production is passed; production recovery is the
# operator-led procedure in docs/disaster-recovery-runbook.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RECOVERY_ENVIRONMENT="${RECOVERY_ENVIRONMENT:-}"
RECOVERY_WORK_DIR="${RECOVERY_WORK_DIR:-$REPO_ROOT/.backup-work/recovery-test}"
RECOVERY_REPORT_DIR="${RECOVERY_REPORT_DIR:-$REPO_ROOT/.backup-work/reports}"
RECOVERY_STOP_CMD="${RECOVERY_STOP_CMD:-pm2 stop royalty-splitter-api}"
RECOVERY_START_CMD="${RECOVERY_START_CMD:-pm2 start royalty-splitter-api}"
RECOVERY_HEALTH_URL="${RECOVERY_HEALTH_URL:-http://127.0.0.1:3001/health}"
RECOVERY_HEALTH_TIMEOUT="${RECOVERY_HEALTH_TIMEOUT:-300}"
RTO_TARGET_SECONDS="${RTO_TARGET_SECONDS:-3600}"

INSTALL=false
DRY_RUN=false
ALLOW_PRODUCTION=false

usage() {
  sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL=true ;;
    --dry-run) DRY_RUN=true ;;
    --i-understand-this-is-production) ALLOW_PRODUCTION=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { printf '%s [recovery-test] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "FAIL: $*"; exit 1; }

# ── Safety ──────────────────────────────────────────────────────────────────

[[ -n "$RECOVERY_ENVIRONMENT" ]] || die "RECOVERY_ENVIRONMENT must be set (e.g. staging)"

shopt -s nocasematch
if [[ "$RECOVERY_ENVIRONMENT" =~ (^|[-_])(prod|production|mainnet|live)([-_]|$) ]] && [[ "$ALLOW_PRODUCTION" != true ]]; then
  die "refusing to run against '$RECOVERY_ENVIRONMENT' without --i-understand-this-is-production"
fi
shopt -u nocasematch

command -v node >/dev/null 2>&1 || die "node is required"

export BACKUP_ENVIRONMENT="${BACKUP_ENVIRONMENT:-$RECOVERY_ENVIRONMENT}"
MANAGER=(node "$SCRIPT_DIR/backup-manager.js")
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
REPORT="$RECOVERY_REPORT_DIR/recovery-test-$STAMP.json"

if [[ "$DRY_RUN" == true ]]; then
  log "dry run — would execute:"
  log "  ${MANAGER[*]} recovery-test --target-dir $RECOVERY_WORK_DIR --report $REPORT"
  if [[ "$INSTALL" == true ]]; then
    log "  $RECOVERY_STOP_CMD"
    log "  ${MANAGER[*]} restore --latest --target-dir $RECOVERY_WORK_DIR/install --install --force"
    log "  $RECOVERY_START_CMD"
    log "  wait for $RECOVERY_HEALTH_URL (timeout ${RECOVERY_HEALTH_TIMEOUT}s)"
  fi
  exit 0
fi

mkdir -p "$RECOVERY_REPORT_DIR"
START_EPOCH="$(date +%s)"

# ── 1. Restore into an isolated directory and verify ────────────────────────

log "environment: $RECOVERY_ENVIRONMENT"
log "restoring newest backup into $RECOVERY_WORK_DIR and verifying integrity"
if ! "${MANAGER[@]}" recovery-test --target-dir "$RECOVERY_WORK_DIR" --report "$REPORT"; then
  log "report: $REPORT"
  die "backup could not be restored, failed integrity checks, or missed the RPO/RTO target"
fi
log "verified restore OK (report: $REPORT)"

# ── 2. Optionally install into the staging database and restart ─────────────

if [[ "$INSTALL" == true ]]; then
  log "stopping API: $RECOVERY_STOP_CMD"
  bash -c "$RECOVERY_STOP_CMD"

  restart_api() { log "starting API: $RECOVERY_START_CMD"; bash -c "$RECOVERY_START_CMD" || true; }
  # Whatever happens below, never leave staging without a running API.
  trap restart_api EXIT

  "${MANAGER[@]}" restore --latest --target-dir "$RECOVERY_WORK_DIR/install" --install --force \
    > "$RECOVERY_REPORT_DIR/recovery-install-$STAMP.json" \
    || die "installing the restored database failed"

  trap - EXIT
  restart_api

  log "waiting for $RECOVERY_HEALTH_URL"
  deadline=$(( $(date +%s) + RECOVERY_HEALTH_TIMEOUT ))
  until curl -fsS --max-time 5 "$RECOVERY_HEALTH_URL" >/dev/null 2>&1; do
    (( $(date +%s) < deadline )) || die "API did not become healthy within ${RECOVERY_HEALTH_TIMEOUT}s after restore"
    sleep 5
  done
  log "API healthy on restored data"
fi

# ── 3. End-to-end RTO ───────────────────────────────────────────────────────

ELAPSED=$(( $(date +%s) - START_EPOCH ))
node -e '
  const fs = require("fs");
  const [file, elapsed, target, installed] = process.argv.slice(1);
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  report.endToEnd = {
    installedIntoService: installed === "true",
    elapsedSeconds: Number(elapsed),
    rtoTargetSeconds: Number(target),
    ok: Number(elapsed) <= Number(target),
  };
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
' "$REPORT" "$ELAPSED" "$RTO_TARGET_SECONDS" "$INSTALL"

if (( ELAPSED > RTO_TARGET_SECONDS )); then
  die "end-to-end recovery took ${ELAPSED}s, above the ${RTO_TARGET_SECONDS}s RTO target"
fi

log "PASS — end-to-end recovery ${ELAPSED}s (RTO target ${RTO_TARGET_SECONDS}s); report: $REPORT"
