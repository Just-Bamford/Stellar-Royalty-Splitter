/**
 * Compliance audit trail service (#938).
 *
 * Wraps the append-only, hash-chained store in database/audit-trail-immutable.js
 * with the parts that make it operable:
 *
 *   - recordAuditEvent(): called for every state change (addAuditLog and the
 *     transaction lifecycle feed it). Fail-open: a broken audit store must not
 *     take the API down, so a failed append is logged at error level, counted in
 *     `stellar_audit_trail_write_failures_total`, and alerted on instead.
 *   - startAuditTrailVerifier(): re-verifies the whole hash chain on an
 *     interval, records the result, ships the head hash off-box as a
 *     checkpoint log line, and alerts on any integrity failure.
 *   - enforceRetention(): purges entries older than the retention period
 *     (7 years by default), oldest first, behind an anchor.
 *   - buildComplianceExport(): SOX / FINRA / GDPR report bundles in JSON or CSV,
 *     each carrying the chain verification result and a digest of its own body.
 *
 * Configuration:
 *   AUDIT_TRAIL_DB_PATH               Separate SQLite file (default: backend/audit-trail.db)
 *   AUDIT_TRAIL_HMAC_KEY              Enables HMAC-SHA256 chaining (recommended in production)
 *   AUDIT_TRAIL_RETENTION_DAYS        Default 2557 (7 years)
 *   AUDIT_TRAIL_VERIFY_INTERVAL_MS    Default 3600000 (hourly)
 *   AUDIT_TRAIL_ALERT_WEBHOOK_URL     Optional: POSTed to on integrity failure
 *   AUDIT_TRAIL_ENABLED               Set to "false" to disable entirely
 */

import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import logger from "../logger.js";
import {
  ImmutableAuditStore,
  DEFAULT_RETENTION_DAYS,
  canonicalize,
} from "../database/audit-trail-immutable.js";
import { recordAuditTrailVerification, recordAuditTrailWriteFailure } from "../metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const COMPLIANCE_STANDARDS = {
  SOX: {
    name: "Sarbanes-Oxley Act §802 / §404",
    minimumRetentionYears: 7,
    description:
      "Complete, ordered record of every state change affecting financial distributions, with integrity attestation.",
  },
  FINRA: {
    name: "FINRA Rule 4511 / SEC Rule 17a-4",
    minimumRetentionYears: 6,
    description:
      "Books-and-records export in non-rewriteable, non-erasable form; retained beyond the six-year minimum.",
  },
  GDPR: {
    name: "GDPR Article 15 (right of access) / Article 30 (records of processing)",
    minimumRetentionYears: null,
    description:
      "Processing record for a data subject. Filter by `subject` to produce a subject-access export.",
  },
};

let store = null;
let verifierTimer = null;

function isEnabled() {
  return process.env.AUDIT_TRAIL_ENABLED !== "false";
}

function retentionDaysFromEnv() {
  const parsed = parseInt(process.env.AUDIT_TRAIL_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

/** Lazily open the store so importing this module never touches disk. */
export function getAuditTrailStore() {
  if (!store) {
    store = new ImmutableAuditStore({
      path: process.env.AUDIT_TRAIL_DB_PATH ?? path.join(__dirname, "..", "..", "audit-trail.db"),
      hmacKey: process.env.AUDIT_TRAIL_HMAC_KEY || null,
      retentionDays: retentionDaysFromEnv(),
    });
    if (!process.env.AUDIT_TRAIL_HMAC_KEY && process.env.NODE_ENV === "production") {
      logger.warn(
        "AUDIT_TRAIL_HMAC_KEY is not set: the audit trail is chained with plain SHA-256, so an attacker with write access to the file could rebuild a valid chain",
        { event: "audit_trail_unkeyed" },
      );
    }
  }
  return store;
}

/** Swap the backing store — tests use an in-memory database. */
export function setAuditTrailStore(next) {
  store = next;
}

export function closeAuditTrail() {
  stopAuditTrailVerifier();
  if (store) {
    store.close();
    store = null;
  }
}

/**
 * Append a state change. Never throws.
 * @returns {object|null} the stored entry, or null when it could not be written
 */
export function recordAuditEvent({ eventType, actor = null, contractId = null, payload = {} }) {
  if (!isEnabled()) return null;
  try {
    return getAuditTrailStore().append({ eventType, actor, contractId, payload });
  } catch (err) {
    recordAuditTrailWriteFailure();
    logger.error("Failed to append to immutable audit trail", {
      event: "audit_trail_write_failure",
      eventType,
      contractId,
      error: err.message ?? String(err),
    });
    return null;
  }
}

async function sendIntegrityAlert(result) {
  const url = process.env.AUDIT_TRAIL_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alert: "audit_trail_integrity_failure",
        severity: "critical",
        verifiedAt: result.verifiedAt,
        entriesChecked: result.entriesChecked,
        failures: result.failures.slice(0, 10),
        remedy:
          "Treat as a potential breach: preserve the audit-trail file, compare it against the last shipped checkpoint, and follow docs/incident-response.",
      }),
    });
    if (!response.ok) throw new Error(`webhook responded ${response.status}`);
  } catch (err) {
    logger.error("Failed to deliver audit-trail integrity alert", { error: err.message ?? String(err) });
  }
}

