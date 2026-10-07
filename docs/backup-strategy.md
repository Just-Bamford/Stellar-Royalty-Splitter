# Database Backup Strategy

This document defines the backup and recovery strategy for the Stellar Royalty Splitter
audit database (`audit.db`).

---

## 1. Overview

The backend uses **SQLite** (`better-sqlite3`) with WAL (Write-Ahead Logging) mode enabled.
The database stores:

- **transactions** — on-chain transaction records and status
- **distribution_payouts** — per-collaborator payout breakdowns
- **secondary_sales** — secondary market sale records
- **secondary_royalty_distributions** — aggregated royalty distribution records
- **audit_log** — immutable audit trail of all actions

Because this data is derived from on-chain state it can be reconstructed from the Stellar
ledger, but the audit trail and operational metadata are unique to this database and
**must be preserved**.

---

## 2. Recovery Objectives

| Metric | Target | How it is achieved | How it is verified |
|--------|--------|--------------------|--------------------|
| **RPO** (Recovery Point Objective) | **< 15 minutes** | Encrypted point-in-time snapshot every 15 minutes (`backup-manager.js backup --type pitr`) | Freshness alarm when the newest snapshot is > 20 min old; the weekly recovery test fails if any gap between snapshots in the last 24h exceeded 20 min |
| **RTO** (Recovery Time Objective) | **< 1 hour** | Scripted restore: download → decrypt → verify → install → restart (`infra/recovery-test.sh`) | The weekly recovery test times the whole procedure, service restart included, and fails (and alarms) above 3600s |

The 5-minute grace on the RPO checks absorbs scheduling jitter; a snapshot
that is merely a few minutes late does not page, one that is missed does.

### 2a. Automated backups and recovery testing (#937)

