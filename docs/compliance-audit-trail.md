# Compliance audit trail (#938)

The `audit_log` table in the application database is convenient to query but
offers no guarantees: anyone with write access to `audit.db` can change it.
The compliance record is a separate, **append-only, hash-chained** trail.

## Guarantees

| Property | Mechanism |
|---|---|
| Every state change is recorded | `addAuditLog` (all 30+ call sites), `recordTransaction`, `updateTransactionHash`, `updateTransactionStatus` and `addDistributionPayout` append to the trail |
| Entries cannot be modified | SQLite trigger aborts every `UPDATE` |
| Entries cannot be deleted early | Trigger aborts `DELETE` of any entry inside its retention period, of any entry that is not the oldest, and of any entry not covered by a retention anchor. The trigger uses SQLite's clock, so a faked application clock cannot purge early |
| Tampering outside the app is detected | Each entry stores the hash of the previous one. Editing, deleting or reordering any entry breaks verification from that point on |
| The chain cannot be quietly rebuilt | With `AUDIT_TRAIL_HMAC_KEY` set, entries are chained with HMAC-SHA256; without the key a forged chain does not verify |
| Off-box, immutable copy | Daily SOX export (with the chain head hash) is written to an S3 **Object Lock (COMPLIANCE)** bucket, 7-year retention (`infra/terraform/audit-service.tf`). The instance can only `PutObject` |
| Periodic tamper detection | Full-chain verification hourly (`AUDIT_TRAIL_VERIFY_INTERVAL_MS`) and at startup; each result is itself stored append-only |
| Retention | 7 years (`AUDIT_TRAIL_RETENTION_DAYS=2557`); expired entries are purged oldest-first behind an anchor so the rest still verifies |

Recording is **fail-open**: if the trail cannot be written, the request still
succeeds, but the failure is logged (`audit_trail_write_failure`), counted
(`stellar_audit_trail_write_failures_total`) and alerted on. Taking the API
down because of an audit-disk problem was judged the worse outcome; change
this in `recordAuditEvent` if your compliance regime requires fail-closed.

## Alerts

- `stellar_audit_trail_integrity_ok == 0` → `RoyaltySplitterAuditTrailTampered` (Prometheus) and the
  `…-audit-trail-tampered` CloudWatch alarm; optional webhook `AUDIT_TRAIL_ALERT_WEBHOOK_URL`.
- No verification in 3 hours → `RoyaltySplitterAuditTrailVerificationStale` / `…-audit-trail-unverified`.
- Write failures → `RoyaltySplitterAuditTrailWriteFailures` / `…-audit-trail-write-failures`.

## Admin API

All endpoints need `Authorization: Bearer $ADMIN_ROTATE_TOKEN` (or an admin role).

```bash
# Chain head, entry count, retention, last verification
curl -H "Authorization: Bearer $TOKEN" https://api/admin/audit-trail/status

# Verify now: 200 intact, 409 tampered (body lists failing entries)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' \
  https://api/admin/audit-trail/verify

# Regulatory export (JSON or CSV). Response header X-Report-SHA256 is the digest of the body.
curl -H "Authorization: Bearer $TOKEN" \
  "https://api/admin/audit-trail/export?standard=SOX&format=csv&from=2026-01-01T00:00:00Z&to=2026-03-31T23:59:59Z"
```

| `standard` | Content |
|---|---|
| `SOX` | Every entry in the period with integrity attestation (chain verified, head hash, algorithm) and retention check |
| `FINRA` | Same record set, labelled for Rule 4511 / SEC 17a-4; the Object Lock archive is the non-rewriteable copy |
| `GDPR` | Requires `subject`; returns only entries whose actor is that data subject (Article 15 access request) |

CSV exports carry the metadata as a leading `#` comment line and neutralise
spreadsheet formulas in cell values.

**GDPR erasure** conflicts with an immutable log by design. Payloads are
stripped of secrets and credentials before recording (`stripSensitiveDetails`);
record personal data elsewhere and reference it by id if erasure must be
possible.
