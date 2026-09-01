# Operator Runbook — #610

Step-by-step procedures for operating the Stellar Royalty Splitter system.

---

## Table of Contents

1. [Deployment](#1-deployment)
2. [Rollback](#2-rollback)
3. [Recovery](#3-recovery)
4. [Common Troubleshooting](#4-common-troubleshooting)
5. [Command Reference](#5-command-reference)
6. [Incident Decision Trees](#6-incident-decision-trees)
7. [Monitoring and Alerting Guide](#7-monitoring-and-alerting-guide)
8. [Snapshot Backup Procedure](#8-snapshot-backup-procedure)

---

## 1. Deployment

### Prerequisites
- Node.js 18+ installed
- PostgreSQL or SQLite (SQLite default)
- Access to Stellar network (testnet/mainnet)
- Environment variables configured (see `.env.example`)

### Deploy Backend

```bash
# 1. Install dependencies
cd backend && npm ci --production

# 2. Set environment variables
export NODE_ENV=production
export DATABASE_PATH=/var/data/audit.db
export STELLAR_NETWORK=TESTNET
export FRONTEND_ORIGIN=https://app.example.com
export ADMIN_ROTATE_TOKEN=<secure-random-token>

# 3. Run database migrations
node src/index.js --migrate

# 4. Start the API server (recommended: use process manager)
pm2 start src/index.js --name royalty-api -i max

# 5. Verify deployment
curl http://localhost:3001/api/v1/health
```

### Deploy Frontend
```bash
cd frontend
npm ci
npm run build
# Serve dist/ via nginx or upload to CDN
```

### Verify Deployment
```bash
# Health check
curl -s http://localhost:3001/api/v1/health | jq .

# Contract status
curl -s http://localhost:3001/api/v1/snapshots/all | jq '.data | length'
```

---

## 2. Rollback

### Database Rollback
```bash
# 1. Stop the API
pm2 stop royalty-api

# 2. Restore database from backup
cp /backups/audit.db.2024-01-01 /var/data/audit.db

# 3. Restart the API
pm2 start royalty-api
```

### Application Rollback
```bash
# Using git
git checkout <previous-stable-tag>
cd backend && npm ci --production
pm2 restart royalty-api

# Using npm/pnpm
# Point symlink to previous release
ln -sfn /releases/v1.2.3 /app/current
pm2 restart royalty-api
```

### Snapshot-Based Recovery
```bash
# 1. List available snapshots
curl -s http://localhost:3001/api/v1/snapshots/<contractId> | jq .

# 2. Verify snapshot integrity
curl -s -X POST http://localhost:3001/api/v1/snapshots/<contractId>/verify/<snapshotId>

# 3. Restore contract state from snapshot
# (Use admin API to reinitialize contract with snapshot data)
```

---

## 3. Recovery

### Database Corruption Recovery
```bash
# 1. Stop the API
pm2 stop royalty-api

# 2. Run integrity check
sqlite3 /var/data/audit.db "PRAGMA integrity_check;"

# 3. If corrupted, restore from latest snapshot
sqlite3 /var/data/audit.db ".restore /backups/audit.db.clean"

# 4. Verify and restart
sqlite3 /var/data/audit.db "SELECT COUNT(*) FROM transactions;"
pm2 start royalty-api
```

### Stellar Network Issues
```bash
# 1. Check network status
curl -s https://horizon-testnet.stellar.org/ | jq .core_version

# 2. Verify RPC endpoint
curl -s -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq .

# 3. Check API logs for Soroban errors
pm2 logs royalty-api --lines 100 | grep -i "soroban\|stellar"
```

---

## 4. Common Troubleshooting

### API Won't Start

| Symptom | Cause | Solution |
|---------|-------|----------|
| Port in use | Another process on 3001 | `lsof -i :3001` then `kill` process |
| DB locked | Previous crash | Delete `audit.db-wal` and `audit.db-shm` |
| Signing key error | Missing env vars | Check `SIGNING_KEY_FILE` or `SECRETS_PROVIDER` |
| CORS errors | Misconfigured origin | Verify `FRONTEND_ORIGIN` env var |

### Slow Responses

```bash
# Check database performance
sqlite3 /var/data/audit.db "PRAGMA query_only = 0;"

# Check for long-running queries
pm2 logs royalty-api | grep "duration"

# Run VACUUM to optimize database
sqlite3 /var/data/audit.db "VACUUM;"
```

### Debugging with Correlation IDs

The API generates a unique Correlation ID for every request to trace it across the system. This ID is included in:
1. The HTTP response headers (`X-Correlation-ID`)
2. All backend logs associated with that request
3. Frontend error messages

When a user reports an issue, ask them for the Correlation ID displayed in the error message (or network tab). You can then trace the exact request flow in the logs:

```bash
# Search logs for a specific request
pm2 logs royalty-api | grep "<correlation-id>"
# For JSON logs, search for the correlationId field
```

### Snapshot Job Failures

```bash
# Check snapshot scheduler status
curl -s http://localhost:3001/api/v1/snapshots/scheduler-status

# Manually trigger a snapshot run
curl -s http://localhost:3001/api/v1/snapshots/run

# Verify snapshot integrity
curl -s -X POST http://localhost:3001/api/v1/snapshots/<contractId>/verify/<snapshotId> | jq .
```

---

## 5. Command Reference

### Database Commands

```bash
# Backup database
sqlite3 /var/data/audit.db ".backup /backups/audit.db.$(date +%Y%m%d)"

# Check database size
ls -lh /var/data/audit.db

# Run database analysis
sqlite3 /var/data/audit.db "ANALYZE;"

# View table statistics
sqlite3 /var/data/audit.db "SELECT name, rows FROM sqlite_master WHERE type='table';"

# Query snapshot count
sqlite3 /var/data/audit.db "SELECT contractId, COUNT(*) FROM contract_snapshots GROUP BY contractId;"

# Query communication history
sqlite3 /var/data/audit.db "SELECT walletAddress, type, COUNT(*) FROM contributor_communications GROUP BY walletAddress, type;"
```

### API Commands

```bash
# Health check
curl http://localhost:3001/api/v1/health

# List snapshots for a contract
curl http://localhost:3001/api/v1/snapshots/<contractId>

# Create a snapshot
curl -X POST http://localhost:3001/api/v1/snapshots/<contractId> \
  -H "Content-Type: application/json" \
  -d '{"label":"pre-upgrade-snapshot","createdBy":"operator"}'

# Verify snapshot integrity
curl -X POST http://localhost:3001/api/v1/snapshots/<contractId>/verify/<snapshotId>

# Get communication timeline
curl http://localhost:3001/api/v1/communications/timeline/<walletAddress>

# Search communications
curl -X POST http://localhost:3001/api/v1/communications/search \
  -H "Content-Type: application/json" \
  -d '{"query":"payment issue"}'
```

### Load Testing Commands

```bash
# Run normal load test
k6 run backend/load-testing/scenarios/normal-load.js

# Run spike test
k6 run backend/load-testing/scenarios/spike-test.js

# Run sustained load test
k6 run backend/load-testing/scenarios/sustained-load.js

# Generate performance report
k6 run backend/load-testing/scenarios/normal-load.js \
  --out json=backend/load-testing/reports/report.json
```

---

## 6. Incident Decision Trees

### API Down

```
Is the API process running?
├── Yes → Check logs: pm2 logs royalty-api --lines 50
│   ├── Database error → Follow database recovery
│   ├── Port conflict → Kill conflicting process
│   └── Memory issue → Increase instance memory
└── No → Start: pm2 start royalty-api
    ├── Starts successfully → Verify: curl /api/v1/health
    └── Fails to start → Check system resources
        ├── Out of disk → Clean logs, prune database
        └── Config error → Validate .env configuration
```

### Database Corruption

```
Run integrity check: sqlite3 audit.db "PRAGMA integrity_check;"
├── "ok" → Check application logs for other issues
└── Errors found
    ├── Backup exists → Restore from backup
    │   ├── Restore successful → Restart API
    │   └── Restore fails → Escalate to engineering
    └── No backup → Use snapshot recovery
        ├── Snapshots available → Reinitialize from snapshot
        └── No snapshots → Escalate immediately
```

### Slow Performance

```
Check metrics endpoint: curl /api/v1/metrics
├── High response times
│   ├── Check database size: ls -lh audit.db
│   ├── Run VACUUM: sqlite3 audit.db "VACUUM;"
│   └── Check for long queries: pm2 logs | grep "duration"
├── High memory usage
│   ├── Restart API: pm2 restart royalty-api
│   └── Consider scaling: increase instances
└── Normal metrics → Check network latency
    ├── Stellar RPC slow → Switch to backup RPC
    └── DNS issues → Verify DNS resolution
```

### Snapshot Verification Failure

```
Run integrity check: curl -X POST /api/v1/snapshots/<cid>/verify/<sid>
├── valid: true → Data integrity verified, continue monitoring
└── valid: false
    ├── Create new snapshot immediately
    ├── Investigate what changed between snapshots
    └── Alert engineering team for root cause analysis
```

---

## 7. Monitoring and Alerting Guide

### Key Metrics

| Metric | Threshold | Action |
|--------|-----------|--------|
| HTTP 5xx rate | > 1% | Investigate API errors |
| Response time P95 | > 2s | Check database performance |
| Database size | > 1GB | Run VACUUM, consider archiving |
| Snapshot failures | > 0 | Check snapshot scheduler |
| Communication errors | > 0 | Check email/notification services |
| Active users | > threshold | Consider scaling |

### Prometheus/Grafana Setup

```yaml
# prometheus.yml scrape config
scrape_configs:
  - job_name: 'royalty-api'
    static_configs:
      - targets: ['localhost:3001']
    metrics_path: '/metrics'
```

### Alert Rules

```yaml
groups:
  - name: royalty-alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.01
        for: 5m
        annotations:
          summary: "High HTTP error rate detected"

      - alert: SnapshotJobFailure
        expr: snapshot_job_failures > 0
        for: 1m
        annotations:
          summary: "Snapshot job failed"

      - alert: DatabaseGrowth
        expr: database_size_bytes > 1e9
        for: 1h
        annotations:
          summary: "Database size exceeded 1GB"
```

---

## 8. Snapshot Backup Procedure

### Automated Snapshots

Snapshots are created automatically by the scheduler (default: every 24 hours).

```bash
# Configure snapshot interval (in milliseconds)
export SNAPSHOT_INTERVAL_MS=86400000  # 24 hours

# Configure retention (keep last N snapshots)
export SNAPSHOT_RETENTION_COUNT=90

# Verify scheduler is running
curl http://localhost:3001/api/v1/snapshots/scheduler-status
```

### Manual Snapshots

```bash
# Create a snapshot before making changes
curl -X POST http://localhost:3001/api/v1/snapshots/<contractId> \
  -H "Content-Type: application/json" \
  -H "x-api-key: <admin-key>" \
  -d '{"label":"pre-upgrade-checkpoint","createdBy":"operator"}'

# Verify the snapshot
curl http://localhost:3001/api/v1/snapshots/<contractId>/<snapshotId>

# Verify integrity
curl -X POST http://localhost:3001/api/v1/snapshots/<contractId>/verify/<snapshotId>
```

### Snapshot Pruning

```bash
# Prune old snapshots (keep most recent 30)
curl -X DELETE "http://localhost:3001/api/v1/snapshots/<contractId>/prune?keep=30" \
  -H "x-api-key: <admin-key>"
```

### Compliance Reporting

Snapshots are included in compliance reports:

```bash
# Get all snapshots for compliance
curl http://localhost:3001/api/v1/snapshots/all \
  -H "x-api-key: <admin-key>" | jq '.data[] | {id, contractId, label, createdAt, stateHash}'
```

---

## Quick Reference Card

```bash
# Health
curl /api/v1/health

# Database backup
sqlite3 audit.db ".backup /backups/daily/audit.db.$(date +%Y%m%d)"

# Manual snapshot
curl -X POST /api/v1/snapshots/<contractId> \
  -H "Content-Type: application/json" \
  -d '{"label":"manual-backup"}'

# Verify snapshot
curl -X POST /api/v1/snapshots/<contractId>/verify/<snapshotId>

# View communication timeline
curl /api/v1/communications/timeline/<walletAddress>

# Search communications
curl -X POST /api/v1/communications/search \
  -H "Content-Type: application/json" \
  -d '{"query":"refund"}'

# Load test
k6 run backend/load-testing/scenarios/normal-load.js

# Restart API
pm2 restart royalty-api

# Check logs
pm2 logs royalty-api --lines 100

# Database integrity
sqlite3 audit.db "PRAGMA integrity_check;"