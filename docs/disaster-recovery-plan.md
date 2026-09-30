# Disaster Recovery Plan — Stellar Royalty Splitter

**Version:** 1.0  
**Last reviewed:** 2026-09-28  
**Owner:** Backend Engineering  
**RTO target:** < 1 hour  
**RPO target:** < 1 day  

---

## 1. Overview

Each Soroban smart contract holds the authoritative on-chain state for a royalty split arrangement. If a contract is frozen, exploited, or its associated off-chain database is lost, this plan provides the procedures to restore service with minimal data loss.

The backup system:
- Takes a full JSON snapshot of all off-chain state weekly
- Pins snapshots to IPFS via Pinata (content-addressed, immutable)
- Retains 52 weeks of history per contract
- Runs non-destructive recovery drills monthly to verify RTO/RPO

---

## 2. Backup Architecture

### 2.1 Snapshot contents

Each snapshot (version 1) contains:

| Field | Description |
|---|---|
| `version` | Schema version (currently `1`) |
| `contractId` | Soroban contract address (C…) |
| `snapshotAt` | ISO 8601 UTC timestamp |
| `transactions` | All transaction records |
| `distributionPayouts` | All payout records linked to transactions |
| `secondarySales` | All secondary sale records |
| `secondaryRoyaltyDistributions` | All secondary distribution records |
| `auditLog` | Full audit trail |
| `metrics` | Count cross-checks for validation |

### 2.2 Storage

Snapshots are uploaded to IPFS via the [Pinata](https://pinata.cloud) pinning API. The resulting CID is stored in the `contract_backups` table alongside metadata. CIDs are content-addressed — the same data always produces the same CID, making tampering detectable.

### 2.3 Retention

- 52 completed snapshots per contract (rolling 52-week window)
- Old snapshots are pruned from the DB index after each successful backup
- IPFS pins are **not** automatically unpinned — Pinata manages persistence independently

### 2.4 Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PINATA_JWT` | *(none)* | Pinata API JWT. If unset, backups run in dry-run mode |
| `IPFS_GATEWAY_BASE` | `https://gateway.pinata.cloud/ipfs` | Primary IPFS gateway |
| `BACKUP_CHECK_INTERVAL_MS` | `3600000` (1 h) | How often the scheduler checks for due backups |
| `BACKUP_UPLOAD_TIMEOUT_MS` | `30000` (30 s) | Pinata upload timeout |
| `DR_FETCH_TIMEOUT_MS` | `15000` (15 s) | Per-gateway fetch timeout during recovery |
| `DR_RPO_THRESHOLD_MS` | `86400000` (24 h) | RPO threshold for drill pass/fail reporting |

---

## 3. Recovery Procedures

### 3.1 Triggering a manual backup

```bash
curl -X POST https://<your-api>/api/v1/backup/trigger \
  -H "Authorization: Bearer $ADMIN_ROTATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contractId": "C...", "force": true}'
```

Response includes `backupId`, `cid`, `gatewayUrl`, and payload metrics.

### 3.2 Listing backup history

```bash
curl https://<your-api>/api/v1/backup/<contractId>
```

### 3.3 Exporting a recovery bundle

```bash
curl https://<your-api>/api/v1/backup/<contractId>/export/<backupId> \
  -H "Authorization: Bearer $ADMIN_ROTATE_TOKEN"
```

The bundle contains:
- `migrationManifest` — what needs to happen and estimated time
- `collaborators` — unique list of `{ address, totalReceived }`
- `transactionHistory` — all transactions with embedded payouts
- `secondarySales` — secondary market records
- `auditLog` — full audit trail

### 3.4 Full contract migration runbook

**Estimated time: 20–45 minutes**

**Step 1 — Declare incident** (0–5 min)  
Notify team. Identify affected `contractId`. Pause any automated distributions via `PATCH /api/v1/schedules/:id` with `{ "enabled": false }`.

**Step 2 — Export recovery bundle** (5–10 min)  
Run the export endpoint (§3.3). Verify `migrationManifest.collaboratorCount` matches expectations.

**Step 3 — Deploy new contract** (10–20 min)  
Deploy a new Soroban contract instance. Note the new `contractId`.

**Step 4 — Reinitialise** (20–30 min)  
Call `POST /api/v1/initialize` with the new `contractId` and the `collaborators` list from the bundle. Verify on-chain state matches the bundle.

**Step 5 — Restore historical data** (30–40 min)  
The recovery bundle's `transactionHistory` and `auditLog` are the source of truth for historical records. Import into the new contract's off-chain DB via direct SQL insert or a migration script.

**Step 6 — Update client applications** (40–50 min)  
Update any stored `lastContractId` references in client apps and environment configs to point to the new contract.

**Step 7 — Verify and re-enable** (50–60 min)  
Run a recovery drill against the new contract's first backup. Re-enable distribution schedules.

---

## 4. Recovery Drills

Monthly drills validate that:
1. The latest snapshot can be fetched from IPFS
2. The snapshot passes structural and count-integrity validation
3. The snapshot age is within the RPO threshold
4. The full drill completes within the RTO budget

### 4.1 Running a drill

```bash
curl -X POST https://<your-api>/api/v1/backup/<contractId>/drill \
  -H "Authorization: Bearer $ADMIN_ROTATE_TOKEN"
```

Response:
```json
{
  "passed": true,
  "backupId": 42,
  "cid": "bafybeig...",
  "durationMs": 1842,
  "rpoWithinThreshold": true,
  "snapshotAgeMs": 172800000,
  "validationErrors": [],
  "summary": "Drill PASSED in 1842ms. Snapshot age: 2880min. RPO within threshold: true."
}
```

### 4.2 Drill schedule

| Frequency | Action |
|---|---|
| Weekly (automated) | Full snapshot taken, CID stored |
| Monthly (manual trigger) | Recovery drill via API |
| After any incident | Full migration runbook execution |

### 4.3 Drill result interpretation

| `passed` | `rpoWithinThreshold` | Meaning |
|---|---|---|
| `true` | `true` | ✅ Healthy — no action needed |
| `true` | `false` | ⚠️ Snapshot is stale — check backup scheduler |
| `false` | any | ❌ Data integrity issue — investigate immediately |

---

## 5. RTO / RPO Compliance

| Metric | Target | How achieved |
|---|---|---|
| **RTO** | < 1 hour | Migration runbook (§3.4) designed for 20–45 min; drill measures actual time |
| **RPO** | < 1 day | Weekly automated snapshots; manual trigger available for < 1-day gap |

If the backup scheduler has been offline for more than 7 days, trigger a manual backup immediately and investigate the cause before declaring RPO compliance.

---

## 6. Dry-Run Mode

When `PINATA_JWT` is not set, the backup service operates in **dry-run mode**:
- Snapshots are built and validated normally
- No data is uploaded to IPFS
- A deterministic stub CID is stored (`bafyDRYRUN…`)
- Recovery drills will fail in dry-run mode because stub CIDs cannot be fetched

Set `PINATA_JWT` in production to enable real IPFS persistence.

---

## 7. Contacts and Escalation

| Role | Responsibility |
|---|---|
| On-call engineer | Initial incident response, trigger manual backup |
| Contract owner | Authorise new contract deployment |
| Backend lead | Oversee migration, update client apps |

For P0 incidents (complete contract loss), escalate within 15 minutes of detection.