/**
 * Verify the full chain once, record metrics, and alert on failure.
 * The head hash is logged as a checkpoint: once shipped to the log store it is
 * the off-box reference that detects truncation of the newest entries.
 */
export async function verifyAuditTrail() {
  const result = getAuditTrailStore().verify();
  recordAuditTrailVerification(result);

  if (result.ok) {
    logger.info("Audit trail integrity verified", {
      event: "audit_trail_checkpoint",
      entriesChecked: result.entriesChecked,
      lastSeq: result.lastSeq,
      headHash: result.headHash,
    });
  } else {
    logger.error("Audit trail integrity verification FAILED", {
      event: "audit_trail_integrity_failure",
      entriesChecked: result.entriesChecked,
      failures: result.failures.slice(0, 10),
    });
    await sendIntegrityAlert(result);
  }
  return result;
}

export function enforceRetention() {
  const purged = getAuditTrailStore().purgeExpired();
  if (purged > 0) {
    logger.info("Audit trail retention enforced", { event: "audit_trail_retention_purge", purged });
  }
  return purged;
}

/**
 * Start periodic verification and retention enforcement.
 * Runs once immediately so a tampered trail is reported at startup.
 */
export function startAuditTrailVerifier({ intervalMs } = {}) {
  if (!isEnabled()) return null;
  const period =
    intervalMs ?? (parseInt(process.env.AUDIT_TRAIL_VERIFY_INTERVAL_MS ?? "3600000", 10) || 3_600_000);

  const tick = async () => {
    try {
      await verifyAuditTrail();
      enforceRetention();
    } catch (err) {
      logger.error("Audit trail verifier error", { error: err.message ?? String(err) });
    }
  };

  stopAuditTrailVerifier();
  tick();
  verifierTimer = setInterval(tick, period);
  if (verifierTimer.unref) verifierTimer.unref();
  return { stop: stopAuditTrailVerifier };
}

export function stopAuditTrailVerifier() {
  if (verifierTimer) {
    clearInterval(verifierTimer);
    verifierTimer = null;
  }
}

// ── Compliance export ────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  "seq",
  "eventId",
  "recordedAt",
  "eventType",
  "actor",
  "contractId",
  "payload",
  "prevHash",
  "hash",
  "hashAlg",
  "retentionUntil",
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : canonicalize(value);
  // Neutralise spreadsheet formula injection as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Build a regulatory export.
 *
 * @param {object} options
 * @param {"SOX"|"FINRA"|"GDPR"} options.standard
 * @param {string} [options.from]       ISO timestamp, inclusive
 * @param {string} [options.to]         ISO timestamp, inclusive
 * @param {string} [options.contractId]
 * @param {string} [options.subject]    GDPR data subject (matched against actor)
 * @param {"json"|"csv"} [options.format]
 * @returns {{ contentType: string, filename: string, body: string, report: object }}
 */
export function buildComplianceExport({ standard, from, to, contractId, subject, format = "json" }) {
  const spec = COMPLIANCE_STANDARDS[standard];
  if (!spec) {
    throw Object.assign(new Error(`Unsupported compliance standard: ${standard}`), { status: 400 });
  }
  if (format !== "json" && format !== "csv") {
    throw Object.assign(new Error(`Unsupported export format: ${format}`), { status: 400 });
  }
  if (standard === "GDPR" && !subject) {
    throw Object.assign(new Error("GDPR exports require a subject"), { status: 400 });
  }

  const trail = getAuditTrailStore();
  const verification = trail.verify({ record: false });
  const entries = trail.query({ from, to, contractId, actor: standard === "GDPR" ? subject : undefined });
  const retentionDays = trail.retentionDays;

  const metadata = {
    standard,
    regulation: spec.name,
    description: spec.description,
    generatedAt: new Date().toISOString(),
    period: { from: from ?? null, to: to ?? null },
    filters: { contractId: contractId ?? null, subject: subject ?? null },
    retention: {
      configuredDays: retentionDays,
      configuredYears: Math.floor(retentionDays / 365.25),
      meetsMinimum:
        spec.minimumRetentionYears === null || retentionDays >= spec.minimumRetentionYears * 365,
    },
    integrity: {
      chainVerified: verification.ok,
      entriesVerified: verification.entriesChecked,
      headHash: verification.headHash,
      hashAlgorithm: trail.hmacKey ? "hmac-sha256" : "sha256",
      failures: verification.failures,
    },
    entryCount: entries.length,
  };

  let body;
  let contentType;
  if (format === "csv") {
    const header = `# ${canonicalize(metadata)}`;
    const rows = entries.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(","));
    body = [header, CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
    contentType = "text/csv; charset=utf-8";
  } else {
    body = JSON.stringify({ metadata, entries }, null, 2);
    contentType = "application/json; charset=utf-8";
  }

  // Lets a recipient confirm the file they hold is the one that was generated.
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const stamp = metadata.generatedAt.replace(/[:.]/g, "-");
  return {
    contentType,
    filename: `audit-trail-${standard.toLowerCase()}-${stamp}.${format}`,
    body,
    digest,
    report: metadata,
  };
}
