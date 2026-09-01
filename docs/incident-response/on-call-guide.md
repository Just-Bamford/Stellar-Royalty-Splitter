# On-Call Guide

Quick reference for on-call engineers responding to incidents.

## Before Your Shift

1. **Review recent changes**: Check deployments in the last 24 hours
2. **Check alerts**: Review any active alerts in monitoring dashboard
3. **Test runbooks**: Ensure you have access to all necessary systems
4. **Communication**: Verify you can receive alerts (PagerDuty, Slack, etc.)

## During Your Shift

### Alert Response Checklist

- [ ] Acknowledge alert within response time
- [ ] Assess severity level
- [ ] Check monitoring dashboard for context
- [ ] Review relevant runbook
- [ ] Take initial diagnostic steps
- [ ] Update status page if needed
- [ ] Escalate if necessary

### Common Commands

```bash
# Check service status
curl -s http://localhost:3001/api/v1/health | jq .

# Check database
sqlite3 /var/data/audit.db "PRAGMA integrity_check;"

# Check logs
pm2 logs royalty-api --lines 100

# Check WebSocket
curl -s http://localhost:3001/api/v1/health/ws | jq .

# Restart service
pm2 restart royalty-api

# Check disk space
df -h

# Check memory
free -m

# Check processes
ps aux | grep node
```

### Quick Diagnostics

#### Service Down
```bash
# Check if process is running
pm2 list

# Check port usage
lsof -i :3001

# Check logs for errors
pm2 logs royalty-api --lines 50 | grep -i error
```

#### Database Issues
```bash
# Check database size
ls -lh /var/data/audit.db

# Check for locks
lsof /var/data/audit.db

# Run integrity check
sqlite3 /var/data/audit.db "PRAGMA integrity_check;"

# Check WAL mode
sqlite3 /var/data/audit.db "PRAGMA journal_mode;"
```

#### High Error Rate
```bash
# Check error logs
pm2 logs royalty-api --lines 200 | grep -i error

# Check metrics
curl -s http://localhost:3001/api/v1/metrics | jq .

# Check network connectivity
curl -s https://horizon-testnet.stellar.org/ | jq .core_version
```

## Escalation Procedure

### When to Escalate

- Issue not resolved within 30 minutes
- Data loss or corruption suspected
- Security incident detected
- Multiple systems affected
- Customer-facing impact

### How to Escalate

1. **Notify team lead** via Slack #incidents channel
2. **Update status page** with current status
3. **Document actions taken** in incident ticket
4. **Prepare handoff** information for next responder

### Escalation Contacts

| Role | Name | Contact | Available |
|------|------|---------|-----------|
| Team Lead | [Name] | [Phone/Slack] | Business hours |
| Engineering Manager | [Name] | [Phone/Slack] | 24/7 |
| CTO | [Name] | [Phone/Slack] | Critical only |

## Communication Templates

### Initial Alert Acknowledgment
```
Acknowledging alert: [Alert Name]
Severity: [SEV-X]
Investigating: Will update in 15 minutes
```

### Status Update
```
Update on [Incident]:
- Current status: [Investigating/Identified/Monitoring]
- Impact: [Description]
- ETA to resolution: [Time or "Unknown"]
- Next update: [Time]
```

### Resolution
```
Resolved: [Incident Name]
Duration: [X hours Y minutes]
Root cause: [Brief description]
Postmortem: [Link to scheduled postmortem]
```

## Useful Resources

- [Operator Runbook](../operator-runbook.md)
- [Incident Response README](./README.md)
- [Postmortem Template](./postmortem-template.md)
- [Runbooks Directory](./runbooks/)
