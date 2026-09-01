# Disaster recovery exercise records

Evidence from disaster recovery exercises, one JSON report per run.

Committing these is what turns a recovery exercise into a trend. A single run
tells you whether recovery worked today; a year of them tells you whether it is
getting slower, which is the signal that matters before an incident rather than
during one.

## Adding a record

The monthly run produces a report automatically:

```bash
DR_ENVIRONMENT=staging ./infra/disaster-recovery-test.sh --all \
  --json-report "docs/dr-exercises/$(date -u +%Y-%m).json"
```

Scheduled CI runs upload the same report as a `dr-exercise-<run_id>` artifact,
retained for a year. Download it and commit it here.

## Reading a record

```json
{
  "environment": "staging",
  "startedAt": "2026-09-01T06:00:00Z",
  "rtoTargetSeconds": 3600,
  "scenarios": [
    {
      "scenario": "database-restore",
      "status": "passed",
      "durationSeconds": 42,
      "checkpoints": [
        { "name": "backup-taken",       "elapsedSeconds": 3 },
        { "name": "restore-completed",  "elapsedSeconds": 28 },
        { "name": "integrity-verified", "elapsedSeconds": 42 }
      ]
    }
  ]
}
```

Checkpoints are the reason these are worth keeping. "The restore took 40
minutes" is not actionable; "38 of those 40 were the download" is.

A scenario that **passes but exceeds the RTO** is recorded as failed —
succeeding too slowly is still failing the objective.

## What to do with a failure

File an issue. A failing recovery procedure is a production risk, not a
test-maintenance chore: it means the documented recovery path does not work,
and that will only be discovered again during an actual incident.

See [`docs/DISASTER_RECOVERY_RUNBOOK.md`](../DISASTER_RECOVERY_RUNBOOK.md).
