#!/usr/bin/env node
/**
 * backup-manager.js — encrypted SQLite backups, freshness monitoring, verified
 * restores, and recovery testing (#937).
 *
 *   node infra/backup-manager.js backup --type daily        # full backup, kept per docs/backup-strategy.md
 *   node infra/backup-manager.js backup --type pitr         # 15-minute snapshot — this is what bounds RPO
 *   node infra/backup-manager.js check-freshness            # alert when daily > 24h or pitr > 15m (+grace)
 *   node infra/backup-manager.js restore --latest --target-dir ./restored [--install --force]
 *   node infra/backup-manager.js recovery-test              # restore + integrity + RPO/RTO measurement
 *
 * Why this exists alongside scripts/automated-backup.sh: that script encrypts
 * with `openssl enc -aes-256-gcm`, which OpenSSL rejects ("AEAD ciphers not
 * supported"), and nothing ever restored what it produced. This tool:
 *
 *   - takes a consistent online snapshot with SQLite's backup API (safe while
 *     the API is writing, WAL included) instead of copying the live file;
 *   - encrypts with AES-256-GCM via Node's crypto, so every restore
 *     authenticates the ciphertext before a byte of it is trusted;
 *   - records, per database, row counts and a SHA-256 checksum of every table
 *     in a manifest, and re-derives them from the restored file;
 *   - uploads the manifest last, so a manifest's existence implies a complete
 *     backup, and freshness is measured from manifests alone.
 *
 * Configuration (environment):
 *   BACKUP_DATABASES        name=path pairs, comma separated
 *                           (default: audit=$DATABASE_PATH,audit-trail=$AUDIT_TRAIL_DB_PATH)
 *   BACKUP_ENCRYPTION_KEY   passphrase (required for backup/restore)
 *   BACKUP_S3_BUCKET        S3 bucket (uses the AWS CLI)
 *   BACKUP_S3_REGION        default us-east-1
 *   BACKUP_S3_ENDPOINT      optional, e.g. MinIO
 *   BACKUP_S3_KMS_KEY_ID    optional CMK for SSE-KMS (bucket default applies otherwise)
 *   BACKUP_LOCAL_DIR        use a local directory instead of S3 (tests, air-gapped DR)
 *   BACKUP_WORK_DIR         scratch space (default: <repo>/.backup-work)
 *   BACKUP_ALERT_WEBHOOK    POSTed to on any failure (Slack/Discord compatible "text")
 *   BACKUP_METRICS_NAMESPACE  publish CloudWatch metrics under this namespace
 *   BACKUP_ENVIRONMENT      metric dimension (default: unknown)
 *
 * Exit codes: 0 success, 1 check/backup/restore failed, 2 usage error.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// ── Targets ────────────────────────────────────────────────────────────────

export const RPO_TARGET_SECONDS = 15 * 60;
export const RTO_TARGET_SECONDS = 60 * 60;
export const DAILY_MAX_AGE_SECONDS = 24 * 60 * 60;
// A snapshot scheduled every 15 minutes can legitimately land a little late.
export const PITR_GRACE_SECONDS = 5 * 60;
export const BACKUP_TYPES = ["daily", "weekly", "monthly", "pitr"];

// ── Encryption ─────────────────────────────────────────────────────────────
//
// File layout: MAGIC(8) | salt(16) | iv(12) | gzip+AES-256-GCM ciphertext | tag(16)

const MAGIC = Buffer.from("SRSBAK01");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  if (!passphrase) throw new Error("BACKUP_ENCRYPTION_KEY is not set");
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
}

export async function encryptFile(src, dest, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  await fsp.writeFile(dest, Buffer.concat([MAGIC, salt, iv]));
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip(),
    cipher,
    fs.createWriteStream(dest, { flags: "a" }),
  );
  await fsp.appendFile(dest, cipher.getAuthTag());
}

export async function decryptFile(src, dest, passphrase) {
  const { size } = await fsp.stat(src);
  if (size < HEADER_LEN + TAG_LEN) throw new Error(`${src} is too small to be a backup`);

  const fh = await fsp.open(src, "r");
  let header;
  let tag;
  try {
    header = Buffer.alloc(HEADER_LEN);
    await fh.read(header, 0, HEADER_LEN, 0);
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`${src} is not a backup-manager archive`);
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = header.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);

  try {
    await pipeline(
      fs.createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      zlib.createGunzip(),
      fs.createWriteStream(dest),
    );
  } catch (err) {
    await fsp.rm(dest, { force: true });
    throw new Error(`Decryption failed for ${path.basename(src)} (wrong key or tampered archive): ${err.message}`);
  }
}

export async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

// ── SQLite ─────────────────────────────────────────────────────────────────

/**
 * better-sqlite3 is resolved from the backend's dependencies — the host that
 * runs backups runs the API, so it is already installed there.
 */
