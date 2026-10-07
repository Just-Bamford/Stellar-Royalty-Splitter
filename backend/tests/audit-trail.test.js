/**
 * Immutable audit trail (#938).
 *
 * Uses the real better-sqlite3 binding (loaded by path, bypassing the global
 * no-op mock) because the append-only guarantees are enforced by SQLite
 * triggers and cannot be exercised against a stub.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { createRequire } from "module";
import path from "path";
import crypto from "crypto";
import express from "express";
import request from "supertest";

import {
  ImmutableAuditStore,
  GENESIS_HASH,
  canonicalize,
  computeEntryHash,
} from "../src/database/audit-trail-immutable.js";
import {
  buildComplianceExport,
  recordAuditEvent,
  setAuditTrailStore,
  verifyAuditTrail,
  enforceRetention,
} from "../src/services/audit-trail.js";
import { auditTrailRouter } from "../src/routes/audit-trail.js";
import { prometheusMetrics, resetMetrics } from "../src/metrics.js";

const require = createRequire(import.meta.url);
const Database = require(path.resolve("node_modules/better-sqlite3/lib/index.js"));

const YEAR_MS = 365.25 * 86_400_000;

function newStore(options = {}) {
  return new ImmutableAuditStore({ db: new Database(":memory:"), ...options });
}

function appendSample(store, n = 3) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push(
      store.append({
        eventType: "distribution_initiated",
        actor: `GACTOR${i}`,
        contractId: "CCONTRACT",
        payload: { transactionId: i + 1, tokenId: "CTOKEN" },
      }),
    );
  }
  return entries;
}

describe("canonicalize", () => {
  test("is independent of key order", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalize({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });

  test("serialises bigint and drops undefined keys", () => {
    expect(canonicalize({ a: 10n, b: undefined })).toBe('{"a":"10"}');
  });
});

describe("ImmutableAuditStore — hash chain", () => {
  let store;
  beforeEach(() => {
    store = newStore();
  });
  afterEach(() => store.close());

  test("chains each entry to the previous one from the genesis hash", () => {
    const [first, second, third] = appendSample(store);
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
    expect(first.hash).toBe(computeEntryHash(first));
  });

  test("verifies an untouched chain and records the verification", () => {
    appendSample(store, 5);
    const result = store.verify();
    expect(result.ok).toBe(true);
    expect(result.entriesChecked).toBe(5);
    expect(result.lastSeq).toBe(5);
    expect(store.lastVerification()).toMatchObject({ ok: true, entriesChecked: 5 });
  });

  test("sets retention to 7 years by default", () => {
    const [entry] = appendSample(store, 1);
    const years = (Date.parse(entry.retentionUntil) - Date.parse(entry.recordedAt)) / YEAR_MS;
    expect(years).toBeCloseTo(7, 1);
  });
});

describe("ImmutableAuditStore — append-only enforcement", () => {
  let store;
  beforeEach(() => {
    store = newStore();
    appendSample(store);
  });
  afterEach(() => store.close());

  test("rejects UPDATE of an entry", () => {
    expect(() => store.db.prepare("UPDATE audit_trail SET actor = 'GEVIL' WHERE seq = 2").run()).toThrow(
      /append-only/,
    );
  });

  test("rejects DELETE of an entry still inside its retention period", () => {
    // Even with an anchor covering it, an unexpired entry cannot be removed.
    const head = store.head();
    store.db
      .prepare("INSERT INTO audit_trail_anchors (anchored_at, seq, hash, reason) VALUES (?, ?, ?, 'test')")
      .run(new Date().toISOString(), head.seq, head.hash);
    expect(() => store.db.prepare("DELETE FROM audit_trail WHERE seq = 1").run()).toThrow(
      /retention period/,
    );
  });

  test("rejects tampering with anchors and verification evidence", () => {
    store.verify();
    expect(() => store.db.prepare("DELETE FROM audit_trail_verifications").run()).toThrow(/append-only/);
    expect(() => store.db.prepare("UPDATE audit_trail_verifications SET ok = 1").run()).toThrow(/append-only/);
  });
});

describe("ImmutableAuditStore — tamper detection", () => {
  let store;
  beforeEach(() => {
    store = newStore();
    appendSample(store, 4);
  });
  afterEach(() => store.close());

  // Simulates an attacker editing the file directly, bypassing the triggers.
  function dropGuards() {
    for (const name of [
      "audit_trail_no_update",
      "audit_trail_no_early_delete",
      "audit_trail_delete_oldest_first",
      "audit_trail_delete_requires_anchor",
    ]) {
      store.db.exec(`DROP TRIGGER ${name}`);
    }
  }

  test("detects a modified payload", () => {
    dropGuards();
    store.db.prepare(`UPDATE audit_trail SET payload = '{"transactionId":999}' WHERE seq = 2`).run();
    const result = store.verify();
    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual({ seq: 2, reason: "hash mismatch: entry contents were modified" });
  });

  test("detects a deleted entry in the middle of the chain", () => {
    dropGuards();
    store.db.prepare("DELETE FROM audit_trail WHERE seq = 2").run();
    const result = store.verify();
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.seq)).toContain(3);
    expect(result.failures.some((f) => /sequence gap/.test(f.reason))).toBe(true);
  });

  test("detects a modified entry whose own hash was recomputed", () => {
    dropGuards();
    const row = store.db.prepare("SELECT * FROM audit_trail WHERE seq = 2").get();
    const forged = {
      seq: row.seq,
      eventId: row.event_id,
      recordedAt: row.recorded_at,
      eventType: row.event_type,
      actor: "GEVIL",
      contractId: row.contract_id,
      payload: row.payload,
      prevHash: row.prev_hash,
      hashAlg: row.hash_alg,
      retentionUntil: row.retention_until,
    };
    store.db
      .prepare("UPDATE audit_trail SET actor = ?, hash = ? WHERE seq = 2")
      .run("GEVIL", computeEntryHash(forged));
    const result = store.verify();
    expect(result.ok).toBe(false);
    // Entry 3 still points at the original hash of entry 2.
    expect(result.failures).toContainEqual({ seq: 3, reason: "prev_hash does not match the preceding entry" });
  });
});

describe("ImmutableAuditStore — HMAC keyed chain", () => {
  test("a chain rebuilt without the key does not verify", () => {
    const db = new Database(":memory:");
    const store = new ImmutableAuditStore({ db, hmacKey: "server-secret" });
    appendSample(store, 2);
    expect(store.verify().ok).toBe(true);

    const wrongKey = new ImmutableAuditStore({ db, hmacKey: "attacker-guess" });
    const result = wrongKey.verify({ record: false });
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toMatch(/hash mismatch/);

    const noKey = new ImmutableAuditStore({ db });
    expect(noKey.verify({ record: false }).failures[0].reason).toMatch(/HMAC key required/);
    store.close();
  });
});

describe("ImmutableAuditStore — retention", () => {
  test("purges only expired entries, oldest first, and the remaining chain still verifies", () => {
    const db = new Database(":memory:");
    const eightYearsAgo = new Date(Date.now() - 8 * YEAR_MS);
    const old = new ImmutableAuditStore({ db, now: () => eightYearsAgo });
    appendSample(old, 3);

    const current = new ImmutableAuditStore({ db });
    const [recent] = appendSample(current, 1);

    expect(current.purgeExpired()).toBe(3);
    expect(current.count()).toBe(1);
    expect(current.latestAnchor()).toMatchObject({ seq: 3 });
    expect(recent.seq).toBe(4);

    const result = current.verify();
    expect(result.ok).toBe(true);
    expect(result.firstSeq).toBe(4);

    // Anchors themselves are append-only.
    expect(() => db.prepare("DELETE FROM audit_trail_anchors").run()).toThrow(/append-only/);
    current.close();
  });

  test("a manual delete of an expired entry without an anchor is refused", () => {
    const db = new Database(":memory:");
    const store = new ImmutableAuditStore({ db, now: () => new Date(Date.now() - 8 * YEAR_MS) });
    appendSample(store, 2);
    expect(() => db.prepare("DELETE FROM audit_trail WHERE seq = 1").run()).toThrow(/anchor/);
    store.close();
  });

  test("a forged clock cannot purge entries that are not yet expired", () => {
    const db = new Database(":memory:");
    const store = new ImmutableAuditStore({ db });
    appendSample(store, 2);
    const timeTraveller = new ImmutableAuditStore({ db, now: () => new Date(Date.now() + 10 * YEAR_MS) });
    expect(() => timeTraveller.purgeExpired()).toThrow(/retention/);
    expect(store.count()).toBe(2);
    store.close();
  });
});

describe("audit-trail service", () => {
  let store;
  beforeEach(() => {
    store = newStore();
    setAuditTrailStore(store);
    resetMetrics();
  });
  afterEach(() => {
    setAuditTrailStore(null);
    store.close();
    delete process.env.AUDIT_TRAIL_ALERT_WEBHOOK_URL;
  });

  test("recordAuditEvent appends to the trail", () => {
    const entry = recordAuditEvent({ eventType: "royalty_rate_set", actor: "GA", contractId: "CC", payload: { rate: 500 } });
    expect(entry.seq).toBe(1);
    expect(store.count()).toBe(1);
  });

  test("recordAuditEvent fails open and counts the failure", async () => {
    setAuditTrailStore({
      append() {
        throw new Error("disk full");
      },
    });
    expect(recordAuditEvent({ eventType: "x" })).toBeNull();
    expect(await prometheusMetrics()).toMatch(/stellar_audit_trail_write_failures_total 1/);
  });

  test("verifyAuditTrail reports integrity via metrics and alerts on failure", async () => {
    appendSample(store, 2);
    let result = await verifyAuditTrail();
    expect(result.ok).toBe(true);
    expect(await prometheusMetrics()).toMatch(/stellar_audit_trail_integrity_ok 1/);

    store.db.exec("DROP TRIGGER audit_trail_no_update");
    store.db.prepare("UPDATE audit_trail SET actor = 'GEVIL' WHERE seq = 1").run();

    process.env.AUDIT_TRAIL_ALERT_WEBHOOK_URL = "https://alerts.example.test/hook";
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const originalFetch = global.fetch;
    global.fetch = fetchMock;
    try {
      result = await verifyAuditTrail();
    } finally {
      global.fetch = originalFetch;
    }

    expect(result.ok).toBe(false);
    expect(await prometheusMetrics()).toMatch(/stellar_audit_trail_integrity_ok 0/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.alert).toBe("audit_trail_integrity_failure");
  });

  test("enforceRetention is a no-op while nothing has expired", () => {
    appendSample(store, 2);
    expect(enforceRetention()).toBe(0);
    expect(store.count()).toBe(2);
  });
});

describe("compliance export", () => {
  let store;
  beforeEach(() => {
    store = newStore();
    setAuditTrailStore(store);
    appendSample(store, 3);
  });
  afterEach(() => {
    setAuditTrailStore(null);
    store.close();
  });

  test("SOX JSON export carries integrity attestation and a body digest", () => {
    const exported = buildComplianceExport({ standard: "SOX" });
    const parsed = JSON.parse(exported.body);
    expect(parsed.metadata.integrity.chainVerified).toBe(true);
    expect(parsed.metadata.retention.meetsMinimum).toBe(true);
    expect(parsed.entries).toHaveLength(3);
    expect(exported.digest).toBe(crypto.createHash("sha256").update(exported.body).digest("hex"));
  });

  test("FINRA CSV export neutralises spreadsheet formulas", () => {
    store.append({ eventType: "secondary_sale_recorded", actor: "=HYPERLINK(\"x\")", payload: {} });
    const exported = buildComplianceExport({ standard: "FINRA", format: "csv" });
    expect(exported.contentType).toMatch(/text\/csv/);
    expect(exported.body).toContain(`"'=HYPERLINK(""x"")"`);
    expect(exported.body.split("\n")[1]).toMatch(/^seq,eventId,recordedAt/);
  });

  test("GDPR export requires and filters by subject", () => {
    expect(() => buildComplianceExport({ standard: "GDPR" })).toThrow(/subject/);
    const parsed = JSON.parse(buildComplianceExport({ standard: "GDPR", subject: "GACTOR1" }).body);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].actor).toBe("GACTOR1");
  });

  test("rejects unknown standards", () => {
    expect(() => buildComplianceExport({ standard: "HIPAA" })).toThrow(/Unsupported/);
  });
});

describe("/admin/audit-trail routes", () => {
  const TOKEN = "test-admin-token-123";
  const app = express();
  app.use(express.json());
  app.use("/admin/audit-trail", auditTrailRouter);
  let store;

  beforeEach(() => {
    process.env.ADMIN_ROTATE_TOKEN = TOKEN;
    store = newStore();
    setAuditTrailStore(store);
    appendSample(store, 2);
  });
  afterEach(() => {
    delete process.env.ADMIN_ROTATE_TOKEN;
    setAuditTrailStore(null);
    store.close();
  });

  test("requires admin credentials", async () => {
    const res = await request(app).get("/admin/audit-trail/status");
    expect(res.status).toBe(401);
  });

  test("GET /status reports head and retention", async () => {
    const res = await request(app).get("/admin/audit-trail/status").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entries: 2, head: { seq: 2 }, retentionDays: 2557 });
  });

  test("POST /verify returns 409 when tampering is detected", async () => {
    let res = await request(app).post("/admin/audit-trail/verify").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    store.db.exec("DROP TRIGGER audit_trail_no_update");
    store.db.prepare("UPDATE audit_trail SET event_type = 'forged' WHERE seq = 1").run();
    res = await request(app).post("/admin/audit-trail/verify").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
  });

  test("GET /export streams a report with a digest header", async () => {
    const res = await request(app)
      .get("/admin/audit-trail/export?standard=sox&format=csv")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/audit-trail-sox-.*\.csv/);
    expect(res.headers["x-report-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("GET /export validates its inputs", async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await request(app).get("/admin/audit-trail/export").set(auth)).status).toBe(400);
    expect(
      (await request(app).get("/admin/audit-trail/export?standard=SOX&from=yesterday").set(auth)).status,
    ).toBe(400);
    expect((await request(app).get("/admin/audit-trail/export?standard=GDPR").set(auth)).status).toBe(400);
  });
});