`infra/backup-manager.js` supersedes `scripts/automated-backup.sh`, whose
`openssl enc -aes-256-gcm` call is rejected by OpenSSL ("AEAD ciphers not
supported") so it never produced a restorable archive. The manager:

- snapshots every configured database (the application DB **and** the
  immutable audit trail, `audit-trail.db`) with SQLite's online backup API —
  consistent while the API is writing, WAL included;
- encrypts with AES-256-GCM (scrypt-derived key from `BACKUP_ENCRYPTION_KEY`),
  so every restore authenticates the archive before trusting it;
- records row counts and a SHA-256 checksum of every table in a manifest,
  uploaded last — a manifest's existence means the backup is complete;
- uploads to the versioned, KMS-encrypted backup bucket (`daily/`, `pitr/`, `manifests/`).

| Job | Schedule | Command |
|-----|----------|---------|
| PITR snapshot | every 15 min | `node infra/backup-manager.js backup --type pitr` |
| Daily backup | 02:00 UTC | `node infra/backup-manager.js backup --type daily` |
| Freshness check | every 15 min | `node infra/backup-manager.js check-freshness` (alerts if daily > 24h or PITR > 20 min) |
| Recovery test | Sundays 04:00 UTC, on **staging** | `RECOVERY_ENVIRONMENT=staging infra/recovery-test.sh --install` |

The schedules and their CloudWatch alarms are defined in
`infra/terraform/backup.tf` (EventBridge → SSM Run Command). The recovery test
restores the newest backup into staging, checks `PRAGMA integrity_check`, row
counts and per-table checksums against the manifest, restarts the staging API
on the restored data, waits for `/health`, and records RPO/RTO. Any failure
exits non-zero, posts to `BACKUP_ALERT_WEBHOOK`, and trips the
`recovery-test-failed` alarm; a week with no successful test trips
`recovery-test-missing`.

**On-demand recovery** (production, operator-led — stop the API first):

```bash
node infra/backup-manager.js restore --latest --target-dir /tmp/restore          # verify only
node infra/backup-manager.js restore --latest --target-dir /tmp/restore --install --force
```

`--install` refuses a restore that failed verification and keeps the replaced
files as `*.pre-restore-<timestamp>`.

---

## 3. Backup Schedule

### 3a. Daily Backups

- **Frequency**: Every day at 02:00 UTC
- **Method**: `sqlite3 .backup` or file-level copy while holding a WAL checkpoint
- **Retention**: 30 days
- **Storage**: Encrypted and uploaded to remote storage (S3-compatible bucket)

### 3b. Weekly Backups

- **Frequency**: Every Sunday at 03:00 UTC
- **Retention**: 12 weeks (3 months)
- **Storage**: Same encrypted remote storage

### 3c. Monthly Backups

- **Frequency**: 1st of each month at 04:00 UTC
- **Retention**: 12 months (1 year)
- **Storage**: Same encrypted remote storage with additional archive tier

---

## 4. Backup Process

Backups are performed using the `scripts/automated-backup.sh` script which:

1. **Checkpoints the WAL** — runs `PRAGMA wal_checkpoint(TRUNCATE)` to flush pending writes
2. **Copies the database** — uses the SQLite `.backup` API (via `sqlite3`) for a consistent snapshot
3. **Computes a checksum** — SHA-256 hash of the backup file
4. **Encrypts the backup** — AES-256-GCM encryption using a key stored in the secrets manager
5. **Uploads to remote storage** — pushes to the configured S3-compatible bucket
6. **Logs metadata** — records backup filename, size, checksum, and timestamp

### Database Path

The default database path is `backend/audit.db`. This can be overridden via the
`DATABASE_PATH` environment variable (see `backend/src/database.js:7`).

---

## 5. Encryption

All backups are encrypted at rest using **AES-256-GCM**:

- **Key management**: Encryption keys are stored in the project's secrets manager
  (`backend/src/secrets-manager.js`). Rotate keys quarterly.
- **Key rotation**: New keys are generated before each quarterly rotation. Old backups
  remain decryptable with previous keys until they are purged per retention policy.
- **Local encryption**: Encryption happens on the backup host before upload — the
  plaintext backup is never written to persistent storage unencrypted.

---

## 6. Remote Storage

Backups are stored in a **S3-compatible bucket** with the following configuration:

| Setting | Value |
|---------|-------|
| Bucket | `stellar-royalty-backups` (configurable via `BACKUP_S3_BUCKET`) |
| Region | `us-east-1` (configurable via `BACKUP_S3_REGION`) |
| Storage class | Standard (daily), Infrequent Access (weekly), Glacier (monthly) |
| Versioning | Enabled — prevents accidental overwrites |
| Server-side encryption | AES-256 (SSE-S3) as defense-in-depth |
| Lifecycle rules | Auto-transition daily backups to Infrequent Access after 7 days; to Glacier after 30 days; delete after retention expires |

### Required Environment Variables

```bash
BACKUP_S3_BUCKET=stellar-royalty-backups
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ENDPOINT=https://s3.amazonaws.com   # or MinIO endpoint
BACKUP_ENCRYPTION_KEY_ID=backup-key-2026-Q3
DATABASE_PATH=backend/audit.db
```

---

## 7. Retention Policy

| Backup Type | Retention | Total Stored |
|-------------|-----------|--------------|
| Daily | 30 days | 30 |
| Weekly | 12 weeks | 12 |
| Monthly | 12 months | 12 |

Backups older than their retention period are automatically deleted by the monitoring
script (`scripts/backup-monitoring.sh`) and by S3 lifecycle rules.

---

## 8. Monitoring and Alerting

The `scripts/backup-monitoring.sh` script runs hourly and checks:

1. **Recency**: Is the most recent backup within the expected timeframe (< 25 hours)?
2. **Integrity**: Does the SHA-256 checksum match?
3. **Size**: Is the backup file within a reasonable size range (not truncated/corrupt)?
4. **Retention**: Are expired backups being cleaned up?

Alerts are sent to the configured notification endpoint (email, Slack webhook, etc.)
when:

- No backup exists within the last 25 hours (daily backup missing)
- Checksum mismatch detected
- Backup size is zero or unexpectedly small
- Remote storage upload failed

Logs are written to `logs/backup-monitor.log` with rotation (14-day retention).

---

## 9. Cron Configuration

Add the following entries to the system crontab or a container scheduler:

```cron
# Daily backup at 02:00 UTC
0 2 * * * /path/to/scripts/automated-backup.sh --type daily >> /var/log/stellar-backup.log 2>&1

# Weekly backup on Sundays at 03:00 UTC
0 3 * * 0 /path/to/scripts/automated-backup.sh --type weekly >> /var/log/stellar-backup.log 2>&1

# Monthly backup on the 1st at 04:00 UTC
0 4 1 * * /path/to/scripts/automated-backup.sh --type monthly >> /var/log/stellar-backup.log 2>&1

# Backup monitoring every hour
0 * * * * /path/to/scripts/backup-monitoring.sh >> /var/log/stellar-backup-monitor.log 2>&1
```

---

## 10. Testing Backups

Backups should be tested end-to-end at least **monthly**:

1. Restore a backup to an isolated environment
2. Run `sqlite3 audit.db "PRAGMA integrity_check"` to verify database integrity
3. Verify all tables exist and contain expected data
4. Run the backend test suite against the restored database
5. Document results in the operations log

---

## 11. Disaster Recovery

For full disaster recovery procedures, see [disaster-recovery-runbook.md](./disaster-recovery-runbook.md).