export function loadSqlite() {
  const candidates = [path.join(REPO_ROOT, "backend", "package.json"), import.meta.url];
  for (const base of candidates) {
    try {
      return createRequire(base)("better-sqlite3");
    } catch {
      // try the next location
    }
  }
  throw new Error("better-sqlite3 not found: run `npm ci` in backend/ first");
}

/** Consistent online snapshot using SQLite's backup API. */
export async function snapshotDatabase(Database, srcPath, destPath) {
  const db = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }
}

function rowDigestValue(value) {
  if (Buffer.isBuffer(value)) return { $b64: value.toString("base64") };
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * Row count and content checksum for every user table, plus SQLite's own
 * integrity check. Checksums are computed in rowid order so they are stable
 * across a backup/restore round trip.
 */
export function fingerprintDatabase(Database, file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    const tables = {};
    const names = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    for (const { name, sql } of names) {
      const quoted = `"${name.replace(/"/g, '""')}"`;
      const withoutRowid = /WITHOUT\s+ROWID/i.test(sql ?? "");
      const order = withoutRowid ? "ORDER BY 1" : "ORDER BY rowid";
      const hash = crypto.createHash("sha256");
      let rows = 0;
      for (const row of db.prepare(`SELECT * FROM ${quoted} ${order}`).iterate()) {
        const normalised = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, rowDigestValue(v)]));
        hash.update(JSON.stringify(normalised));
        hash.update("\n");
        rows += 1;
      }
      tables[name] = { rows, checksum: hash.digest("hex") };
    }
    return { integrity, tables };
  } finally {
    db.close();
  }
}

// ── Storage ────────────────────────────────────────────────────────────────

