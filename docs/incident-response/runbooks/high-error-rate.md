# Runbook: High Error Rate

## Symptom Detection

### Automated Alerts
- Alert: `HighErrorRate`
- Condition: HTTP 5xx error rate > 1%
- Threshold: > 1% for 5 minutes

### Manual Detection
- Monitoring dashboard shows error spike
- Users reporting errors
- Log analysis shows error patterns

## Diagnosis Steps

### Step 1: Check Error Rate
```bash
# Check current error rate
curl -s http://localhost:3001/api/v1/metrics | jq .errorRate

# Check recent errors
pm2 logs royalty-api --lines 100 | grep -i "error" | tail -20
```

### Step 2: Identify Error Types
```bash
# Categorize errors
pm2 logs royalty-api --lines 200 | grep -oP '"status":\d+' | sort | uniq -c | sort -rn

# Check specific error patterns
pm2 logs royalty-api --lines 200 | grep -i "database\|timeout\|refused\|invalid"
```

### Step 3: Check Service Health
```bash
# Health check
curl -s http://localhost:3001/api/v1/health | jq .

# Check process status
pm2 list

# Check resource usage
top -bn1 | grep node
```

### Step 4: Check Dependencies
```bash
# Check database
sqlite3 /var/data/audit.db "PRAGMA integrity_check;"

# Check Stellar network
curl -s https://horizon-testnet.stellar.org/ | jq .core_version

# Check external services
curl -s http://localhost:3001/api/v1/health/external | jq .
```

### Step 5: Check Recent Changes
```bash
# Check recent deployments
ls -lt /var/log/deployments/

# Check git log
cd backend && git log --oneline -10

# Check environment changes
env | grep -i "stellar\|database\|api"
```

## Recovery Steps

### Option 1: Restart Service (Quick Fix)
```bash
# Restart backend
pm2 restart royalty-api

# Monitor recovery
watch -n 10 'curl -s http://localhost:3001/api/v1/health | jq .status'
```

### Option 2: Rollback Recent Deployment
```bash
# If recent deployment caused issue
cd backend
git checkout HEAD~1
npm ci --production
pm2 restart royalty-api
```

### Option 3: Scale Up Resources
```bash
# If resource exhaustion
pm2 restart royalty-api -i max

# Or increase memory limit
pm2 restart royalty-api --max-memory-restart 1G
```

### Option 4: Enable Circuit Breaker
```bash
# If external dependency is failing
export CIRCUIT_BREAKER_ENABLED=true
pm2 restart royalty-api
```

### Option 5: Switch to Fallback Mode
```bash
# If primary system is down
export FALLBACK_MODE=true
export CACHE_ONLY=true
pm2 restart royalty-api
```

## Verification Steps

### Step 1: Verify Error Rate
```bash
watch -n 30 'curl -s http://localhost:3001/api/v1/metrics | jq .errorRate'
# Expected: Error rate < 1%
```

### Step 2: Test Critical Paths
```bash
# Test health endpoint
curl -s http://localhost:3001/api/v1/health | jq .

# Test API endpoints
curl -s http://localhost:3001/api/v1/contracts | jq .
```

### Step 3: Monitor Logs
```bash
# Watch for errors
pm2 logs royalty-api --lines 50 | grep -i "error"
```

## Prevention

### Monitoring
- Set up alerts for error rate > 0.5%
- Monitor response times
- Track resource usage

### Best Practices
- Implement circuit breakers
- Use retry logic with backoff
- Cache frequently accessed data
- Regular load testing

## Time Estimates

| Step | Time |
|------|------|
| Diagnosis | 5-15 minutes |
| Recovery (Option 1) | 2-5 minutes |
| Recovery (Option 2) | 10-20 minutes |
| Recovery (Option 3) | 5-10 minutes |
| Recovery (Option 4) | 5-15 minutes |
| Recovery (Option 5) | 10-30 minutes |
| Verification | 5-10 minutes |

## Related Runbooks

- [RPC Down](./rpc-down.md)
- [Database Locked](./db-locked.md)
- [Memory Leak](./memory-leak.md)
