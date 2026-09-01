# Runbook: Deployment Failure

## Symptom Detection

### Automated Alerts
- Alert: `DeploymentFailed`
- Condition: CI/CD pipeline failed
- Threshold: Any deployment failure

### Manual Detection
- GitHub Actions showing failed status
- Service not updated after deployment
- Version mismatch between frontend/backend

## Diagnosis Steps

### Step 1: Check CI/CD Status
```bash
# Check GitHub Actions
gh run list --limit 5

# Check specific run
gh run view <run-id>
```

### Step 2: Check Deployment Logs
```bash
# Check PM2 logs
pm2 logs royalty-api --lines 100

# Check deployment scripts
ls -lt /var/log/deployments/
```

### Step 3: Check Service Status
```bash
# Check if service is running
pm2 list

# Check version
curl -s http://localhost:3001/api/v1/version | jq .
```

### Step 4: Check Environment
```bash
# Check environment variables
env | grep -i "stellar\|database\|node"

# Check Node.js version
node --version

# Check npm version
npm --version
```

### Step 5: Check Dependencies
```bash
# Check for dependency issues
cd backend
npm audit
npm ls
```

## Recovery Steps

### Option 1: Rollback to Previous Version
```bash
# Check available versions
git tag -l | tail -5

# Checkout previous version
git checkout <previous-tag>

# Reinstall dependencies
npm ci --production

# Restart service
pm2 restart royalty-api
```

### Option 2: Fix and Redeploy
```bash
# Fix the issue
# Commit changes
git add .
git commit -m "fix: deployment issue"

# Push to main
git push origin main

# Monitor deployment
gh run watch
```

### Option 3: Manual Deployment
```bash
# If CI/CD is broken
cd backend

# Install dependencies
npm ci --production

# Run migrations if needed
node src/index.js --migrate

# Start service
pm2 restart royalty-api
```

### Option 4: Emergency Hotfix
```bash
# Create hotfix branch
git checkout -b hotfix/fix-issue

# Make minimal changes
# Commit and push
git push origin hotfix/fix-issue

# Create PR
gh pr create --title "Hotfix: Fix deployment" --body "Fixes deployment issue"
```

### Option 5: Restore from Backup
```bash
# If deployment corrupted service
pm2 stop royalty-api

# Restore from backup
cp /backups/audit.db.latest /var/data/audit.db

# Restore code
git checkout <last-known-good>

# Restart
pm2 start royalty-api
```

## Verification Steps

### Step 1: Verify Service Health
```bash
curl -s http://localhost:3001/api/v1/health | jq .
# Expected: {"status":"ok"}
```

### Step 2: Check Version
```bash
curl -s http://localhost:3001/api/v1/version | jq .
# Expected: Correct version
```

### Step 3: Test Critical Paths
```bash
# Test API endpoints
curl -s http://localhost:3001/api/v1/contracts | jq .

# Test database
sqlite3 /var/data/audit.db "SELECT COUNT(*) FROM transactions;"
```

### Step 4: Monitor Logs
```bash
pm2 logs royalty-api --lines 50 | grep -i "error\|warning"
```

## Prevention

### Monitoring
- Set up deployment status alerts
- Monitor version consistency
- Track deployment duration

### Best Practices
- Use staging environment
- Implement canary deployments
- Automated rollback on failure
- Regular deployment drills

## Time Estimates

| Step | Time |
|------|------|
| Diagnosis | 5-15 minutes |
| Recovery (Option 1) | 10-20 minutes |
| Recovery (Option 2) | 15-30 minutes |
| Recovery (Option 3) | 10-20 minutes |
| Recovery (Option 4) | 20-45 minutes |
| Recovery (Option 5) | 30-60 minutes |
| Verification | 5-10 minutes |

## Related Runbooks

- [High Error Rate](./high-error-rate.md)
- [RPC Down](./rpc-down.md)
- [Database Locked](./db-locked.md)
