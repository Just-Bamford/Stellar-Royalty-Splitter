/**
 * Backup manager (#937): encryption, backup → restore round trip, integrity
 * verification, freshness monitoring, and RPO/RTO measurement.
 *
 * Runs against real SQLite files (better-sqlite3 from backend/node_modules)
 * and a local-directory storage backend standing in for S3.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

import {
  LocalStorage,
  checkFreshness,
  decryptFile,
  encryptFile,
  fingerprintDatabase,
  installRestore,
  latestManifest,
  loadSqlite,
  measurePitrGaps,
  readManifest,
  listManifestKeys,
  recoveryTest,
  restoreBackup,
  runBackup,
} from "../backup-manager.js";

const Database = loadSqlite();
const KEY = "correct horse battery staple";

let tmp;
let storage;
let workDir;
let databases;

function seedDatabase(file, rows = 50) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE transactions (id INTEGER PRIMARY KEY, contractId TEXT, amount TEXT, payload BLOB);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT, details TEXT);
  `);
  const insertTx = db.prepare("INSERT INTO transactions (contractId, amount, payload) VALUES (?, ?, ?)");
  const insertAudit = db.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)");
  for (let i = 0; i < rows; i++) {
    insertTx.run(`C${i % 3}`, String(i * 1000), Buffer.from([i, 255 - i]));
    insertAudit.run("distribution_initiated", JSON.stringify({ i }));
  }
  // Deliberately leave the connection open with data in the WAL: the backup
  // must capture it via the online backup API, not by copying the main file.
  return db;
}

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "backup-manager-test-"));
  storage = new LocalStorage(path.join(tmp, "bucket"));
  workDir = path.join(tmp, "work");
  await fsp.mkdir(workDir);
  const live = path.join(tmp, "live");
  await fsp.mkdir(live);
  databases = [
    { name: "audit", path: path.join(live, "audit.db") },
    { name: "audit-trail", path: path.join(live, "audit-trail.db") },
  ];
  seedDatabase(databases[0].path, 50);
  seedDatabase(databases[1].path, 5);
});

after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("encryption", () => {
  test("round-trips and rejects a wrong key or a tampered archive", async () => {
    const src = path.join(tmp, "plain.bin");
    const enc = path.join(tmp, "plain.bin.enc");
    const out = path.join(tmp, "plain.out");
    await fsp.writeFile(src, Buffer.from("royalty ".repeat(1000)));

    await encryptFile(src, enc, KEY);
    assert.notDeepEqual(await fsp.readFile(enc), await fsp.readFile(src));
    await decryptFile(enc, out, KEY);
    assert.deepEqual(await fsp.readFile(out), await fsp.readFile(src));

    await assert.rejects(decryptFile(enc, out, "wrong key"), /Decryption failed/);
    assert.equal(fs.existsSync(out), false, "partial plaintext must be removed");

    const bytes = await fsp.readFile(enc);
    bytes[bytes.length - 40] ^= 0xff;
    await fsp.writeFile(enc, bytes);
    await assert.rejects(decryptFile(enc, out, KEY), /Decryption failed/);
  });
});

describe("backup and restore", () => {
  let manifest;

  test("backs up every database with row counts and checksums", async () => {
    manifest = await runBackup({ type: "daily", databases, storage, passphrase: KEY, workDir, Database });
    assert.equal(manifest.databases.length, 2);
    const audit = manifest.databases.find((d) => d.name === "audit");
    assert.equal(audit.tables.transactions.rows, 50);
    assert.equal(audit.tables.audit_log.rows, 50);
    assert.match(audit.sha256, /^[0-9a-f]{64}$/);

    const stored = await storage.list(`daily/${manifest.id}/`);
    assert.equal(stored.length, 2);
    for (const key of stored) {
      const head = (await fsp.readFile(path.join(storage.root, key))).subarray(0, 8).toString();
      assert.equal(head, "SRSBAK01", "archives are encrypted, not raw SQLite");
    }
    assert.deepEqual(await listManifestKeys(storage, "daily"), [`manifests/daily/${manifest.id}.json`]);
  });

  test("restores and verifies data integrity", async () => {
    const targetDir = path.join(tmp, "restored");
    const result = await restoreBackup({ storage, manifest, passphrase: KEY, targetDir, workDir, Database });
    assert.equal(result.ok, true, JSON.stringify(result));
    const audit = result.databases.find((d) => d.name === "audit");
    assert.equal(audit.rows, 100);
    const original = fingerprintDatabase(Database, databases[0].path);
    const restored = fingerprintDatabase(Database, audit.path);
    assert.deepEqual(restored.tables, original.tables);
  });

  test("detects a restore that does not match the manifest", async () => {
    const key = `manifests/daily/${manifest.id}.json`;
    const tampered = await readManifest(storage, key);
    tampered.databases[0].tables.transactions.rows = 49;
    tampered.databases[0].tables.audit_log.checksum = "0".repeat(64);
    const result = await restoreBackup({
      storage,
      manifest: tampered,
      passphrase: KEY,
      targetDir: path.join(tmp, "restored-bad"),
      workDir,
      Database,
    });
    assert.equal(result.ok, false);
    const problems = result.databases[0].problems.join("; ");
    assert.match(problems, /row count mismatch in transactions/);
    assert.match(problems, /checksum mismatch in audit_log/);
  });

  test("install refuses to overwrite live data without --force and keeps the old file", async () => {
    const liveDir = path.join(tmp, "install-live");
    await fsp.mkdir(liveDir);
    const livePath = path.join(liveDir, "audit.db");
    await fsp.writeFile(livePath, "stale");
    const restoredPath = path.join(tmp, "restored", "audit.db");
    const restore = { ok: true, databases: [{ name: "audit", path: restoredPath, sourcePath: livePath }] };

    await assert.rejects(installRestore({ restore }), /--force/);
    const installed = await installRestore({ restore, force: true });
    assert.deepEqual(installed, [livePath]);
    assert.deepEqual(await fsp.readFile(livePath), await fsp.readFile(restoredPath));
    const leftovers = await fsp.readdir(liveDir);
    assert.ok(leftovers.some((f) => f.startsWith("audit.db.pre-restore-")));
    await assert.rejects(installRestore({ restore: { ok: false, databases: [] } }), /failed verification/);
  });
});

describe("freshness and RPO", () => {
  test("flags a daily backup older than 24 hours and a missing PITR snapshot", async () => {
    const store = new LocalStorage(path.join(tmp, "fresh-bucket"));
    const t0 = new Date("2026-09-20T02:00:00.000Z");
    await runBackup({ type: "daily", databases, storage: store, passphrase: KEY, workDir, now: t0, Database });

    const fresh = await checkFreshness({ storage: store, now: new Date(t0.getTime() + 3600e3), requirePitr: false });
    assert.equal(fresh.ok, true);

    const stale = await checkFreshness({ storage: store, now: new Date(t0.getTime() + 25 * 3600e3) });
    assert.equal(stale.ok, false);
    const daily = stale.checks.find((c) => c.type === "daily");
    assert.equal(daily.ok, false);
    assert.equal(Math.round(daily.ageSeconds), 25 * 3600);
    assert.equal(stale.checks.find((c) => c.type === "pitr").latestAt, null);
  });

  test("measures the largest gap between PITR snapshots", async () => {
    const store = new LocalStorage(path.join(tmp, "gap-bucket"));
    const base = Date.parse("2026-09-21T00:00:00.000Z");
    for (const minutes of [0, 15, 30, 75, 90]) {
      await runBackup({ type: "pitr", databases: [databases[1]], storage: store, passphrase: KEY, workDir, now: new Date(base + minutes * 60e3), Database });
    }
    const gaps = await measurePitrGaps({ storage: store, now: new Date(base + 95 * 60e3) });
    assert.equal(gaps.snapshots, 5);
    assert.equal(gaps.maxGapSeconds, 45 * 60);
  });
});

describe("recovery test", () => {
  test("passes when backups are recent and restorable, and reports RTO/RPO", async () => {
    const store = new LocalStorage(path.join(tmp, "rt-bucket"));
    const now = Date.now();
    for (const minutesAgo of [40, 25, 10]) {
      await runBackup({ type: "pitr", databases, storage: store, passphrase: KEY, workDir, now: new Date(now - minutesAgo * 60e3), Database });
    }
    const report = await recoveryTest({ storage: store, passphrase: KEY, targetDir: path.join(tmp, "rt"), workDir, Database });
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.rpo.ok, true);
    assert.equal(report.rpo.maxPitrGapSecondsLast24h, 15 * 60);
    assert.equal(report.rto.ok, true);
    assert.ok(report.rto.measuredSeconds < 3600);
    assert.equal((await latestManifest(store)).id, report.manifest.id);
  });

  test("fails the RPO check when the newest snapshot is too old", async () => {
    const store = new LocalStorage(path.join(tmp, "rt-old-bucket"));
    await runBackup({ type: "pitr", databases, storage: store, passphrase: KEY, workDir, now: new Date(Date.now() - 3 * 3600e3), Database });
    const report = await recoveryTest({ storage: store, passphrase: KEY, targetDir: path.join(tmp, "rt-old"), workDir, Database });
    assert.equal(report.ok, false);
    assert.equal(report.restore.ok, true, "the data itself restores fine");
    assert.equal(report.rpo.ok, false);
  });

  test("fails when the backup cannot be decrypted", async () => {
    const store = new LocalStorage(path.join(tmp, "rt-key-bucket"));
    await runBackup({ type: "pitr", databases, storage: store, passphrase: KEY, workDir, Database });
    const report = await recoveryTest({ storage: store, passphrase: "rotated-without-updating-restore", targetDir: path.join(tmp, "rt-key"), workDir, Database });
    assert.equal(report.ok, false);
    assert.match(report.error, /Decryption failed/);
  });

  test("reports an empty bucket as a failure", async () => {
    const report = await recoveryTest({ storage: new LocalStorage(path.join(tmp, "empty")), passphrase: KEY, targetDir: path.join(tmp, "rt-empty"), workDir, Database });
    assert.equal(report.ok, false);
    assert.equal(report.error, "no backups found");
  });
});
