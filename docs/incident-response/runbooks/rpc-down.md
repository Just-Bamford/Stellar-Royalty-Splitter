# Runbook: Stellar RPC Down

## Symptom Detection

### Automated Alerts
- Alert: `StellarRPCUnreachable`
- Condition: Health check fails for 3+ consecutive attempts
- Threshold: > 5% error rate on RPC calls

### Manual Detection
- Error logs show: `ECONNREFUSED`, `ETIMEDOUT`, or `Connection refused`
- Transactions failing with: `NetworkError`, `TimeoutError`
- Users reporting: "Cannot connect to Stellar network"

## Diagnosis Steps

### Step 1: Verify RPC Endpoint Status
```bash
# Check Stellar Horizon status
curl -s https://horizon-testnet.stellar.org/ | jq .core_version

# Check Soroban RPC
curl -s -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq .
```

### Step 2: Check Network Connectivity
```bash
# Test DNS resolution
nslookup horizon-testnet.stellar.org

# Test port connectivity
telnet horizon-testnet.stellar.org 443

# Check firewall rules
sudo iptables -L -n | grep 443
```

### Step 3: Check Backend Configuration
```bash
# Verify RPC URL configuration
cat backend/.env | grep STELLAR

# Check for environment variable overrides
echo $STELLAR_NETWORK_URL
```

### Step 4: Check Backend Logs
```bash
# Recent logs
pm2 logs royalty-api --lines 100 | grep -i "stellar\|rpc\|horizon"

# Error patterns
pm2 logs royalty-api --lines 200 | grep -i "error\|timeout\|refused"
```

### Step 5: Check Rate Limiting
```bash
# Check if we're being rate limited
curl -s -I https://horizon-testnet.stellar.org/ | grep -i "ratelimit\|retry-after"
```

## Recovery Steps

### Option 1: Wait for Recovery (Recommended if intermittent)
```bash
# Monitor RPC status
watch -n 10 'curl -s https://horizon-testnet.stellar.org/ | jq .core_version'

# If intermittent, service may auto-recover
```

### Option 2: Switch to Backup RPC
```bash
# Update backend environment
export STELLAR_NETWORK_URL=https://horizon-staging.stellar.org

# Restart backend
pm2 restart royalty-api

# Verify connectivity
curl -s http://localhost:3001/api/v1/health | jq .
```

### Option 3: Enable Caching Mode
```bash
# If RPC is down, enable read-only caching
# This serves cached data without live network queries
export CACHE_ONLY=true
pm2 restart royalty-api
```

### Option 4: Emergency Rollback
```bash
# If recent deployment caused issue
cd backend
git checkout HEAD~1
npm ci --production
pm2 restart royalty-api
```

## Verification Steps

### Step 1: Verify Service Health
```bash
curl -s http://localhost:3001/api/v1/health | jq .
# Expected: {"status":"ok","stellar":"connected"}
```

### Step 2: Test RPC Connectivity
```bash
curl -s -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq .
# Expected: {"status":"connected"}
```

### Step 3: Test Transaction Building
```bash
curl -s -X POST http://localhost:3001/api/v1/simulate \
  -H "Content-Type: application/json" \
  -d '{"contractId":"C...","walletAddress":"G..."}' | jq .
```

### Step 4: Monitor Error Rate
```bash
# Watch error rate for 5 minutes
watch -n 30 'curl -s http://localhost:3001/api/v1/metrics | jq .errorRate'
```

## Prevention

### Monitoring
- Set up alerts for RPC response time > 2s
- Monitor error rate on RPC calls
- Track RPC availability percentage

### Best Practices
- Implement retry logic with exponential backoff
- Use connection pooling for RPC requests
- Cache frequently accessed data
- Have backup RPC endpoints configured

## Time Estimates

| Step | Time |
|------|------|
| Diagnosis | 5-10 minutes |
| Recovery (Option 1) | 5-15 minutes |
| Recovery (Option 2) | 10-20 minutes |
| Recovery (Option 3) | 15-30 minutes |
| Recovery (Option 4) | 20-45 minutes |
| Verification | 5-10 minutes |

## Related Runbooks

- [High Error Rate](./high-error-rate.md)
- [Database Locked](./db-locked.md)
- [Deployment Failure](./deployment-failure.md)