export class LocalStorage {
  constructor(root) {
    this.root = path.resolve(root);
    this.description = `file://${this.root}`;
  }
  #path(key) {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(this.root + path.sep)) throw new Error(`key escapes storage root: ${key}`);
    return resolved;
  }
  async put(localPath, key) {
    const dest = this.#path(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(localPath, dest);
  }
  async get(key, localPath) {
    await fsp.copyFile(this.#path(key), localPath);
  }
  async putText(key, text) {
    const dest = this.#path(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, text);
  }
  async getText(key) {
    return fsp.readFile(this.#path(key), "utf8");
  }
  async list(prefix) {
    const dir = this.#path(prefix.endsWith("/") ? prefix : `${prefix}/`);
    const out = [];
    const walk = async (d) => {
      let entries;
      try {
        entries = await fsp.readdir(d, { withFileTypes: true });
      } catch (err) {
        if (err.code === "ENOENT") return;
        throw err;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(path.relative(this.root, full).split(path.sep).join("/"));
      }
    };
    await walk(dir);
    return out.sort();
  }
}

export class S3Storage {
  constructor({ bucket, region = "us-east-1", endpoint = "", kmsKeyId = "" }) {
    if (!bucket) throw new Error("BACKUP_S3_BUCKET is not set");
    this.bucket = bucket;
    this.region = region;
    this.endpoint = endpoint;
    this.kmsKeyId = kmsKeyId;
    this.description = `s3://${bucket}`;
  }
  #common() {
    const args = ["--region", this.region];
    if (this.endpoint) args.push("--endpoint-url", this.endpoint);
    return args;
  }
  async #aws(args) {
    const { stdout } = await execFileAsync("aws", [...args, ...this.#common()], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }
  async put(localPath, key) {
    const sse = this.kmsKeyId ? ["--sse", "aws:kms", "--sse-kms-key-id", this.kmsKeyId] : [];
    await this.#aws(["s3", "cp", "--only-show-errors", localPath, `s3://${this.bucket}/${key}`, ...sse]);
  }
  async get(key, localPath) {
    await this.#aws(["s3", "cp", "--only-show-errors", `s3://${this.bucket}/${key}`, localPath]);
  }
  async putText(key, text) {
    const tmp = path.join(os.tmpdir(), `backup-manager-${crypto.randomUUID()}`);
    await fsp.writeFile(tmp, text);
    try {
      await this.put(tmp, key);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
  async getText(key) {
    const tmp = path.join(os.tmpdir(), `backup-manager-${crypto.randomUUID()}`);
    try {
      await this.get(key, tmp);
      return await fsp.readFile(tmp, "utf8");
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
  async list(prefix) {
    const out = await this.#aws([
      "s3api",
      "list-objects-v2",
      "--bucket",
      this.bucket,
      "--prefix",
      prefix,
      "--query",
      "Contents[].Key",
      "--output",
      "json",
    ]);
    const keys = JSON.parse(out.trim() || "null");
    return Array.isArray(keys) ? keys.sort() : [];
  }
}

export function createStorage(env = process.env) {
  if (env.BACKUP_LOCAL_DIR) return new LocalStorage(env.BACKUP_LOCAL_DIR);
  return new S3Storage({
    bucket: env.BACKUP_S3_BUCKET,
    region: env.BACKUP_S3_REGION || "us-east-1",
    endpoint: env.BACKUP_S3_ENDPOINT || "",
    kmsKeyId: env.BACKUP_S3_KMS_KEY_ID || "",
  });
}

// ── Configuration ──────────────────────────────────────────────────────────

export function parseDatabases(env = process.env) {
  if (env.BACKUP_DATABASES) {
    return env.BACKUP_DATABASES.split(",")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf("=");
        if (idx <= 0) throw new Error(`BACKUP_DATABASES entry must be name=path: ${pair}`);
        const name = pair.slice(0, idx).trim();
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid database name: ${name}`);
        return { name, path: path.resolve(pair.slice(idx + 1).trim()) };
      });
  }
  const dbs = [{ name: "audit", path: path.resolve(env.DATABASE_PATH || path.join(REPO_ROOT, "backend", "audit.db")) }];
  const trail = env.AUDIT_TRAIL_DB_PATH || path.join(REPO_ROOT, "backend", "audit-trail.db");
  if (env.AUDIT_TRAIL_DB_PATH || fs.existsSync(trail)) dbs.push({ name: "audit-trail", path: path.resolve(trail) });
  return dbs;
}

// ── Backup ─────────────────────────────────────────────────────────────────

function backupId(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Snapshot, fingerprint, encrypt and upload every configured database, then
 * write the manifest. Returns the manifest.
 */
export async function runBackup({ type = "daily", databases, storage, passphrase, workDir, now = new Date(), Database = loadSqlite() }) {
  if (!BACKUP_TYPES.includes(type)) throw new Error(`invalid backup type: ${type}`);
  if (!passphrase) throw new Error("BACKUP_ENCRYPTION_KEY is not set");
  const id = backupId(now);
  const scratch = await fsp.mkdtemp(path.join(workDir, `backup-${id}-`));
  const started = Date.now();
  try {
    const entries = [];
    for (const database of databases) {
      if (!fs.existsSync(database.path)) throw new Error(`database not found: ${database.path}`);
      const snapshot = path.join(scratch, `${database.name}.db`);
      const encrypted = `${snapshot}.gz.enc`;
      await snapshotDatabase(Database, database.path, snapshot);
      const fingerprint = fingerprintDatabase(Database, snapshot);
      if (fingerprint.integrity !== "ok") {
        throw new Error(`integrity_check failed on snapshot of ${database.name}: ${fingerprint.integrity}`);
      }
      const plaintextSha256 = await sha256File(snapshot);
      const sizeBytes = (await fsp.stat(snapshot)).size;
      await encryptFile(snapshot, encrypted, passphrase);
      const key = `${type}/${id}/${database.name}.db.gz.enc`;
      await storage.put(encrypted, key);
      entries.push({
        name: database.name,
        sourcePath: database.path,
        key,
        sizeBytes,
        encryptedSizeBytes: (await fsp.stat(encrypted)).size,
        sha256: plaintextSha256,
        tables: fingerprint.tables,
      });
    }

    const manifest = {
      version: 1,
      id,
      type,
      createdAt: now.toISOString(),
      durationMs: Date.now() - started,
      host: os.hostname(),
      encryption: { algorithm: "aes-256-gcm", kdf: "scrypt", compression: "gzip" },
      databases: entries,
    };
    // Written last: a manifest's presence means every archive above is complete.
    await storage.putText(`manifests/${type}/${id}.json`, JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

// ── Discovery & freshness ──────────────────────────────────────────────────

/** Manifest keys for a type, newest first. Keys embed the ISO timestamp. */
export async function listManifestKeys(storage, type) {
  const keys = await storage.list(`manifests/${type}/`);
  return keys.filter((k) => k.endsWith(".json")).sort().reverse();
}

export async function readManifest(storage, key) {
  return JSON.parse(await storage.getText(key));
}

export async function latestManifest(storage, types = BACKUP_TYPES) {
  let newest = null;
  for (const type of types) {
    const [key] = await listManifestKeys(storage, type);
    if (!key) continue;
    const manifest = await readManifest(storage, key);
    if (!newest || manifest.createdAt > newest.createdAt) newest = manifest;
  }
  return newest;
}

function idToDate(id) {
  // 2026-09-23T02-00-00-000Z → 2026-09-23T02:00:00.000Z
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
}

function keyToDate(key) {
  return idToDate(path.basename(key, ".json"));
}

/**
 * Freshness of the daily backup (must be < 24h) and of the 15-minute PITR
 * snapshots (must be < RPO + grace). Uses manifest timestamps only, so it is
 * cheap enough to run every few minutes.
 */
export async function checkFreshness({
  storage,
  now = new Date(),
  dailyMaxAgeSeconds = DAILY_MAX_AGE_SECONDS,
  pitrMaxAgeSeconds = RPO_TARGET_SECONDS + PITR_GRACE_SECONDS,
  requirePitr = true,
}) {
  const checks = [];
  const specs = [{ type: "daily", maxAgeSeconds: dailyMaxAgeSeconds }];
  if (requirePitr) specs.push({ type: "pitr", maxAgeSeconds: pitrMaxAgeSeconds });

  for (const { type, maxAgeSeconds } of specs) {
    const [key] = await listManifestKeys(storage, type);
    const latestAt = key ? keyToDate(key) : null;
    const ageSeconds = latestAt ? Math.max(0, (now - latestAt) / 1000) : null;
    checks.push({
      type,
      latestAt: latestAt ? latestAt.toISOString() : null,
      ageSeconds,
      maxAgeSeconds,
      ok: ageSeconds !== null && ageSeconds <= maxAgeSeconds,
    });
  }
  return { ok: checks.every((c) => c.ok), checkedAt: now.toISOString(), checks };
}

/**
 * Largest gap between consecutive PITR snapshots in the trailing window —
 * the worst-case data loss had the database been lost at the wrong moment.
 */
export async function measurePitrGaps({ storage, now = new Date(), windowSeconds = 24 * 3600 }) {
  const since = now.getTime() - windowSeconds * 1000;
  const times = (await listManifestKeys(storage, "pitr"))
    .map(keyToDate)
    .filter((d) => d && d.getTime() >= since)
    .map((d) => d.getTime())
    .sort((a, b) => a - b);
  if (times.length === 0) return { snapshots: 0, maxGapSeconds: null };
  let maxGap = (now.getTime() - times[times.length - 1]) / 1000;
  for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap, (times[i] - times[i - 1]) / 1000);
  return { snapshots: times.length, maxGapSeconds: maxGap };
}

// ── Restore ────────────────────────────────────────────────────────────────

/**
 * Download, decrypt and verify every database in a manifest into targetDir.
 * Verification: GCM authentication, plaintext SHA-256, PRAGMA integrity_check,
 * and per-table row counts + checksums against the manifest.
 */
export async function restoreBackup({ storage, manifest, passphrase, targetDir, workDir, Database = loadSqlite() }) {
  await fsp.mkdir(targetDir, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(workDir, `restore-${manifest.id}-`));
  const results = [];
  try {
    for (const entry of manifest.databases) {
      const encrypted = path.join(scratch, path.basename(entry.key));
      const restored = path.join(targetDir, `${entry.name}.db`);
      await storage.get(entry.key, encrypted);
      await decryptFile(encrypted, restored, passphrase);

      const problems = [];
      const sha256 = await sha256File(restored);
      if (sha256 !== entry.sha256) problems.push("sha256 mismatch");

      const fingerprint = fingerprintDatabase(Database, restored);
      if (fingerprint.integrity !== "ok") problems.push(`integrity_check: ${fingerprint.integrity}`);

      const expectedTables = Object.keys(entry.tables ?? {});
      for (const table of expectedTables) {
        const want = entry.tables[table];
        const got = fingerprint.tables[table];
        if (!got) problems.push(`table missing: ${table}`);
        else {
          if (got.rows !== want.rows) problems.push(`row count mismatch in ${table}: expected ${want.rows}, got ${got.rows}`);
          if (got.checksum !== want.checksum) problems.push(`checksum mismatch in ${table}`);
        }
      }
      for (const table of Object.keys(fingerprint.tables)) {
        if (!expectedTables.includes(table)) problems.push(`unexpected table: ${table}`);
      }

      const totalRows = Object.values(fingerprint.tables).reduce((n, t) => n + t.rows, 0);
      results.push({ name: entry.name, path: restored, sourcePath: entry.sourcePath, ok: problems.length === 0, problems, tables: Object.keys(fingerprint.tables).length, rows: totalRows });
    }
    return { ok: results.every((r) => r.ok), manifestId: manifest.id, databases: results };
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Put verified restored files in place of the live databases. The API must be
 * stopped first (infra/recovery-test.sh and the runbook do that). The previous
 * files are kept alongside as *.pre-restore-<timestamp>.
 */
export async function installRestore({ restore, force = false, now = new Date() }) {
  if (!restore.ok) throw new Error("refusing to install a restore that failed verification");
  const stamp = backupId(now);
  const installed = [];
  for (const db of restore.databases) {
    const live = db.sourcePath;
    if (fs.existsSync(live)) {
      if (!force) throw new Error(`${live} exists; pass --force to replace it`);
      await fsp.rename(live, `${live}.pre-restore-${stamp}`);
    }
    for (const suffix of ["-wal", "-shm"]) await fsp.rm(`${live}${suffix}`, { force: true });
    await fsp.mkdir(path.dirname(live), { recursive: true });
    const staging = `${live}.restoring`;
    await fsp.copyFile(db.path, staging);
    await fsp.rename(staging, live);
    installed.push(live);
  }
  return installed;
}

// ── Recovery test ──────────────────────────────────────────────────────────

/**
 * Restore the newest backup into an isolated directory, verify it, and check
 * the result against the RPO and RTO targets.
 *
 *   RTO: measured wall-clock time to locate, download, decrypt and verify.
 *   RPO: age of the newest backup now, and the largest gap between PITR
 *        snapshots over the last 24h — both must be within the target.
 */
export async function recoveryTest({
  storage,
  passphrase,
  targetDir,
  workDir,
  now = () => new Date(),
  rpoTargetSeconds = RPO_TARGET_SECONDS,
  rtoTargetSeconds = RTO_TARGET_SECONDS,
  Database,
}) {
  const startedAt = now();
  const started = Date.now();
  const manifest = await latestManifest(storage);
  if (!manifest) {
    return { ok: false, startedAt: startedAt.toISOString(), error: "no backups found" };
  }

  let restore;
  let error = null;
  try {
    restore = await restoreBackup({ storage, manifest, passphrase, targetDir, workDir, Database });
  } catch (err) {
    error = err.message;
  }
  const measuredSeconds = (Date.now() - started) / 1000;

  const newestAgeSeconds = Math.max(0, (startedAt - new Date(manifest.createdAt)) / 1000);
  const gaps = await measurePitrGaps({ storage, now: startedAt });
  const rpoOk =
    newestAgeSeconds <= rpoTargetSeconds + PITR_GRACE_SECONDS &&
    gaps.maxGapSeconds !== null &&
    gaps.maxGapSeconds <= rpoTargetSeconds + PITR_GRACE_SECONDS;

  const report = {
    ok: false,
    startedAt: startedAt.toISOString(),
    manifest: { id: manifest.id, type: manifest.type, createdAt: manifest.createdAt },
    restore: restore ?? null,
    error,
    rto: { targetSeconds: rtoTargetSeconds, measuredSeconds, ok: measuredSeconds <= rtoTargetSeconds },
    rpo: {
      targetSeconds: rpoTargetSeconds,
      newestBackupAgeSeconds: newestAgeSeconds,
      pitrSnapshotsLast24h: gaps.snapshots,
      maxPitrGapSecondsLast24h: gaps.maxGapSeconds,
      ok: rpoOk,
    },
  };
  report.ok = Boolean(restore?.ok) && report.rto.ok && report.rpo.ok && !error;
  return report;
}

// ── Reporting ──────────────────────────────────────────────────────────────

export async function sendAlert(subject, details, env = process.env) {
  const url = env.BACKUP_ALERT_WEBHOOK;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `**Stellar Royalty backup alert (${env.BACKUP_ENVIRONMENT || "unknown"})**\n\n**${subject}**\n\n\`\`\`${JSON.stringify(details, null, 2).slice(0, 3000)}\`\`\``,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Publish CloudWatch metrics consumed by the alarms in infra/terraform/backup.tf. */
export async function publishMetrics(metrics, env = process.env) {
  const namespace = env.BACKUP_METRICS_NAMESPACE;
  if (!namespace || metrics.length === 0) return false;
  const dimensions = [{ Name: "Environment", Value: env.BACKUP_ENVIRONMENT || "unknown" }];
  const data = metrics.map((m) => ({
    MetricName: m.name,
    Value: m.value,
    Unit: m.unit ?? "None",
    Dimensions: [...dimensions, ...(m.dimensions ?? [])],
  }));
  await execFileAsync("aws", [
    "cloudwatch",
    "put-metric-data",
    "--namespace",
    namespace,
    "--metric-data",
    JSON.stringify(data),
    "--region",
    env.BACKUP_S3_REGION || env.AWS_REGION || "us-east-1",
  ]);
  return true;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { command, flags };
}

const USAGE = `Usage: backup-manager.js <command> [options]

Commands:
  backup [--type daily|weekly|monthly|pitr]
  check-freshness [--no-pitr]
  restore (--latest | --manifest <key>) --target-dir <dir> [--install [--force]]
  recovery-test [--target-dir <dir>] [--report <file>]
`;

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    return 2;
  }
  const { command, flags } = parsed;
  const env = process.env;
  const workDir = path.resolve(env.BACKUP_WORK_DIR || path.join(REPO_ROOT, ".backup-work"));
  await fsp.mkdir(workDir, { recursive: true });
  const print = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

  switch (command) {
    case "backup": {
      const type = flags.type || "daily";
      try {
        const manifest = await runBackup({
          type,
          databases: parseDatabases(env),
          storage: createStorage(env),
          passphrase: env.BACKUP_ENCRYPTION_KEY,
          workDir,
        });
        await publishMetrics([{ name: "BackupSucceeded", value: 1, dimensions: [{ Name: "BackupType", Value: type }] }], env).catch(() => {});
        print(manifest);
        return 0;
      } catch (err) {
        await publishMetrics([{ name: "BackupSucceeded", value: 0, dimensions: [{ Name: "BackupType", Value: type }] }], env).catch(() => {});
        await sendAlert(`${type} backup failed`, { error: err.message }, env);
        process.stderr.write(`backup failed: ${err.message}\n`);
        return 1;
      }
    }

    case "check-freshness": {
      const result = await checkFreshness({ storage: createStorage(env), requirePitr: !flags["no-pitr"] });
      await publishMetrics(
        result.checks.map((c) => ({
          name: "BackupAgeSeconds",
          // A missing backup reports as infinitely old for alarm purposes.
          value: c.ageSeconds ?? 10 * 365 * 86400,
          unit: "Seconds",
          dimensions: [{ Name: "BackupType", Value: c.type }],
        })),
        env,
      ).catch(() => {});
      print(result);
      if (!result.ok) {
        await sendAlert("Backups are stale", result.checks.filter((c) => !c.ok), env);
        return 1;
      }
      return 0;
    }

    case "restore": {
      if (!flags["target-dir"] || (!flags.latest && !flags.manifest)) {
        process.stderr.write(USAGE);
        return 2;
      }
      const storage = createStorage(env);
      const manifest = flags.manifest ? await readManifest(storage, flags.manifest) : await latestManifest(storage);
      if (!manifest) {
        process.stderr.write("no backups found\n");
        return 1;
      }
      const restore = await restoreBackup({
        storage,
        manifest,
        passphrase: env.BACKUP_ENCRYPTION_KEY,
        targetDir: path.resolve(flags["target-dir"]),
        workDir,
      });
      if (restore.ok && flags.install) {
        restore.installed = await installRestore({ restore, force: Boolean(flags.force) });
      }
      print(restore);
      return restore.ok ? 0 : 1;
    }

    case "recovery-test": {
      const targetDir = path.resolve(flags["target-dir"] || path.join(workDir, "recovery-test"));
      await fsp.rm(targetDir, { recursive: true, force: true });
      const report = await recoveryTest({
        storage: createStorage(env),
        passphrase: env.BACKUP_ENCRYPTION_KEY,
        targetDir,
        workDir,
        Database: loadSqlite(),
      });
      if (flags.report) await fsp.writeFile(path.resolve(flags.report), JSON.stringify(report, null, 2));
      await publishMetrics(
        [
          { name: "RecoveryTestSucceeded", value: report.ok ? 1 : 0 },
          ...(report.rto ? [{ name: "RecoveryTimeSeconds", value: report.rto.measuredSeconds, unit: "Seconds" }] : []),
          ...(report.rpo?.maxPitrGapSecondsLast24h != null
            ? [{ name: "RecoveryPointGapSeconds", value: report.rpo.maxPitrGapSecondsLast24h, unit: "Seconds" }]
            : []),
        ],
        env,
      ).catch(() => {});
      print(report);
      if (!report.ok) {
        await sendAlert("Weekly recovery test FAILED", report, env);
        return 1;
      }
      return 0;
    }

    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err.stack ?? err}\n`);
      process.exit(1);
    },
  );
}
