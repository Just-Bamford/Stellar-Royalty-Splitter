# Runbook: Database Locked

## Symptom Detection

### Automated Alerts
- Alert: `DatabaseLocked`
- Condition: SQLite lock timeout errors > 0
- Threshold: > 10 lock errors per minute

### Manual Detection
- Error logs show: `SQLITE_BUSY`, `database is locked`
- API responses: 500 errors with "database locked"
- Slow response times on write operations

## Diagnosis Steps

### Step 1: Check Database Lock Status
```bash
# Check for active locks
lsof /var/data/audit.db

# Check WAL mode
sqlite3 /var/data/audit.db "PRAGMA journal_mode;"

# Check lock timeout settings
sqlite3 /var/data/audit.db "PRAGMA busy_timeout;"
```

### Step 2: Check for Long-Running Transactions
```bash
# Check SQLite processes
ps aux | grep sqlite3

# Check for active transactions
sqlite3 /var/data/audit.db "
SELECT * FROM sqlite_master WHERE type='table';
"
```

### Step 3: Check Backend Processes
```bash
# Check Node.js processes
ps aux | grep node

# Check for process count
pm2 list
```

### Step 4: Check System Resources
```bash
# Check disk space
df -h

# Check memory usage
free -m

# Check I/O wait
iostat -x 1 5
```

### Step 5: Check for WAL Checkpoint Issues
```bash
# Check WAL file size
ls -lh /var/data/audit.db-wal

# Check checkpoint status
sqlite3 /var/data/audit.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

## Recovery Steps

### Option 1: Wait for Lock Release (Recommended)
```bash
# Monitor lock status
watch -n 5 'lsof /var/data/audit.db'

# If lock is held by short transaction, wait 30-60 seconds
```

### Option 2: Kill Blocking Process
```bash
# Find process holding lock
lsof /var/data/audit.db

# Kill the process (use with caution!)
kill -9 <PID>

# Restart backend
pm2 restart royalty-api
```

### Option 3: Force WAL Checkpoint
```bash
# Stop backend temporarily
pm2 stop royalty-api

# Force checkpoint
sqlite3 /var/data/audit.db "PRAGMA wal_checkpoint(TRUNCATE);"

# Restart backend
pm2 start royalty-api
```

### Option 4: Delete WAL/SHM Files (Last Resort)
```bash
# Stop backend
pm2 stop royalty-api

# Remove lock files
rm -f /var/data/audit.db-wal
rm -f /var/data/audit.db-shm

# Verify database integrity
sqlite3 /var/data/audit.db "PRAGMA integrity_check;"

# Restart backend
pm2 start royalty-api
```

### Option 5: Database Recovery
```bash
# If database is corrupted
pm2 stop royalty-api

# Backup current database
cp /var/data/audit.db /var/data/audit.db.backup

# Restore from backup
cp /backups/audit.db.latest /var/data/audit.db

# Verify integrity
sqlite3 /var/data/audit.db "PRAGMA integrity_check;"

# Restart
pm2 start royalty-api
```

## Verification Steps

### Step 1: Verify Database Integrity
```bash
sqlite3 /var/data/audit.db "PRAGMA integrity_check;"
# Expected: ok
```

### Step 2: Verify WAL Mode
```bash
sqlite3 /var/data/audit.db "PRAGMA journal_mode;"
# Expected: wal
```

### Step 3: Test Write Operations
```bash
curl -s -X POST http://localhost:3001/api/v1/test-write \
  -H "Content-Type: application/json" \
  -d '{"test":"data"}' | jq .
```

### Step 4: Monitor Lock Errors
```bash
# Watch for 5 minutes
watch -n 30 'pm2 logs royalty-api --lines 10 | grep -i "lock\|busy"'
```

## Prevention

### Configuration
```sql
-- Set busy timeout (5 seconds)
PRAGMA busy_timeout = 5000;

-- Enable WAL mode
PRAGMA journal_mode = WAL;

-- Set cache size (64MB)
PRAGMA cache_size = -65536;
```

### Best Practices
- Use connection pooling
- Keep transactions short
- Avoid long-running reads
- Monitor WAL file size
- Regular VACUUM operations

## Time Estimates

| Step | Time |
|------|------|
| Diagnosis | 5-10 minutes |
| Recovery (Option 1) | 1-5 minutes |
| Recovery (Option 2) | 5-10 minutes |
| Recovery (Option 3) | 10-15 minutes |
| Recovery (Option 4) | 15-30 minutes |
| Recovery (Option 5) | 30-60 minutes |
| Verification | 5-10 minutes |

## Related Runbooks

- [High Error Rate](./high-error-rate.md)
- [Memory Leak](./memory-leak.md)
- [RPC Down](./rpc-down.md)
