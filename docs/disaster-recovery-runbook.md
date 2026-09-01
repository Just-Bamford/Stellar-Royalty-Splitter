# Disaster Recovery Runbook — database restore

Step-by-step procedures for recovering the Stellar Royalty Splitter audit database
from backup.

> **During an incident, start at
> [`DISASTER_RECOVERY_RUNBOOK.md`](DISASTER_RECOVERY_RUNBOOK.md)** — it covers
> triage across all failure modes (infrastructure loss, dependency outages,
> configuration loss, bad deployments) and links back here for the database
> restore detail below.
>
> These procedures are exercised automatically by
> [`infra/disaster-recovery-test.sh`](../infra/disaster-recovery-test.sh).

---

## Prerequisites

Before executing any recovery procedure, ensure you have:

| Requirement | Details |
|-------------|---------|
| **Access** | SSH access to the production server or CI/CD environment |
| **Credentials** | Backup decryption key (from secrets manager) |
| **S3 access** | AWS credentials with read access to `BACKUP_S3_BUCKET` |
| **Tools** | `sqlite3`, `openssl`, `aws-cli` (or MinIO `mc` client) |
| **Disk space** | At least 2x the database size free on the target volume |
| **Downtime window** | Confirm the backend service can be restarted (RTO < 1 hour) |

---

## Procedure 1: Restore from Daily Backup

Use this when the database is corrupted, lost, or needs to be rolled back.

### Step 1: Stop the Backend Service

```bash
# If running as a systemd service
sudo systemctl stop stellar-royalty-backend

# If running in Docker
docker compose stop backend
```

### Step 2: Identify the Backup to Restore

```bash
# List available backups in the S3 bucket
aws s3 ls s3://stellar-royalty-backups/daily/ --recursive | sort -k 4

# Or for MinIO
mc ls remote/stellar-royalty-backups/daily/
```

Choose the most recent backup before the incident occurred.

### Step 3: Download the Backup

```bash
BACKUP_FILE="stellar-royalty-backup-daily-2026-07-27.tar.gz.enc"
BACKUP_DIR="/tmp/stellar-recovery"
mkdir -p "$BACKUP_DIR"

aws s3 cp "s3://stellar-royalty-backups/daily/$BACKUP_FILE" "$BACKUP_DIR/"
```

### Step 4: Decrypt the Backup

```bash
# Retrieve the encryption key from the secrets manager
ENCRYPTION_KEY=$(python3 -c "
import json, os
secrets = json.load(open(os.path.expanduser('~/.config/stellar/secrets.json')))
print(secrets['backup_encryption_key_2026_Q3'])
")

# Decrypt
openssl enc -aes-256-gcm -d \
  -in "$BACKUP_DIR/$BACKUP_FILE" \
  -out "$BACKUP_DIR/audit.db" \
  -pass "pass:$ENCRYPTION_KEY"
```

### Step 5: Verify Backup Integrity

```bash
# Check SHA-256 checksum
sha256sum "$BACKUP_DIR/audit.db"

# Compare against the checksum stored in backup metadata
aws s3 cp "s3://stellar-royalty-backups/metadata/$(basename $BACKUP_FILE .enc).json" "$BACKUP_DIR/"
cat "$BACKUP_DIR/$(basename $BACKUP_FILE .enc).json" | python3 -c "
import json, sys
meta = json.load(sys.stdin)
print(f'Expected: {meta[\"sha256\"]}')
"

# Run SQLite integrity check
sqlite3 "$BACKUP_DIR/audit.db" "PRAGMA integrity_check;"
# Should return: ok

# List tables to verify schema
sqlite3 "$BACKUP_DIR/audit.db" ".tables"
# Expected: audit_log  distribution_payouts  secondary_royalty_distributions
#           secondary_sales  schema_migrations  transactions

# Check row counts
sqlite3 "$BACKUP_DIR/audit.db" "
SELECT 'transactions' as tbl, COUNT(*) as rows FROM transactions
UNION ALL
SELECT 'distribution_payouts', COUNT(*) FROM distribution_payouts
UNION ALL
SELECT 'secondary_sales', COUNT(*) FROM secondary_sales
UNION ALL
SELECT 'secondary_royalty_distributions', COUNT(*) FROM secondary_royalty_distributions
UNION ALL
SELECT 'audit_log', COUNT(*) FROM audit_log;
"
```

### Step 6: Back Up Current Database (If Intact)

```bash
# Preserve the current database for analysis
cp "$DATABASE_PATH" "$BACKUP_DIR/pre-recovery-$(date +%Y%m%d-%H%M%S).db"
```

### Step 7: Replace the Database

```bash
DATABASE_PATH="${DATABASE_PATH:-backend/audit.db}"

# Replace
cp "$BACKUP_DIR/audit.db" "$DATABASE_PATH"

# Ensure correct ownership and permissions
chown stellar-royalty:stellar-royalty "$DATABASE_PATH"
chmod 640 "$DATABASE_PATH"
```

### Step 8: Start the Backend Service

```bash
# If running as a systemd service
sudo systemctl start stellar-royalty-backend

# If running in Docker
docker compose start backend
```

### Step 9: Post-Restore Verification

```bash
# Health check
curl -s http://localhost:3000/health | python3 -m json.tool

# Verify transaction data is accessible (replace CONTRACT_ID)
curl -s "http://localhost:3000/api/contracts/CONTRACT_ID/transactions?limit=5" | python3 -m json.tool

# Check backend logs for errors
tail -50 /var/log/stellar-royalty/backend.log | grep -i error

# Run the backend test suite
cd backend && npm test
```

### Step 10: Clean Up

```bash
rm -rf "$BACKUP_DIR"
```

---

## Procedure 2: Restore from Weekly/Monthly Backup

Same as Procedure 1, but change the S3 path:

```bash
# Weekly
aws s3 ls s3://stellar-royalty-backups/weekly/

# Monthly
aws s3 ls s3://stellar-royalty-backups/monthly/
```

---

## Rollback Procedure

If the restored backup is incorrect or the restore failed:

1. **Stop the service** if running
2. **Restore the pre-recovery snapshot** taken in Step 6:
   ```bash
   cp "$BACKUP_DIR/pre-recovery-*.db" "$DATABASE_PATH"
   ```
3. **Restart the service**
4. **Investigate** — check logs, determine root cause, and attempt restore again or escalate

---

## Post-Incident Checklist

After any disaster recovery event:

- [ ] Database restored and verified
- [ ] Backend service running and healthy
- [ ] Transaction data accessible via API
- [ ] No errors in backend logs
- [ ] Test suite passes
- [ ] Root cause documented
- [ ] Incident report filed
- [ ] Backup schedule confirmed operational
- [ ] Alert system confirmed working (was the failure detected automatically?)

---

## Contact

| Role | Responsibility |
|------|---------------|
| **On-call engineer** | First responder — executes recovery |
| **Database lead** | Verifies data integrity post-restore |
| **Platform lead** | Infrastructure and storage issues |
| **Engineering lead** | Incident authority and communication |
