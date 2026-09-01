#!/usr/bin/env bash
# backup-monitoring.sh — Check backup freshness, integrity, and retention.
#
# Run via cron every hour:
#   0 * * * * /path/to/scripts/backup-monitoring.sh
#
# Environment variables:
#   BACKUP_S3_BUCKET           S3 bucket name (default: stellar-royalty-backups)
#   BACKUP_S3_REGION           AWS region (default: us-east-1)
#   BACKUP_S3_ENDPOINT         S3 endpoint URL (for MinIO)
#   BACKUP_ALERT_WEBHOOK       Optional webhook URL for alerts (Slack, Discord, etc.)
#   BACKUP_DIR                 Local log directory (default: /tmp/stellar-backup)
#   BACKUP_MAX_AGE_HOURS       Max hours before a daily backup is stale (default: 25)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-stellar-royalty-backups}"
BACKUP_S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/stellar-backup}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-25}"
LOG_FILE="$BACKUP_DIR/backup-monitor.log"
DATE_SHORT="$(date -u +%Y-%m-%d)"

mkdir -p "$BACKUP_DIR"

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"
  echo "$msg" | tee -a "$LOG_FILE"
}

send_alert() {
  local subject="$1"
  local body="$2"

  log "ALERT: $subject"

  if [[ -n "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
    curl -s -X POST "$BACKUP_ALERT_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"text\": \"**Stellar Royalty Backup Alert**\n\n**$subject**\n\n$body\"}" \
      >/dev/null 2>&1 || log "WARNING: Failed to send webhook alert"
  fi
}

# Build S3 options
S3_OPTS="--region $BACKUP_S3_REGION --output json"
if [[ -n "$BACKUP_S3_ENDPOINT" ]]; then
  S3_OPTS="$S3_OPTS --endpoint-url $BACKUP_S3_ENDPOINT"
fi

# ── Check 1: Daily backup exists and is fresh ──────────────────────────────
log "=== Backup monitoring check ==="

DAILY_BACKUPS=$(aws s3 ls "s3://$BACKUP_S3_BUCKET/daily/" $S3_OPTS 2>/dev/null || echo "[]")

if [[ "$DAILY_BACKUPS" == "[]" || -z "$DAILY_BACKUPS" ]]; then
  send_alert "No daily backups found" "No daily backup files exist in s3://$BACKUP_S3_BUCKET/daily/"
else
  # Find the most recent daily backup
  LATEST_BACKUP=$(echo "$DAILY_BACKUPS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
# Filter for .enc files, sort by LastModified
backups = [b for b in data.get('Contents', []) if b['Key'].endswith('.enc')]
if not backups:
    print('')
else:
    latest = max(backups, key=lambda x: x['LastModified'])
    print(latest['Key'])
" 2>/dev/null || echo "")

  if [[ -z "$LATEST_BACKUP" ]]; then
    send_alert "No encrypted daily backups found" "No .enc backup files in s3://$BACKUP_S3_BUCKET/daily/"
  else
    # Check age
    BACKUP_AGE_HOURS=$(echo "$DAILY_BACKUPS" | python3 -c "
import sys, json
from datetime import datetime, timezone
data = json.load(sys.stdin)
backups = [b for b in data.get('Contents', []) if b['Key'].endswith('.enc')]
latest = max(backups, key=lambda x: x['LastModified'])
last_modified = datetime.fromisoformat(latest['LastModified'].replace('Z', '+00:00'))
now = datetime.now(timezone.utc)
age_hours = (now - last_modified).total_seconds() / 3600
print(f'{age_hours:.1f}')
" 2>/dev/null || echo "999")

    log "Latest daily backup: $LATEST_BACKUP"
    log "Backup age: ${BACKUP_AGE_HOURS}h (max: ${BACKUP_MAX_AGE_HOURS}h)"

    if (( $(echo "$BACKUP_AGE_HOURS > $BACKUP_MAX_AGE_HOURS" | bc -l) )); then
      send_alert "Daily backup is stale" \
        "Latest backup ($LATEST_BACKUP) is ${BACKUP_AGE_HOURS}h old (threshold: ${BACKUP_MAX_AGE_HOURS}h)"
    else
      log "OK: Daily backup is within acceptable age"
    fi
  fi
fi

# ── Check 2: Metadata integrity ───────────────────────────────────────────
LATEST_METADATA=$(aws s3 ls "s3://$BACKUP_S3_BUCKET/metadata/" $S3_OPTS 2>/dev/null || echo "[]")

if [[ "$LATEST_METADATA" != "[]" && -n "$LATEST_METADATA" ]]; then
  LATEST_META_KEY=$(echo "$LATEST_METADATA" | python3 -c "
import sys, json
data = json.load(sys.stdin)
metas = [b for b in data.get('Contents', []) if b['Key'].endswith('.json')]
if not metas:
    print('')
else:
    latest = max(metas, key=lambda x: x['LastModified'])
    print(latest['Key'])
" 2>/dev/null || echo "")

  if [[ -n "$LATEST_META_KEY" ]]; then
    METADATA=$(aws s3 cp "s3://$BACKUP_S3_BUCKET/$LATEST_META_KEY" - $S3_OPTS 2>/dev/null || echo "{}")
    log "Latest metadata: $LATEST_META_KEY"

    # Verify the backup referenced in metadata exists
    META_BACKUP_KEY=$(echo "$METADATA" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('s3_key', ''))
" 2>/dev/null || echo "")

    if [[ -n "$META_BACKUP_KEY" ]]; then
      BACKUP_EXISTS=$(aws s3 ls "s3://$BACKUP_S3_BUCKET/$META_BACKUP_KEY" $S3_OPTS 2>/dev/null || echo "[]")
      if [[ "$BACKUP_EXISTS" == "[]" || -z "$BACKUP_EXISTS" ]]; then
        send_alert "Backup referenced in metadata missing" \
          "Metadata $LATEST_META_KEY references s3://$BACKUP_S3_BUCKET/$META_BACKUP_KEY which does not exist"
      else
        log "OK: Backup referenced in metadata exists"
      fi
    fi
  fi
else
  log "WARNING: No backup metadata found"
fi

# ── Check 3: Retention cleanup ────────────────────────────────────────────
log "Checking retention policy..."

# Daily backups older than 30 days
CUTOFF_30D=$(date -u -d "30 days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
             date -u -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

if [[ -n "$CUTOFF_30D" ]]; then
  STALE_DAILY=$(aws s3 ls "s3://$BACKUP_S3_BUCKET/daily/" $S3_OPTS 2>/dev/null || echo "[]")
  if [[ "$STALE_DAILY" != "[]" ]]; then
    STALE_COUNT=$(echo "$STALE_DAILY" | python3 -c "
import sys, json
from datetime import datetime, timezone
data = json.load(sys.stdin)
cutoff = datetime.fromisoformat('$CUTOFF_30D'.replace('Z', '+00:00'))
stale = [b for b in data.get('Contents', [])
         if b['Key'].endswith('.enc') and
         datetime.fromisoformat(b['LastModified'].replace('Z', '+00:00')) < cutoff]
print(len(stale))
for b in stale:
    print(b['Key'], file=sys.stderr)
" 2>&1 || echo "0")

    STALE_COUNT_NUM=$(echo "$STALE_COUNT" | head -1)
    if [[ "$STALE_COUNT_NUM" -gt 0 ]]; then
      log "Found $STALE_COUNT_NUM daily backups older than 30 days"
      # In production, uncomment the following to auto-delete:
      # echo "$STALE_COUNT" | tail -n +2 | while read -r KEY; do
      #   aws s3 rm "s3://$BACKUP_S3_BUCKET/$KEY" $S3_OPTS
      #   log "Deleted stale backup: $KEY"
      # done
    else
      log "OK: No stale daily backups"
    fi
  fi
fi

# ── Check 4: Local log rotation ───────────────────────────────────────────
if [[ -f "$LOG_FILE" ]]; then
  LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat --format=%s "$LOG_FILE" 2>/dev/null || echo "0")
  if [[ "$LOG_SIZE" -gt 10485760 ]]; then
    mv "$LOG_FILE" "${LOG_FILE}.1"
    log "Log rotated (was ${LOG_SIZE} bytes)"
  fi
fi

log "=== Monitoring check complete ==="
