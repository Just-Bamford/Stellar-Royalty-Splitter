# Runbook: Contract Paused

## Symptom Detection

### Automated Alerts
- Alert: `ContractPaused`
- Condition: Transaction simulation failures > 0
- Threshold: > 5 simulation failures per minute

### Manual Detection
- Error logs show: `contract paused`, `Auth/Invalid`
- Users reporting: "Cannot interact with contract"
- Transaction submissions failing with: `ContractError`

## Diagnosis Steps

### Step 1: Check Contract Status
```bash
# Check contract state
curl -s -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "simulateTransaction",
    "params": {
      "transaction": "<XDR>"
    }
  }' | jq .
```

### Step 2: Check Authorization
```bash
# Check contract authorization
curl -s http://localhost:3001/api/v1/contract/<contractId>/status | jq .

# Check admin status
curl -s http://localhost:3001/api/v1/admin/status | jq .
```

### Step 3: Check Contract Events
```bash
# Check recent contract events
curl -s "https://horizon-testnet.stellar.org/contracts/<contractId>/events?limit=10" | jq .
```

### Step 4: Check Network Status
```bash
# Verify network connectivity
curl -s https://horizon-testnet.stellar.org/ | jq .core_version

# Check Soroban RPC
curl -s -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq .
```

### Step 5: Check Backend Configuration
```bash
# Verify contract ID
cat backend/.env | grep CONTRACT

# Check for environment variable overrides
echo $STELLAR_CONTRACT_ID
```

## Recovery Steps

### Option 1: Verify Contract is Not Actually Paused
```bash
# Check contract state via simulation
# If contract is not paused, issue may be elsewhere
curl -s -X POST http://localhost:3001/api/v1/simulate \
  -H "Content-Type: application/json" \
  -d '{"contractId":"C...","walletAddress":"G..."}' | jq .
```

### Option 2: Resume Contract (If Paused by Admin)
```bash
# Only authorized admin can resume
# This requires admin key access

# Check admin status
curl -s http://localhost:3001/api/v1/admin/status | jq .

# Resume contract (requires admin signature)
curl -s -X POST http://localhost:3001/api/v1/admin/resume \
  -H "Content-Type: application/json" \
  -H "x-admin-token: <admin-token>" \
  -d '{"contractId":"C..."}' | jq .
```

### Option 3: Switch to Backup Contract
```bash
# If primary contract is permanently paused
# Update backend to use backup contract

export STELLAR_CONTRACT_ID=<backup-contract-id>
pm2 restart royalty-api

# Verify
curl -s http://localhost:3001/api/v1/health | jq .
```

### Option 4: Deploy New Contract
```bash
# Deploy new contract instance
cd backend
node scripts/deploy-contract.js

# Update configuration
# Update frontend to use new contract ID
```

### Option 5: Contact Contract Admin
```bash
# If you don't have admin access
# Document the issue
# Contact contract administrator

# Prepare incident report
cat > /tmp/incident-report.md << EOF
# Contract Paused Incident

## Contract ID
<contract-id>

## Error Message
<error-message>

## Time Detected
$(date -u)

## Impact
- Users affected: <number>
- Transactions failed: <number>

## Request
Please resume contract or provide guidance.
EOF
```

## Verification Steps

### Step 1: Verify Contract State
```bash
curl -s -X POST http://localhost:3001/api/v1/simulate \
  -H "Content-Type: application/json" \
  -d '{"contractId":"C...","walletAddress":"G..."}' | jq .
# Expected: Successful simulation
```

### Step 2: Test Transaction
```bash
curl -s -X POST http://localhost:3001/api/v1/distribute \
  -H "Content-Type: application/json" \
  -d '{"contractId":"C...","walletAddress":"G...","tokenId":"G..."}' | jq .
# Expected: Transaction XDR returned
```

### Step 3: Monitor Error Rate
```bash
watch -n 30 'pm2 logs royalty-api --lines 10 | grep -i "contract\|error"'
```

## Prevention

### Monitoring
- Set up alerts for contract state changes
- Monitor transaction success rate
- Track contract balance

### Best Practices
- Regular contract health checks
- Maintain admin key access
- Document contract pause procedures
- Have backup contracts ready

## Time Estimates

| Step | Time |
|------|------|
| Diagnosis | 10-20 minutes |
| Recovery (Option 1) | 5-10 minutes |
| Recovery (Option 2) | 15-30 minutes |
| Recovery (Option 3) | 30-60 minutes |
| Recovery (Option 4) | 1-2 hours |
| Recovery (Option 5) | Variable |
| Verification | 5-10 minutes |

## Related Runbooks

- [RPC Down](./rpc-down.md)
- [High Error Rate](./high-error-rate.md)
- [Deployment Failure](./deployment-failure.md)
