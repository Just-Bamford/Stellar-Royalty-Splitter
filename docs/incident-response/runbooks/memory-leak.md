# Runbook: Memory Leak

## Symptom Detection

### Automated Alerts
- Alert: `MemoryLeak`
- Condition: Memory usage > 80% for 10 minutes
- Threshold: Memory growth > 10% per hour

### Manual Detection
- System becoming slow/unresponsive
- Process being killed by OOM killer
- PM2 restarting due to memory limits

## Diagnosis Steps

### Step 1: Check Memory Usage
```bash
# Check system memory
free -m

# Check Node.js process memory
pm2 list

# Check detailed memory stats
pm2 show royalty-api
```

### Step 2: Check for Memory Growth
```bash
# Monitor memory over time
watch -n 30 'pm2 show royalty-api | grep "memory"'

# Check memory history
pm2 logs royalty-api --lines 100 | grep -i "memory\|heap\|gc"
```

### Step 3: Check for Process Count
```bash
# Check number of Node.js processes
ps aux | grep node | wc -l

# Check for zombie processes
ps aux | grep defunct | wc -l
```

### Step 4: Check for Large Objects
```bash
# Check for large data in memory
# This requires Node.js debugging

# Enable heap snapshot
node --inspect=localhost:9229 src/index.js

# Or use pm2
pm2 start src/index.js --node-args="--inspect=localhost:9229"
```

### Step 5: Check for External Factors
```bash
# Check for large file uploads
ls -lh /var/data/uploads/

# Check for large database queries
sqlite3 /var/data/audit.db "SELECT COUNT(*) FROM transactions;"

# Check for network connections
netstat -an | grep ESTABLISHED | wc -l
```

## Recovery Steps

### Option 1: Restart Service (Immediate)
```bash
# Restart backend
pm2 restart royalty-api

# Monitor memory
watch -n 30 'pm2 show royalty-api | grep "memory"'
```

### Option 2: Increase Memory Limit
```bash
# Increase PM2 memory limit
pm2 restart royalty-api --max-memory-restart 2G

# Or update ecosystem config
pm2 start ecosystem.config.js
```

### Option 3: Enable Garbage Collection
```bash
# Restart with GC flags
pm2 restart royalty-api --node-args="--expose-gc --max-old-space-size=4096"

# Force GC periodically
node -e "setInterval(() => global.gc(), 30000)"
```

### Option 4: Profile and Fix Leak
```bash
# Take heap snapshot
kill -USR2 <pid>

# Analyze with Chrome DevTools
# Open chrome://inspect
# Find the Node.js process
# Take heap snapshots before and after operations
```

### Option 5: Scale Horizontally
```bash
# Start multiple instances
pm2 start src/index.js -i max

# Or use cluster mode
pm2 start src/index.js -i 4
```

## Verification Steps

### Step 1: Monitor Memory Usage
```bash
watch -n 30 'pm2 show royalty-api | grep "memory"'
# Expected: Stable memory usage
```

### Step 2: Check for Errors
```bash
pm2 logs royalty-api --lines 50 | grep -i "error\|memory\|heap"
```

### Step 3: Test Functionality
```bash
curl -s http://localhost:3001/api/v1/health | jq .
```

## Prevention

### Monitoring
- Set up memory usage alerts
- Monitor heap size
- Track GC statistics

### Best Practices
- Avoid storing large objects in memory
- Use streaming for large data
- Implement proper cleanup
- Regular memory profiling

## Time Estimates

| Step | Time |
|------|------|
| Diagnosis | 10-20 minutes |
| Recovery (Option 1) | 2-5 minutes |
| Recovery (Option 2) | 5-10 minutes |
| Recovery (Option 3) | 10-20 minutes |
| Recovery (Option 4) | 30-60 minutes |
| Recovery (Option 5) | 15-30 minutes |
| Verification | 5-10 minutes |

## Related Runbooks

- [High Error Rate](./high-error-rate.md)
- [Database Locked](./db-locked.md)
- [WebSocket Down](./websocket-down.md)
