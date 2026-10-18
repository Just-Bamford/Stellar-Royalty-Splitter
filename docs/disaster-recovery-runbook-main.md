# Disaster Recovery Runbook

Operational procedures for recovering the Stellar Royalty Splitter from the
failure modes it can actually experience (#865).

> **During an incident, start at [Immediate response](#immediate-response).**
> The rest of this document is for reading beforehand.

A documented recovery procedure that is never executed is a guess. Backups rot
silently — an encryption key is rotated without updating the restore path, a
migration changes what valid data means, a bucket policy tightens — and none of
it is visible until a restore is attempted. That is why this runbook is paired
with [`infra/disaster-recovery-test.sh`](../infra/disaster-recovery-test.sh),
which executes these procedures on a schedule against an isolated environment.

> **Scope.** This document covers *operational* recovery: the database, the
> application, its infrastructure, and its dependencies. For the mechanics of
> restoring a single database backup, see
> [`disaster-recovery-runbook.md`](disaster-recovery-runbook.md), which this
> document supersedes for incident use and links to for step-by-step S3 detail.

---

## Objectives

| Objective | Target | Where it comes from |
|---|---|---|
| **RTO** — time to restore service | **< 1 hour** | [`backup-strategy.md`](backup-strategy.md) |
| **RPO** — acceptable data loss | **< 24 hours** | Daily backup cadence |

RTO is measured automatically by the test script, and an exercise that succeeds
but exceeds the target is reported as a **failure**. An RTO nobody measures is
an aspiration.

**What is and is not recoverable.** The audit database, application
infrastructure, and configuration are all recoverable. On-chain state is not:
Soroban contracts are immutable, and a distribution that has been submitted and
confirmed cannot be reversed by anything in this document. Recovery restores
the *record* of what happened, not the chain itself.

---

## Immediate response

Before diagnosing anything:

1. **Note the time.** RTO is measured from the start of the incident, not from
   when someone started working on it.
2. **Do not delete anything.** A corrupted database is evidence. Copy it aside
   before replacing it — every procedure below does this explicitly.
3. **Establish what is actually broken** using the triage table.
4. **Escalate in parallel**, not afterwards. See [Escalation](#escalation).

### Triage

| Symptom | Likely scenario | Go to |
|---|---|---|
| API returns 500s; logs show SQLite errors | Database corruption | [Scenario 1](#scenario-1--database-corruption-or-data-loss) |
| Restore fails or produces wrong data | Backup failure | [Scenario 2](#scenario-2--backup-restoration-failure) |
| API up, distributions fail, RPC timeouts in logs | Dependency outage | [Scenario 3](#scenario-3--soroban-rpc-or-horizon-outage) |
| Instance gone; ALB reports no healthy hosts | Infrastructure loss | [Scenario 4](#scenario-4--loss-of-application-infrastructure) |
| App will not start; secrets or config errors | Configuration loss | [Scenario 5](#scenario-5--configuration-or-secret-loss) |
| Some endpoints work, others do not | Partial failure | [Scenario 6](#scenario-6--partial-service-failure) |
| Whole environment is gone | Total loss | [Scenario 7](#scenario-7--complete-environment-recreation) |
| Recent deploy broke things | Bad deployment | [Scenario 8](#scenario-8--invalid-or-broken-deployment) |

### First commands

```bash
# Is the process alive? /health answers from the process alone.
curl -sf "$API_BASE_URL/health" && echo "process is up"

# Are the dependencies healthy? This one reaches Horizon and Soroban RPC.
curl -s "$API_BASE_URL/api/v1/health" | jq .

# Is the database intact?
sqlite3 "$DATABASE_PATH" "PRAGMA integrity_check;"

# What does the load balancer think?
aws elbv2 describe-target-health --target-group-arn "$TARGET_GROUP_ARN"
```

A **healthy `/health` alongside a failing `/api/v1/health`** means the service
is up and a dependency is not. That is a degraded state, not an outage, and it
is deliberately not an instance-replacement trigger — see
[Scenario 3](#scenario-3--soroban-rpc-or-horizon-outage).

---

## Scenario 1 — Database corruption or data loss

**Automated?** Partly. The restore mechanics are exercised by
`--scenario database-restore`; deciding *which* backup to restore is a judgment
call and stays manual.

### Detection signals

- 5xx responses with `SQLITE_CORRUPT` or `database disk image is malformed`
- `PRAGMA integrity_check` returning anything other than `ok`
- The `srs-*-api-5xx` CloudWatch alarm
- Row counts dropping without a corresponding deletion

### Preconditions

| Requirement | Check |
|---|---|
| Access to the instance | `aws ssm start-session --target <instance-id>` |
| Backup decryption key | `aws secretsmanager get-secret-value --secret-id <backup-key-secret>` |
| S3 read access | `aws s3 ls "s3://$BACKUP_S3_BUCKET/daily/"` |
| `sqlite3`, `openssl`, `aws` | `command -v sqlite3 openssl aws` |
| Free disk | At least 2× the database size |

### Recovery

**Checkpoint 1 — preserve the evidence.** Do this first. It is the only step
that cannot be redone later.

```bash
INCIDENT="$(date -u +%Y%m%dT%H%M%SZ)"
cp "$DATABASE_PATH" "/var/data/pre-recovery-$INCIDENT.db"
```

**Checkpoint 2 — stop writes.** A restore underneath a running application
produces a database that is neither the backup nor the original.

```bash
pm2 stop royalty-api
```

**Checkpoint 3 — choose a backup.** Newest is usually right, but not if the
corruption predates it. If the cause is unknown, prefer one from before the
first sign of trouble.

```bash
aws s3 ls "s3://$BACKUP_S3_BUCKET/daily/" --recursive | sort | tail -10
BACKUP_KEY="daily/stellar-royalty-backup-daily-YYYY-MM-DD.db.tar.gz.enc"
```

**Checkpoint 4 — download and verify before decrypting.**

```bash
WORK=/tmp/recovery-$INCIDENT
mkdir -p "$WORK"

aws s3 cp "s3://$BACKUP_S3_BUCKET/$BACKUP_KEY" "$WORK/backup.enc"

# The backup script writes a metadata object alongside every backup.
aws s3 cp "s3://$BACKUP_S3_BUCKET/metadata/$(basename "$BACKUP_KEY" .db.tar.gz.enc).json" "$WORK/"
```

**Checkpoint 5 — decrypt.**

```bash
BACKUP_ENCRYPTION_KEY="$(aws secretsmanager get-secret-value \
  --secret-id "$BACKUP_KEY_SECRET" --query SecretString --output text)"

openssl enc -aes-256-cbc -pbkdf2 -d \
  -in "$WORK/backup.enc" -out "$WORK/restored.db" \
  -pass "pass:$BACKUP_ENCRYPTION_KEY"
```

> **If decryption fails**, the key has almost certainly been rotated since the
> backup was taken. Check Secrets Manager version history — previous versions
> are retained:
>
> ```bash
> aws secretsmanager list-secret-version-ids --secret-id "$BACKUP_KEY_SECRET"
> ```
>
> This is the single most common silent backup failure, which is why
> `--scenario backup-restore` exercises the encrypt/decrypt round trip on every
> run.

**Checkpoint 6 — verify integrity before installing.** Never install a backup
you have not checked.

```bash
# Checksum against the recorded metadata.
EXPECTED="$(jq -r .sha256 "$WORK/"*.json)"
ACTUAL="$(sha256sum "$WORK/restored.db" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || echo "CHECKSUM MISMATCH — do not install"

sqlite3 "$WORK/restored.db" "PRAGMA integrity_check;"   # must be: ok
sqlite3 "$WORK/restored.db" "SELECT MAX(version) FROM schema_migrations;"
```

Then the checks that actually matter — a database can pass `integrity_check`
and still be internally inconsistent:

```bash
# Payouts referencing transactions that do not exist.
sqlite3 "$WORK/restored.db" "
  SELECT COUNT(*) FROM distribution_payouts p
  LEFT JOIN transactions t ON t.id = p.transaction_id
  WHERE t.id IS NULL;"        # must be 0

# Value conservation: payouts must sum to the amount distributed.
sqlite3 "$WORK/restored.db" "
  SELECT COUNT(*) FROM (
    SELECT t.id FROM transactions t
    JOIN distribution_payouts p ON p.transaction_id = t.id
    WHERE t.status = 'confirmed'
    GROUP BY t.id, t.amount
    HAVING SUM(CAST(p.amount AS INTEGER)) <> CAST(t.amount AS INTEGER));"  # must be 0
```

**Checkpoint 7 — install.**

```bash
cp "$WORK/restored.db" "$DATABASE_PATH"
chown srs:srs "$DATABASE_PATH"
chmod 640 "$DATABASE_PATH"
```

**Checkpoint 8 — restart and verify.**

```bash
pm2 start royalty-api
sleep 10

curl -sf "$API_BASE_URL/health"            # process is up
curl -s "$API_BASE_URL/api/v1/health" | jq # dependencies are reachable
pm2 logs royalty-api --lines 50 --nostream | grep -i error
```

### Post-recovery verification

- [ ] `integrity_check` returns `ok`
- [ ] Schema migration version matches the running code
- [ ] No orphaned payouts, no value-conservation violations
- [ ] `/health` returns 200; the target group reports the instance healthy
- [ ] Recent transactions are visible through the API
- [ ] Data loss window measured and recorded (backup timestamp → incident time)
- [ ] Pre-recovery database preserved for analysis

### Rollback

If the restore is wrong, the pre-recovery copy from checkpoint 1 is the way
back:

```bash
pm2 stop royalty-api
cp "/var/data/pre-recovery-$INCIDENT.db" "$DATABASE_PATH"
pm2 start royalty-api
```

### Escalate if

- Two consecutive backups fail verification
- Recovery passes 45 minutes with the RTO at 1 hour
- The data loss window exceeds 24 hours
- Value conservation fails on every available backup — that indicates a bug in
  the application, not a bad backup

---

## Scenario 2 — Backup restoration failure

**Automated?** Yes — `--scenario backup-restore`.

The scenario where the recovery path itself is what is broken.

### Detection signals

- Decryption fails during a restore
- Checksums do not match
- The newest backup is older than 25 hours (the `backup-monitoring.sh` window)
- The `srs-*-backup-failed` alarm

### Diagnosis, in order of likelihood

| Symptom | Cause | Action |
|---|---|---|
| `bad decrypt` | Key rotated since the backup | Check Secrets Manager version history |
| Checksum mismatch | Corrupted in transit or at rest | Try another backup; check S3 object integrity |
| `NoSuchKey` | Backup job silently stopped | Check the cron entry and `backup.log` |
| `AccessDenied` | IAM or bucket policy changed | Check the grants in `infra/terraform/modules/security` |
| Restores but is empty | Backed up an empty database | Look for an earlier backup; investigate the source |

### Recovery — work down the tiers

```bash
# 1. An earlier daily backup.
aws s3 ls "s3://$BACKUP_S3_BUCKET/daily/" | sort | tail -10

# 2. Weekly, then monthly. Each step increases the data loss window.
aws s3 ls "s3://$BACKUP_S3_BUCKET/weekly/" | sort | tail -5
aws s3 ls "s3://$BACKUP_S3_BUCKET/monthly/" | sort | tail -5

# 3. A previous object version — this is what bucket versioning is for, and
#    it is the only recovery path when a corrupted database was backed up
#    OVER the last good copy.
aws s3api list-object-versions \
  --bucket "$BACKUP_S3_BUCKET" --prefix "daily/" \
  --query 'Versions[].[Key,VersionId,LastModified]' --output table

# 4. An EBS snapshot. Independent of the backup script and its passphrase
#    entirely, which is precisely why both exist.
aws ec2 describe-snapshots --owner-ids self \
  --filters "Name=tag:Name,Values=srs-*-data" \
  --query 'sort_by(Snapshots,&StartTime)[-5:].[SnapshotId,StartTime]' --output table
```

Restoring from a snapshot replaces the volume rather than the file:

```bash
VOLUME_ID="$(aws ec2 create-volume \
  --snapshot-id "$SNAPSHOT_ID" \
  --availability-zone "$AZ" --volume-type gp3 --encrypted \
  --query VolumeId --output text)"

# Then: stop the instance, detach the old volume, attach this one at /dev/sdf,
# and start it. The bootstrap script mounts by UUID and will not reformat a
# volume that already has a filesystem.
```

### Escalate if

- Every tier fails verification — this is a total backup failure
- Bucket versioning is disabled and the good copy was overwritten
- Snapshots are also missing or unusable

---

## Scenario 3 — Soroban RPC or Horizon outage

**Automated?** Yes — `--scenario rpc-outage` verifies that failover targets are
reachable.

**There is nothing to restore here.** The service is fine; an upstream
dependency is not. The goal is to degrade cleanly and fail over.

### Detection signals

- `/api/v1/health` reports degraded while `/health` returns 200
- Timeouts from `rpc-retry.js` in the logs
- Distribution requests failing while reads succeed

### Why this is not an outage of ours

The ALB health check targets `/api/v1/liveness`, **not** `/api/v1/health`. That
is deliberate: the deep check probes Horizon and Soroban RPC, so using it would
let a Stellar outage cause the auto-scaling group to terminate perfectly
healthy instances — turning someone else's degraded dependency into a
self-inflicted outage. Read paths keep serving from the local database
throughout.

### Recovery

**1. Confirm it is upstream, not us.**

```bash
curl -s https://status.stellar.org/api/v2/status.json | jq .status

curl -sf -m 10 "$SOROBAN_RPC_URL" -o /dev/null -w '%{http_code}\n'
curl -sf -m 10 "$HORIZON_URL" -o /dev/null -w '%{http_code}\n'
```

Soroban RPC is JSON-RPC and answers `405` to a bare `GET`; Horizon answers
`200`. Both indicate a reachable service.

**2. Fail over.** Configuration lives in Parameter Store, so this needs no
infrastructure change:

```bash
aws ssm put-parameter --overwrite \
  --name "/srs-$ENVIRONMENT/config/SOROBAN_RPC_URL" \
  --value "https://<alternate-endpoint>" --type String

# The instance reads parameters at boot, so restart to pick it up.
pm2 restart royalty-api
```

**3. If no alternate endpoint exists**, wait. Confirm the retry behaviour is
working (`backend/src/rpc-retry.js` backs off rather than hammering), and
communicate that writes are queued while reads continue.

### Post-recovery verification

- [ ] `/api/v1/health` returns to healthy
- [ ] A test simulation succeeds against the endpoint in use
- [ ] Queued or failed transactions retried or explicitly abandoned
- [ ] Configuration reverted if the failover was temporary

### Escalate if

- The outage passes 30 minutes with pending distributions
- No alternate endpoint is reachable
- Transactions were submitted but never confirmed — these need individual
  reconciliation against the chain

---

## Scenario 4 — Loss of application infrastructure

**Automated?** Partly — `--scenario infrastructure-recreation` verifies the
Terraform still validates, which is what the recovery depends on.

### Detection signals

- The `srs-*-no-healthy-hosts` alarm
- ALB returning 503 to everything
- The instance missing from the console

### The usual case: the ASG already handled it

The auto-scaling group runs at `min = max = 1` and health-checks against the
ELB, so a failed instance is replaced automatically. Confirm before intervening:

```bash
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$ASG_NAME" \
  --query 'AutoScalingGroups[0].Instances[].[InstanceId,LifecycleState,HealthStatus]' \
  --output table
```

A replacement takes roughly five minutes: launch, attach the data volume, mount
it, install packages, then the application deploy.

**The data volume survives instance replacement.** It is a separate EBS volume
with `prevent_destroy`, and the bootstrap script mounts by UUID and refuses to
reformat a volume that already has a filesystem.

### If the ASG cannot recover

```bash
# Force a replacement.
aws autoscaling terminate-instance-in-auto-scaling-group \
  --instance-id "$INSTANCE_ID" --should-decrement-desired-capacity

# Or rebuild the compute layer from source.
cd infra/terraform/environments/$ENVIRONMENT
terraform plan   # read this before applying
terraform apply
```

### If the data volume is also lost

Recreate it from the most recent snapshot, then follow
[Scenario 2](#scenario-2--backup-restoration-failure) to restore contents.

### Post-recovery verification

- [ ] Target group reports the instance healthy
- [ ] Data volume mounted at `/var/data` with the expected contents
- [ ] `sqlite3 "$DATABASE_PATH" "PRAGMA integrity_check;"` returns `ok`
- [ ] Application deployed and serving
- [ ] CloudWatch logs flowing again

### Escalate if

- Two replacement attempts fail
- The data volume cannot be attached
- The failure is an AZ outage — the volume cannot cross AZs, so recovery means
  restoring from a snapshot into a different AZ

---

## Scenario 5 — Configuration or secret loss

**Automated?** Yes — `--scenario config-recovery` verifies that everything
needed to rebuild the configuration is documented and retrievable.

A recovered database is useless if the application cannot start.

### Detection signals

- Application exits at startup with a missing-configuration error
- `secrets-manager.js` logging a retrieval failure
- Signature verification rejecting every request after a key change

### What lives where

| Category | Location | Recovery |
|---|---|---|
| Non-secret configuration | SSM Parameter Store, `/srs-$ENV/config/` | Re-apply Terraform, or set parameters individually |
| Signing key | Secrets Manager | Version history, or rotate to a new key |
| Backup passphrase | Secrets Manager | Version history — **without it, existing backups are unreadable** |
| Admin token | Secrets Manager | Version history, or generate a new one |
| Reference for all settings | `backend/.env.example` | Git |

### Recovery

```bash
# What is currently set?
aws ssm get-parameters-by-path --path "/srs-$ENVIRONMENT/config" --recursive \
  --query 'Parameters[].[Name,Value]' --output table

# Restore a missing parameter.
aws ssm put-parameter --name "/srs-$ENVIRONMENT/config/STELLAR_NETWORK" \
  --value "testnet" --type String --overwrite

# Or restore the whole set from source.
cd infra/terraform/environments/$ENVIRONMENT && terraform apply
```

For secrets, previous versions are retained:

```bash
aws secretsmanager list-secret-version-ids --secret-id "$SECRET_ID"

aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ID" --version-id "$PREVIOUS_VERSION_ID"
```

If a secret is genuinely unrecoverable:

- **Signing key** — generate a new one and update Secrets Manager. Only
  read-only simulation uses it server-side; real transactions are signed
  client-side, so the impact is contained.
- **Backup passphrase** — **existing backups become permanently unreadable.**
  Set a new passphrase, take an immediate fresh backup, and treat every prior
  backup as lost. This is the single worst secret to lose, which is why
  production sets a 30-day KMS deletion window and a 30-day secret recovery
  window.
- **Admin token** — generate a new one; it only gates `/admin/rotate-key`.

### Post-recovery verification

- [ ] Application starts without configuration errors
- [ ] `/health` returns 200
- [ ] A test backup runs and can be decrypted
- [ ] Signature verification behaves as configured for the environment

---

## Scenario 6 — Partial service failure

**Automated?** Yes — `--scenario partial-failure`.

Some functionality works and some does not. The judgment call is whether to
intervene at all.

### Diagnosis

```bash
curl -sf "$API_BASE_URL/health"              # process alive?
curl -sf "$API_BASE_URL/ready"               # ready for traffic?
curl -s "$API_BASE_URL/api/v1/health" | jq   # which dependency is unhappy?
```

| Pattern | Meaning | Action |
|---|---|---|
| `/health` 200, `/api/v1/health` 503 | Dependency degraded | [Scenario 3](#scenario-3--soroban-rpc-or-horizon-outage) |
| `/health` 200, reads fail | Database problem | [Scenario 1](#scenario-1--database-corruption-or-data-loss) |
| `/health` 200, writes fail | Signing or RPC problem | Check the signing key and RPC reachability |
| `/health` 200, everything slow | Resource exhaustion | Check the disk and memory alarms |
| Intermittent failures | One unhealthy instance | Check target health |

### Disk exhaustion

The most common partial failure, and the most dangerous, because SQLite stops
accepting writes and **backups also fail** — so the incident silently removes
the recovery path.

```bash
df -h /var/data

# Reclaim WAL space.
sqlite3 "$DATABASE_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"

# Grow the volume — gp3 supports this online, with no downtime.
aws ec2 modify-volume --volume-id "$VOLUME_ID" --size 200
sudo resize2fs /dev/nvme1n1
```

The `srs-*-data-volume-full` alarm fires at 75% in production specifically so
there is time to act before writes start failing.

---

## Scenario 7 — Complete environment recreation

**Automated?** Partly — `--scenario environment-recreation` verifies every
required asset is present and usable. The apply itself is operator-led.

### Recovery, in order

Order matters: each step depends on the last.

**1. Infrastructure.**

```bash
cd infra/terraform/environments/$ENVIRONMENT
terraform init -backend-config=backend.hcl
terraform plan     # read it
terraform apply
```

**2. Secrets.** Terraform creates the containers with placeholders; the values
are written out-of-band.

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(terraform output -raw signing_key_secret_name)" \
  --secret-string "{\"signingKey\":\"S...\"}"
```

**3. Database.** Restore per [Scenario 1](#scenario-1--database-corruption-or-data-loss),
or start empty if this is a genuinely new environment.

**4. Application.**

```bash
aws ssm start-session --target "$INSTANCE_ID"
# then deploy per docs/operator-runbook.md
```

**5. Frontend.**

```bash
cd frontend && npm ci && npm run build
aws s3 sync dist/ "s3://$(terraform output -raw frontend_bucket)/" --delete
aws cloudfront create-invalidation \
  --distribution-id "$(terraform output -raw frontend_distribution_id)" \
  --paths '/index.html'
```

**6. Contract.** Only if the contract itself is being redeployed. Soroban
contracts are immutable, so an existing deployment is usually repointed rather
than replaced:

```bash
./scripts/validate-deployment.sh pre
STELLAR_NETWORK=$NETWORK ./scripts/deploy.sh
./scripts/validate-deployment.sh post
```

**7. Verify.**

```bash
./scripts/validate-env.sh
curl -sf "$API_BASE_URL/health"
curl -s "$API_BASE_URL/api/v1/health" | jq
```

### Expected duration

| Step | Typical |
|---|---|
| Infrastructure apply | 15–20 min (CloudFront dominates) |
| Secrets | 5 min |
| Database restore | 5–15 min, size-dependent |
| Application deploy | 10 min |
| Frontend deploy | 5 min |
| Verification | 10 min |
| **Total** | **50–65 min** |

This is at or slightly over the 1-hour RTO, and that is honest rather than
optimistic: a total environment loss is the one scenario where the target may
not be met. Partial recovery is faster because the infrastructure step — the
expensive one — is skipped.

---

## Scenario 8 — Invalid or broken deployment

**Automated?** Yes — `--scenario deployment-rollback` verifies the rollback
mechanism exists and is documented.

### Application rollback

```bash
pm2 stop royalty-api
cd /opt/stellar-royalty-splitter
git checkout "$LAST_GOOD_TAG"
npm ci --production
pm2 start royalty-api
```

### Infrastructure rollback

```bash
cd infra/terraform/environments/$ENVIRONMENT
git checkout "$LAST_GOOD_COMMIT" -- .
terraform plan     # confirm it reverts what you expect
terraform apply
```

### Contract rollback

**Soroban contracts are immutable.** There is no in-place revert. Rollback
means pointing the backend at the previous known-good contract:

```bash
aws ssm put-parameter --overwrite \
  --name "/srs-$ENVIRONMENT/config/ROYALTY_CONTRACT_ID" \
  --value "$PREVIOUS_CONTRACT_ID" --type String

pm2 restart royalty-api
```

If `initialize()` was never called on the bad contract it is inert and needs no
further action. If it was called with the wrong configuration, deploy a
corrected contract and repoint. See
[`DEPLOYMENT.md`](../DEPLOYMENT.md#rollback-procedure) for the full procedure
and the fund-recovery caveats.

---

## Testing these procedures

```bash
# What can be exercised.
DR_ENVIRONMENT=staging ./infra/disaster-recovery-test.sh --list

# Safe walkthrough — no destructive steps.
DR_ENVIRONMENT=staging ./infra/disaster-recovery-test.sh --all --dry-run

# The real thing, against an isolated environment.
DR_ENVIRONMENT=staging ./infra/disaster-recovery-test.sh --all \
  --json-report "dr-$(date -u +%Y%m%d).json"
```

### Safety

The script mutates databases and deletes files. It refuses to run when
`DR_ENVIRONMENT`, the bucket name, the database path, or the API URL contains
`prod`, `production`, `live`, or `mainnet`, and exits with status 2. The
override flag exists to be a deliberate, logged act:

```
--i-understand-this-is-production
```

**Do not use this script during a real incident.** Production recovery is the
operator-led procedure documented above.

`DR_FORBIDDEN_ACCOUNT_IDS` adds a second, independent guard by AWS account id,
for the case where a production resource simply is not named like one.

### Monthly dry run

On the first business day of each month:

1. Run the full suite against staging.
2. Compare durations against the previous exercise — a scenario that is getting
   slower is a warning.
3. File an issue for every failure. A failing recovery exercise is a production
   risk, not a test-maintenance chore.
4. Commit the JSON report to `docs/dr-exercises/`.
5. Review this runbook against what actually happened and correct it.

### Quarterly full exercise

Once a quarter, additionally:

- Destroy and recreate the staging environment end to end
- Restore from a backup at least 30 days old — this is what catches key
  rotations and schema drift that a fresh backup hides
- Rehearse without the primary on-call engineer present, which is the only way
  to find out whether the runbook is genuinely followable

### Interpreting a report

```json
{
  "environment": "staging",
  "rtoTargetSeconds": 3600,
  "scenarios": [
    {
      "scenario": "database-restore",
      "status": "passed",
      "durationSeconds": 5,
      "checkpoints": [
        { "name": "backup-taken", "elapsedSeconds": 1 },
        { "name": "restore-completed", "elapsedSeconds": 3 },
        { "name": "integrity-verified", "elapsedSeconds": 5 }
      ]
    }
  ]
}
```

Checkpoints are what make a slow recovery diagnosable. "The restore took 40
minutes" is not actionable; "38 of those 40 were the download" is.

A scenario that **passes but exceeds the RTO** is reported as failed. That is
intentional — succeeding too slowly is still failing the objective.

---

## Escalation

| Level | Who | When |
|---|---|---|
| 1 | On-call engineer | Any incident. Executes recovery. |
| 2 | Database lead | Data integrity in doubt; restore fails verification. |
| 3 | Platform lead | Infrastructure recreation; AZ or region failure. |
| 4 | Engineering lead | RTO at risk; data loss confirmed; external communication. |

Escalate immediately, without waiting, when:

- Two consecutive backups fail verification
- Recovery passes 45 minutes against a 1-hour RTO
- Confirmed data loss beyond the 24-hour RPO
- The backup encryption key is unrecoverable
- Funds were distributed to the wrong recipients — this is not recoverable by
  any procedure here and needs the engineering lead immediately

---

## Post-incident

Within 48 hours:

- [ ] Timeline written: detection, response, recovery, verification
- [ ] Root cause identified — the cause, not the symptom
- [ ] Actual RTO recorded against the target
- [ ] Data loss window quantified
- [ ] This runbook corrected where it was wrong or unclear
- [ ] A regression test added if a code defect was involved
- [ ] Detection reviewed: was it caught by an alarm, or by a person?
- [ ] Report filed in `docs/incident-response/`

The last two matter most. An incident that was noticed by a user rather than an
alarm is a monitoring failure as well as an availability one, and a runbook
step that was wrong during an incident will be wrong during the next one unless
it is fixed now.

---

## Related documentation

- [`infra/disaster-recovery-test.sh`](../infra/disaster-recovery-test.sh) — the executable exercises
- [`backup-strategy.md`](backup-strategy.md) — schedule, retention, RTO and RPO
- [`disaster-recovery-runbook.md`](disaster-recovery-runbook.md) — step-by-step database restore detail
- [`operator-runbook.md`](operator-runbook.md) — day-to-day operations
- [`infra/terraform/README.md`](../infra/terraform/README.md) — infrastructure definition
- [`DEPLOYMENT.md`](../DEPLOYMENT.md) — deployment and contract rollback
