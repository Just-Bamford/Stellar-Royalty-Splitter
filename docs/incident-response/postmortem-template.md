# Postmortem Template

## Incident Summary

| Field | Value |
|-------|-------|
| **Incident ID** | INC-YYYY-MM-DD-XXX |
| **Title** | [Brief description] |
| **Severity** | SEV-1 / SEV-2 / SEV-3 / SEV-4 |
| **Status** | Resolved / Ongoing |
| **Duration** | [Start time] to [End time] (X hours Y minutes) |
| **Impact** | [Description of user impact] |
| **Root Cause** | [Brief root cause description] |
| **Detection Method** | Automated alert / Manual report / Customer complaint |

## Timeline (UTC)

| Time | Event |
|------|-------|
| HH:MM | First alert received |
| HH:MM | On-call engineer acknowledged |
| HH:MM | Investigation started |
| HH:MM | Root cause identified |
| HH:MM | Fix deployed |
| HH:MM | Service restored |
| HH:MM | Monitoring confirmed resolution |

## Impact Analysis

### Users Affected
- **Number of users**: [X]
- **Geographic distribution**: [Regions]
- **Duration of impact**: [X hours]

### Business Impact
- **Revenue impact**: [Estimate if applicable]
- **SLA impact**: [Yes/No, details]
- **Customer complaints**: [Number]

### Technical Impact
- **Services affected**: [List services]
- **Data impact**: [Any data loss/corruption?]
- **Cascading effects**: [Any downstream impacts?]

## Root Cause Analysis

### What happened?
[Detailed description of the incident]

### Why did it happen?
[Root cause analysis using 5 Whys or similar technique]

### How was it detected?
[Alerting/detection mechanism]

## Resolution

### Immediate Actions
1. [Action 1]
2. [Action 2]
3. [Action 3]

### Long-term Fixes
1. [Fix 1]
2. [Fix 2]
3. [Fix 3]

## Lessons Learned

### What went well?
- [Positive aspect 1]
- [Positive aspect 2]

### What went poorly?
- [Negative aspect 1]
- [Negative aspect 2]

### Where did we get lucky?
- [Lucky circumstance 1]

## Action Items

| Priority | Action | Owner | Due Date | Status |
|----------|--------|-------|----------|--------|
| P0 | [Critical fix] | [Name] | [Date] | [Status] |
| P1 | [Important improvement] | [Name] | [Date] | [Status] |
| P2 | [Nice to have] | [Name] | [Date] | [Status] |

## Appendix

### Relevant Logs
```
[Include relevant log snippets]
```

### Metrics
```
[Include relevant metrics/charts]
```

### Communication Log
```
[Include status page updates, Slack messages, etc.]
```

## Approval

| Role | Name | Date |
|------|------|------|
| Incident Commander | | |
| Technical Lead | | |
| Engineering Manager | | |

---

**Next Review**: [Date for follow-up review]
**Postmortem Owner**: [Name]
