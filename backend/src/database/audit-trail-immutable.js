/**
 * Immutable, hash-chained audit trail storage (#938).
 *
 * The regular `audit_log` table lives in the application database and can be
 * rewritten by anyone with write access to it. This store is the compliance
 * copy, and it differs in four ways:
 *
 *   1. It is a separate SQLite file (AUDIT_TRAIL_DB_PATH), so it can live on a
 *      different volume, carry different permissions, and be shipped
 *      independently of the operational database.
 *   2. It is append-only. SQLite triggers abort every UPDATE and every DELETE
 *      of an entry whose retention period has not expired.
 *   3. Every entry carries the hash of the previous entry. Changing, removing
 *      or reordering any entry breaks every hash after it, so tampering that
 *      bypasses the triggers (e.g. editing the file directly) is detectable.
 *   4. When AUDIT_TRAIL_HMAC_KEY is set, entries are chained with
 *      HMAC-SHA256 instead of plain SHA-256. Someone who can write the file
 *      but does not hold the key cannot forge a chain that re-verifies.
 *
 * Retention: entries are kept for `retentionDays` (7 years by default) and may
 * only be purged oldest-first, after expiry, and only once an anchor recording
 * the last purged entry's hash exists. The anchor is what lets the remaining
 * chain still be verified from its first surviving entry.
 */

import Database from "better-sqlite3";
import crypto from "crypto";

export const GENESIS_HASH = "0".repeat(64);
// 7 years including leap days — the SOX/FINRA retention horizon.
export const DEFAULT_RETENTION_DAYS = 2557;

