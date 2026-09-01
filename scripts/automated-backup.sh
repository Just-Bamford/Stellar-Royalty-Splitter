#!/usr/bin/env bash
# automated-backup.sh — Create timestamped, encrypted backups of the Stellar Royalty
# audit database and upload to S3-compatible storage.
#
# Usage:
#   ./scripts/automated-backup.sh [--type daily|weekly|monthly] [--dry-run]
#
# Environment variables:
#   DATABASE_PATH          Path to the SQLite database (default: backend/audit.db)
#   BACKUP_S3_BUCKET       S3 bucket name (default: stellar-royalty-backups)
#   BACKUP_S3_REGION       AWS region (default: us-east-1)
#   BACKUP_S3_ENDPOINT     S3 endpoint URL (for MinIO, etc.)
#   BACKUP_ENCRYPTION_KEY  Encryption passphrase (must be set)
#   BACKUP_DIR             Local staging directory (default: /tmp/stellar-backup)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
BACKUP_TYPE="daily"
DRY_RUN=false
DATABASE_PATH="${DATABASE_PATH:-$REPO_ROOT/backend/audit.db}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-stellar-royalty-backups}"
BACKUP_S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/stellar-backup}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DATE_SHORT="$(date -u +%Y-%m-%d)"
LOG_FILE="${BACKUP_DIR}/backup.log"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      BACKUP_TYPE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

die() {
  log "FATAL: $1"
  exit 1
}

# Validate
if [[ "$BACKUP_TYPE" != "daily" && "$BACKUP_TYPE" != "weekly" && "$BACKUP_TYPE" != "monthly" ]]; then
  die "Invalid backup type: $BACKUP_TYPE (must be daily, weekly, or monthly)"
fi

if [[ ! -f "$DATABASE_PATH" ]]; then
  die "Database file not found: $DATABASE_PATH"
fi

if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
  die "BACKUP_ENCRYPTION_KEY environment variable is not set"
fi

mkdir -p "$BACKUP_DIR"

log "=== Starting $BACKUP_TYPE backup ==="
log "Database: $DATABASE_PATH"
log "Timestamp: $TIMESTAMP"

# Step 1: Checkpoint WAL
log "Step 1/6: Checkpointing WAL..."
sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" || log "WARNING: WAL checkpoint returned non-zero (may be ok)"

# Step 2: Create backup using SQLite .backup
BACKUP_NAME="stellar-royalty-backup-${BACKUP_TYPE}-${DATE_SHORT}"
UNENCRYPTED_FILE="$BACKUP_DIR/$BACKUP_NAME.db"
ENCRYPTED_FILE="$BACKUP_DIR/${UNENCRYPTED_FILE##*/}.tar.gz.enc"

log "Step 2/6: Creating backup snapshot..."
sqlite3 "$DATABASE_PATH" ".backup '$UNENCRYPTED_FILE'"

if [[ ! -f "$UNENCRYPTED_FILE" ]]; then
  die "Backup file was not created: $UNENCRYPTED_FILE"
fi

BACKUP_SIZE=$(stat -f%z "$UNENCRYPTED_FILE" 2>/dev/null || stat --format=%s "$UNENCRYPTED_FILE" 2>/dev/null)
log "Backup size: $BACKUP_SIZE bytes"

# Step 3: Compute checksum
log "Step 3/6: Computing SHA-256 checksum..."
SHA256=$(shasum -a 256 "$UNENCRYPTED_FILE" | awk '{print $1}')
log "SHA-256: $SHA256"

# Step 4: Encrypt
log "Step 4/6: Encrypting backup (AES-256-GCM)..."
if command -v openssl &>/dev/null; then
  # Create tar.gz first for smaller encrypted payload
  tar -czf - -C "$BACKUP_DIR" "$BACKUP_NAME.db" | \
    openssl enc -aes-256-gcm -salt -pbkdf2 -iter 100000 \
    -pass "pass:$BACKUP_ENCRYPTION_KEY" \
    -out "$ENCRYPTED_FILE"
else
  die "openssl is required for encryption"
fi

ENCRYPTED_SIZE=$(stat -f%z "$ENCRYPTED_FILE" 2>/dev/null || stat --format=%s "$ENCRYPTED_FILE" 2>/dev/null)
log "Encrypted size: $ENCRYPTED_SIZE bytes"

# Step 5: Upload to S3
log "Step 5/6: Uploading to S3..."
S3_DEST="s3://$BACKUP_S3_BUCKET/$BACKUP_TYPE/$BACKUP_NAME.db.tar.gz.enc"
S3_META_DEST="s3://$BACKUP_S3_BUCKET/metadata/$BACKUP_NAME.json"

if [[ "$DRY_RUN" == "true" ]]; then
  log "[DRY RUN] Would upload to: $S3_DEST"
else
  S3_OPTS="--region $BACKUP_S3_REGION"
  if [[ -n "$BACKUP_S3_ENDPOINT" ]]; then
    S3_OPTS="$S3_OPTS --endpoint-url $BACKUP_S3_ENDPOINT"
  fi

  aws s3 cp "$ENCRYPTED_FILE" "$S3_DEST" $S3_OPTS \
    --storage-class STANDARD \
    --metadata "sha256=$SHA256,type=$BACKUP_TYPE,timestamp=$TIMESTAMP" \
    || die "Failed to upload to S3: $S3_DEST"

  # Step 5b: Upload metadata
  cat > "$BACKUP_DIR/metadata.json" <<EOF
{
  "backup_name": "$BACKUP_NAME",
  "type": "$BACKUP_TYPE",
  "timestamp": "$TIMESTAMP",
  "database_path": "$DATABASE_PATH",
  "sha256": "$SHA256",
  "original_size": $BACKUP_SIZE,
  "encrypted_size": $ENCRYPTED_SIZE,
  "s3_key": "$BACKUP_TYPE/$BACKUP_NAME.db.tar.gz.enc"
}
EOF

  aws s3 cp "$BACKUP_DIR/metadata.json" "$S3_META_DEST" $S3_OPTS \
    || log "WARNING: Failed to upload metadata (backup is safe)"
fi

# Step 6: Cleanup local files
log "Step 6/6: Cleaning up local files..."
rm -f "$UNENCRYPTED_FILE"
rm -f "$ENCRYPTED_FILE"
rm -f "$BACKUP_DIR/metadata.json"

log "=== Backup complete: $BACKUP_NAME ==="
log "  Type:     $BACKUP_TYPE"
log "  Size:     $BACKUP_SIZE bytes"
log "  SHA-256:  $SHA256"
log "  S3:       $S3_DEST"