const MAX_REPORTED_FAILURES = 50;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit_trail (
    seq             INTEGER PRIMARY KEY,
    event_id        TEXT NOT NULL UNIQUE,
    recorded_at     TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    actor           TEXT,
    contract_id     TEXT,
    payload         TEXT NOT NULL,
    prev_hash       TEXT NOT NULL,
    hash            TEXT NOT NULL UNIQUE,
    hash_alg        TEXT NOT NULL CHECK(hash_alg IN ('sha256', 'hmac-sha256')),
    retention_until TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_trail_recorded_at ON audit_trail(recorded_at);
  CREATE INDEX IF NOT EXISTS idx_audit_trail_contract_id ON audit_trail(contract_id);
  CREATE INDEX IF NOT EXISTS idx_audit_trail_actor ON audit_trail(actor);

  -- Head of the chain at the moment entries were purged. Verification of the
  -- surviving entries starts from the newest anchor.
  CREATE TABLE IF NOT EXISTS audit_trail_anchors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    anchored_at TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    hash        TEXT NOT NULL,
    reason      TEXT NOT NULL
  );

  -- Evidence that integrity was checked, and what the result was.
  CREATE TABLE IF NOT EXISTS audit_trail_verifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    verified_at     TEXT NOT NULL,
    ok              INTEGER NOT NULL,
    entries_checked INTEGER NOT NULL,
    first_seq       INTEGER,
    last_seq        INTEGER,
    head_hash       TEXT,
    failures        TEXT
  );

  CREATE TRIGGER IF NOT EXISTS audit_trail_no_update
  BEFORE UPDATE ON audit_trail
  BEGIN
    SELECT RAISE(ABORT, 'audit_trail is append-only: updates are forbidden');
  END;

  CREATE TRIGGER IF NOT EXISTS audit_trail_no_early_delete
  BEFORE DELETE ON audit_trail
  WHEN OLD.retention_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  BEGIN
    SELECT RAISE(ABORT, 'audit_trail entry is still inside its retention period');
  END;

  CREATE TRIGGER IF NOT EXISTS audit_trail_delete_oldest_first
  BEFORE DELETE ON audit_trail
  WHEN EXISTS (SELECT 1 FROM audit_trail WHERE seq < OLD.seq)
  BEGIN
    SELECT RAISE(ABORT, 'audit_trail entries may only be purged oldest-first');
  END;

  CREATE TRIGGER IF NOT EXISTS audit_trail_delete_requires_anchor
  BEFORE DELETE ON audit_trail
  WHEN NOT EXISTS (SELECT 1 FROM audit_trail_anchors WHERE seq >= OLD.seq)
  BEGIN
    SELECT RAISE(ABORT, 'audit_trail purge requires an anchor covering the entry');
  END;

  CREATE TRIGGER IF NOT EXISTS audit_trail_anchors_no_update
  BEFORE UPDATE ON audit_trail_anchors
  BEGIN
    SELECT RAISE(ABORT, 'audit_trail_anchors is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS audit_trail_anchors_no_delete
  BEFORE DELETE ON audit_trail_anchors
  BEGIN
    SELECT RAISE(ABORT, 'audit_trail_anchors is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS audit_trail_verifications_no_update
  BEFORE UPDATE ON audit_trail_verifications
  BEGIN
    SELECT RAISE(ABORT, 'audit_trail_verifications is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS audit_trail_verifications_no_delete
  BEFORE DELETE ON audit_trail_verifications
  BEGIN
    SELECT RAISE(ABORT, 'audit_trail_verifications is append-only');
  END;
`;

/**
 * Deterministic JSON: object keys sorted recursively, so the same logical
 * payload always produces the same bytes and therefore the same hash.
 */
export function canonicalize(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

/**
 * Hash one entry. The payload is hashed in its stored (canonical string) form
 * so verification never depends on re-serialising parsed JSON.
 */
export function computeEntryHash(entry, hmacKey = null) {
  const material = canonicalize({
    seq: entry.seq,
    eventId: entry.eventId,
    recordedAt: entry.recordedAt,
    eventType: entry.eventType,
    actor: entry.actor ?? null,
    contractId: entry.contractId ?? null,
    payload: entry.payload,
    prevHash: entry.prevHash,
    retentionUntil: entry.retentionUntil,
  });
  if (entry.hashAlg === "hmac-sha256") {
    if (!hmacKey) throw new Error("HMAC key required to hash an hmac-sha256 entry");
    return crypto.createHmac("sha256", hmacKey).update(material).digest("hex");
  }
  return crypto.createHash("sha256").update(material).digest("hex");
}

function rowToEntry(row) {
  return {
    seq: row.seq,
    eventId: row.event_id,
    recordedAt: row.recorded_at,
    eventType: row.event_type,
    actor: row.actor,
    contractId: row.contract_id,
    payload: row.payload,
    prevHash: row.prev_hash,
    hash: row.hash,
    hashAlg: row.hash_alg,
    retentionUntil: row.retention_until,
  };
}

export class ImmutableAuditStore {
  /**
   * @param {object} options
   * @param {string} [options.path]           SQLite file (":memory:" for tests)
   * @param {object} [options.db]             An already-open better-sqlite3 handle
   * @param {string|null} [options.hmacKey]   Enables HMAC-SHA256 chaining
   * @param {number} [options.retentionDays]
   * @param {() => Date} [options.now]        Clock, injectable for tests
   */
  constructor({ path, db, hmacKey = null, retentionDays = DEFAULT_RETENTION_DAYS, now } = {}) {
    if (!db && !path) throw new Error("ImmutableAuditStore requires a path or db");
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      throw new Error("retentionDays must be a positive number");
    }
    this.db = db ?? new Database(path);
    this.hmacKey = hmacKey || null;
    this.retentionDays = retentionDays;
    this.now = now ?? (() => new Date());

    this.db.pragma("journal_mode = WAL");
    // The stable and canary API processes may append concurrently.
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  /** Newest anchor, or null when nothing has ever been purged. */
  latestAnchor() {
    return (
      this.db
        .prepare("SELECT seq, hash, anchored_at AS anchoredAt FROM audit_trail_anchors ORDER BY id DESC LIMIT 1")
        .get() ?? null
    );
  }

  /** Last entry's seq and hash — the point the next entry chains from. */
  head() {
    const last = this.db.prepare("SELECT seq, hash FROM audit_trail ORDER BY seq DESC LIMIT 1").get();
    if (last) return { seq: last.seq, hash: last.hash };
    const anchor = this.latestAnchor();
    if (anchor) return { seq: anchor.seq, hash: anchor.hash };
    return { seq: 0, hash: GENESIS_HASH };
  }

  /**
   * Append one event. Runs inside an IMMEDIATE transaction so two processes
   * appending at once serialise rather than both chaining off the same head.
   */
  append({ eventType, actor = null, contractId = null, payload = {} }) {
    if (typeof eventType !== "string" || !eventType) {
      throw new Error("eventType is required");
    }
    const insert = this.db.prepare(`
      INSERT INTO audit_trail
        (seq, event_id, recorded_at, event_type, actor, contract_id, payload,
         prev_hash, hash, hash_alg, retention_until)
      VALUES (@seq, @eventId, @recordedAt, @eventType, @actor, @contractId, @payload,
              @prevHash, @hash, @hashAlg, @retentionUntil)
    `);

    const run = this.db.transaction(() => {
      const head = this.head();
      const recorded = this.now();
      const entry = {
        seq: head.seq + 1,
        eventId: crypto.randomUUID(),
        recordedAt: recorded.toISOString(),
        eventType,
        actor: actor ?? null,
        contractId: contractId ?? null,
        payload: canonicalize(payload ?? {}),
        prevHash: head.hash,
        hashAlg: this.hmacKey ? "hmac-sha256" : "sha256",
        retentionUntil: new Date(recorded.getTime() + this.retentionDays * 86_400_000).toISOString(),
      };
      entry.hash = computeEntryHash(entry, this.hmacKey);
      insert.run(entry);
      return entry;
    });

    return typeof run.immediate === "function" ? run.immediate() : run();
  }

  /**
   * Walk the chain and recompute every hash.
   *
   * Detects: modified fields (hash mismatch), deleted or reordered entries
   * (seq gap / prev_hash mismatch), a truncated head is not detectable from
   * the file alone — which is why each verification's head hash is recorded
   * and shipped off-box as a checkpoint.
   *
   * @param {object} [options]
   * @param {boolean} [options.record=true] Persist the result as evidence.
   */
  verify({ record = true } = {}) {
    const anchor = this.latestAnchor();
    let expectedSeq = anchor ? anchor.seq + 1 : 1;
    let expectedPrev = anchor ? anchor.hash : GENESIS_HASH;
    const failures = [];
    let checked = 0;
    let firstSeq = null;
    let lastSeq = null;
    let headHash = anchor ? anchor.hash : GENESIS_HASH;

    const fail = (seq, reason) => {
      if (failures.length < MAX_REPORTED_FAILURES) failures.push({ seq, reason });
    };

    const rows = this.db.prepare("SELECT * FROM audit_trail ORDER BY seq ASC").iterate();
    for (const row of rows) {
      const entry = rowToEntry(row);
      checked += 1;
      if (firstSeq === null) firstSeq = entry.seq;
      lastSeq = entry.seq;

      if (entry.seq !== expectedSeq) {
        fail(entry.seq, `sequence gap: expected ${expectedSeq}, found ${entry.seq}`);
      }
      if (entry.prevHash !== expectedPrev) {
        fail(entry.seq, "prev_hash does not match the preceding entry");
      }

      let recomputed = null;
      try {
        recomputed = computeEntryHash(entry, this.hmacKey);
      } catch (err) {
        fail(entry.seq, err.message);
      }
      if (recomputed !== null && recomputed !== entry.hash) {
        fail(entry.seq, "hash mismatch: entry contents were modified");
      }

      expectedSeq = entry.seq + 1;
      expectedPrev = entry.hash;
      headHash = entry.hash;
    }

    const result = {
      ok: failures.length === 0,
      verifiedAt: this.now().toISOString(),
      entriesChecked: checked,
      firstSeq,
      lastSeq,
      headHash,
      anchor,
      failures,
    };

    if (record) {
      this.db
        .prepare(`
          INSERT INTO audit_trail_verifications
            (verified_at, ok, entries_checked, first_seq, last_seq, head_hash, failures)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          result.verifiedAt,
          result.ok ? 1 : 0,
          checked,
          firstSeq,
          lastSeq,
          headHash,
          failures.length ? JSON.stringify(failures) : null,
        );
    }

    return result;
  }

  lastVerification() {
    const row = this.db
      .prepare("SELECT * FROM audit_trail_verifications ORDER BY id DESC LIMIT 1")
      .get();
    if (!row) return null;
    return {
      verifiedAt: row.verified_at,
      ok: row.ok === 1,
      entriesChecked: row.entries_checked,
      firstSeq: row.first_seq,
      lastSeq: row.last_seq,
      headHash: row.head_hash,
      failures: row.failures ? JSON.parse(row.failures) : [],
    };
  }

  /**
   * Entries in a time range, oldest first, with payloads parsed.
   * @param {{from?: string, to?: string, contractId?: string, actor?: string}} filters
   */
  query({ from, to, contractId, actor } = {}) {
    const conditions = [];
    const params = [];
    if (from) {
      conditions.push("recorded_at >= ?");
      params.push(from);
    }
    if (to) {
      conditions.push("recorded_at <= ?");
      params.push(to);
    }
    if (contractId) {
      conditions.push("contract_id = ?");
      params.push(contractId);
    }
    if (actor) {
      conditions.push("actor = ?");
      params.push(actor);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM audit_trail ${where} ORDER BY seq ASC`)
      .all(...params)
      .map((row) => {
        const entry = rowToEntry(row);
        let payload = null;
        try {
          payload = JSON.parse(entry.payload);
        } catch {
          // Leave unparseable payloads as null; the hash covers the raw text.
        }
        return { ...entry, payload };
      });
  }

  /**
   * Remove entries whose retention has expired, oldest first. An anchor for
   * the newest purged entry is written first so the surviving chain still
   * verifies. Returns the number of entries purged.
   */
  purgeExpired() {
    const cutoff = this.now().toISOString();
    const run = this.db.transaction(() => {
      const expired = this.db
        .prepare(`
          SELECT seq, hash FROM audit_trail
          WHERE seq <= (
            SELECT COALESCE(MIN(seq) - 1, (SELECT MAX(seq) FROM audit_trail))
            FROM audit_trail WHERE retention_until > ?
          )
          ORDER BY seq ASC
        `)
        .all(cutoff);
      if (expired.length === 0) return 0;

      const last = expired[expired.length - 1];
      this.db
        .prepare("INSERT INTO audit_trail_anchors (anchored_at, seq, hash, reason) VALUES (?, ?, ?, ?)")
        .run(cutoff, last.seq, last.hash, "retention_purge");

      const del = this.db.prepare("DELETE FROM audit_trail WHERE seq = ?");
      for (const { seq } of expired) del.run(seq);
      return expired.length;
    });
    return run();
  }

  count() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM audit_trail").get()?.n ?? 0;
  }

  close() {
    if (this.db.open) this.db.close();
  }
}
