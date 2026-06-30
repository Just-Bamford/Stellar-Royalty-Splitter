/**
 * Database migration versioning system (#519).
 *
 * A small, dependency-free migration engine for the SQLite (better-sqlite3)
 * database. It provides:
 *
 *   - A single ordered, uniquely-versioned registry of migrations, each with an
 *     `up(db)` and a `down(db)` script.
 *   - Idempotent, transactional application of pending migrations (`migrateUp`).
 *   - Safe rollback of applied migrations in reverse order (`migrateDown`).
 *   - Status reporting (`getStatus`) and current-version lookup
 *     (`getCurrentVersion`).
 *
 * Applied versions are tracked in the `schema_migrations` table. Every helper
 * operates on an injected `db` handle so the engine can be unit-tested against
 * an in-memory database, fully decoupled from the application singleton.
 *
 * Conventions for authoring a migration:
 *   - Pick the next unused integer `version` (the registry must stay strictly
 *     ascending with no duplicates — `assertRegistryValid` enforces this).
 *   - Write `up(db)` to apply the change and `down(db)` to reverse it. Prefer
 *     `IF NOT EXISTS` / `IF EXISTS` guards so re-runs are safe.
 *   - If a change genuinely cannot be reversed (e.g. a destructive table
 *     rebuild), set `irreversible: true`; `migrateDown` will refuse to roll past
 *     it with a clear error instead of corrupting data.
 *   - If a migration must manage its own transaction/PRAGMA state (SQLite does
 *     not allow nested transactions), set `selfTransaction: true` so the engine
 *     does not wrap it.
 */

import logger from "../logger.js";

/**
 * Ensure the migration bookkeeping table exists and has the expected shape.
 * `name` was added alongside the engine; older databases created the table with
 * only `(version, applied_at)`, so the column is added defensively.
 */
export function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Backfill the `name` column on databases predating the engine.
  try {
    db.exec(`ALTER TABLE schema_migrations ADD COLUMN name TEXT`);
  } catch (_) {
    /* column already exists */
  }
}

/** Return the sorted list of applied migration versions. */
export function getAppliedVersions(db) {
  ensureMigrationsTable(db);
  return db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all()
    .map((r) => r.version);
}

/** Return the highest applied migration version, or 0 if none. */
export function getCurrentVersion(db) {
  ensureMigrationsTable(db);
  const row = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
    .get();
  return row?.version ?? 0;
}

/**
 * Validate a migration registry: versions must be unique, strictly ascending,
 * and every entry must define `up`/`down` functions. Throws on the first
 * problem so a malformed registry fails fast at startup rather than corrupting
 * the schema halfway through.
 */
export function assertRegistryValid(registry) {
  let previous = -Infinity;
  const seen = new Set();
  for (const m of registry) {
    if (typeof m.version !== "number" || !Number.isInteger(m.version)) {
      throw new Error(`Migration has a non-integer version: ${JSON.stringify(m.version)}`);
    }
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version: ${m.version}`);
    }
    if (m.version <= previous) {
      throw new Error(
        `Migration versions must be strictly ascending; ${m.version} follows ${previous}`,
      );
    }
    if (typeof m.up !== "function" || typeof m.down !== "function") {
      throw new Error(`Migration v${m.version} must define up() and down() functions`);
    }
    seen.add(m.version);
    previous = m.version;
  }
  return true;
}

function recordApplied(db, version, name) {
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
    version,
    name ?? null,
  );
}

function recordReverted(db, version) {
  db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
}

/**
 * Apply all pending migrations in ascending order, up to and including
 * `targetVersion` when provided (otherwise the latest). Each migration runs
 * inside a transaction together with its bookkeeping insert, so a failure
 * leaves the database unchanged for that step. Returns the versions applied.
 */
export function migrateUp(db, { to } = {}, registry = MIGRATIONS) {
  assertRegistryValid(registry);
  ensureMigrationsTable(db);

  const applied = new Set(getAppliedVersions(db));
  const targetVersion = to ?? Infinity;
  const performed = [];

  for (const migration of registry) {
    if (migration.version > targetVersion) break;
    if (applied.has(migration.version)) continue;

    const run = () => {
      migration.up(db);
      recordApplied(db, migration.version, migration.name);
    };

    if (migration.selfTransaction) {
      // Migration manages its own transaction/PRAGMA state.
      run();
    } else {
      db.transaction(run)();
    }

    performed.push(migration.version);
    logger.info?.(`Applied migration v${migration.version} (${migration.name ?? "unnamed"})`);
  }

  return performed;
}

/**
 * Roll back applied migrations in descending order until the current version is
 * `to` (default: roll back exactly one migration). `steps` may be used instead
 * of `to` to roll back a fixed number of migrations. Each rollback runs inside
 * a transaction with its bookkeeping delete. Refuses to roll back a migration
 * flagged `irreversible`. Returns the versions rolled back.
 */
export function migrateDown(db, { to, steps } = {}, registry = MIGRATIONS) {
  assertRegistryValid(registry);
  ensureMigrationsTable(db);

  const byVersion = new Map(registry.map((m) => [m.version, m]));
  const applied = getAppliedVersions(db).sort((a, b) => b - a); // descending

  // Resolve the version the caller wants to end up at. With `steps` (default 1)
  // we keep everything below the `steps`-th highest applied version, i.e. revert
  // exactly `steps` migrations from the top.
  let targetVersion;
  if (typeof to === "number") {
    targetVersion = to;
  } else {
    const stepCount = typeof steps === "number" ? steps : 1;
    targetVersion = applied[stepCount] ?? 0;
  }

  const reverted = [];

  for (const version of applied) {
    if (version <= targetVersion) break;

    const migration = byVersion.get(version);
    if (!migration) {
      throw new Error(
        `Cannot roll back v${version}: no migration with that version exists in the registry`,
      );
    }
    if (migration.irreversible) {
      throw new Error(
        `Migration v${version} (${migration.name ?? "unnamed"}) is irreversible and cannot be rolled back`,
      );
    }

    db.transaction(() => {
      migration.down(db);
      recordReverted(db, version);
    })();

    reverted.push(version);
    logger.info?.(`Rolled back migration v${version} (${migration.name ?? "unnamed"})`);
  }

  return reverted;
}

/**
 * Return a status row per registered migration: `{ version, name, applied }`,
 * ordered by version ascending.
 */
export function getStatus(db, registry = MIGRATIONS) {
  ensureMigrationsTable(db);
  const applied = new Set(getAppliedVersions(db));
  return registry.map((m) => ({
    version: m.version,
    name: m.name ?? "unnamed",
    applied: applied.has(m.version),
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// Project migration registry
//
// Ported from the previously-embedded loop in core.js. Versions are now unique
// and strictly ascending (the prior list reused version 10 twice — for the
// RBAC/retry/DLQ tables and again for the transactions index — which threw a
// PRIMARY KEY violation on a fresh database). The transactions index is now
// version 9, filling the previously-missing slot.
// ──────────────────────────────────────────────────────────────────────────

export const MIGRATIONS = [
  {
    version: 1,
    name: "baseline",
    // The baseline schema is created idempotently by initializeDatabase() via
    // CREATE TABLE IF NOT EXISTS, so there is nothing to apply here. It cannot
    // be rolled back (that would drop every table).
    irreversible: true,
    up: () => {},
    down: () => {
      throw new Error("The baseline migration (v1) cannot be rolled back");
    },
  },
  {
    // #133: enforce FK constraints on existing databases by recreating
    // distribution_payouts and secondary_royalty_distributions with
    // ON DELETE CASCADE. SQLite cannot ADD CONSTRAINT, so this uses the
    // rename-create-copy-drop pattern and manages its own transaction/PRAGMA.
    version: 2,
    name: "enforce-fk-cascade",
    irreversible: true,
    selfTransaction: true,
    up: (db) =>
      db.exec(`
        PRAGMA foreign_keys = OFF;

        BEGIN;

        CREATE TABLE IF NOT EXISTS distribution_payouts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transactionId INTEGER NOT NULL,
          contractId TEXT NOT NULL DEFAULT '',
          collaboratorAddress TEXT NOT NULL,
          amountReceived TEXT NOT NULL,
          FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO distribution_payouts_new
          SELECT id, transactionId, contractId, collaboratorAddress, amountReceived
          FROM distribution_payouts;
        DROP TABLE distribution_payouts;
        ALTER TABLE distribution_payouts_new RENAME TO distribution_payouts;

        CREATE TABLE IF NOT EXISTS secondary_royalty_distributions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transactionId INTEGER NOT NULL,
          contractId TEXT NOT NULL,
          totalRoyaltiesDistributed TEXT NOT NULL,
          numberOfSales INTEGER NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO secondary_royalty_distributions_new
          SELECT id, transactionId, contractId, totalRoyaltiesDistributed, numberOfSales, timestamp
          FROM secondary_royalty_distributions;
        DROP TABLE secondary_royalty_distributions;
        ALTER TABLE secondary_royalty_distributions_new RENAME TO secondary_royalty_distributions;

        COMMIT;

        PRAGMA foreign_keys = ON;
      `),
    down: () => {
      throw new Error(
        "Migration v2 (enforce-fk-cascade) is irreversible; restore from backup to undo",
      );
    },
  },
  {
    version: 3,
    name: "webhooks-table",
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS webhooks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          url TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(contractId, url)
        );
        CREATE INDEX IF NOT EXISTS idx_webhooks_contractId ON webhooks(contractId);
      `),
    down: (db) =>
      db.exec(`
        DROP INDEX IF EXISTS idx_webhooks_contractId;
        DROP TABLE IF EXISTS webhooks;
      `),
  },
  {
    // Issue #395: hash-chain index on audit_log for integrity verification.
    version: 4,
    name: "audit-hash-index",
    up: (db) =>
      db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_entry_hash ON audit_log(entry_hash);`),
    down: (db) => db.exec(`DROP INDEX IF EXISTS idx_audit_entry_hash;`),
  },
  {
    // Issue #401: dead-letter queue for failed webhook deliveries.
    version: 5,
    name: "webhook-dead-letters",
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_dead_letters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          webhookId INTEGER,
          contractId TEXT NOT NULL,
          url TEXT NOT NULL,
          payload TEXT NOT NULL,
          errorMessage TEXT,
          retryCount INTEGER NOT NULL DEFAULT 0,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          lastAttemptAt DATETIME,
          FOREIGN KEY(webhookId) REFERENCES webhooks(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dead_letters_contractId ON webhook_dead_letters(contractId);
        CREATE INDEX IF NOT EXISTS idx_dead_letters_retryCount ON webhook_dead_letters(retryCount);
      `),
    down: (db) =>
      db.exec(`
        DROP INDEX IF EXISTS idx_dead_letters_retryCount;
        DROP INDEX IF EXISTS idx_dead_letters_contractId;
        DROP TABLE IF EXISTS webhook_dead_letters;
      `),
  },
  {
    // Issue #421: permanent per-contract nonce dedup for /api/v1/initialize.
    version: 6,
    name: "request-nonces",
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS request_nonces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          nonce TEXT NOT NULL,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(contractId, nonce)
        );
        CREATE INDEX IF NOT EXISTS idx_request_nonces_contractId ON request_nonces(contractId);
      `),
    down: (db) =>
      db.exec(`
        DROP INDEX IF EXISTS idx_request_nonces_contractId;
        DROP TABLE IF EXISTS request_nonces;
      `),
  },
  {
    // Issue #427: track dust allocated per secondary-royalty distribution round.
    // Issue #428: add max_attempts to webhooks; cleanup index on DLQ.
    version: 7,
    name: "dust-and-webhook-attempts",
    up: (db) =>
      db.exec(`
        ALTER TABLE secondary_royalty_distributions ADD COLUMN dustAllocated TEXT NOT NULL DEFAULT '0';
        ALTER TABLE webhooks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
        CREATE INDEX IF NOT EXISTS idx_dead_letters_createdAt ON webhook_dead_letters(createdAt);
      `),
    down: (db) =>
      db.exec(`
        DROP INDEX IF EXISTS idx_dead_letters_createdAt;
        ALTER TABLE webhooks DROP COLUMN max_attempts;
        ALTER TABLE secondary_royalty_distributions DROP COLUMN dustAllocated;
      `),
  },
  {
    // Issue #462: composite index for single-query royalty statistics.
    version: 8,
    name: "secondary-distributions-stats-index",
    up: (db) =>
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_secondary_distributions_contractId_timestamp
          ON secondary_royalty_distributions(contractId, timestamp);
      `),
    down: (db) =>
      db.exec(`DROP INDEX IF EXISTS idx_secondary_distributions_contractId_timestamp;`),
  },
  {
    // Issue #461: composite index on transactions for pagination queries.
    // Previously mis-numbered as a second "version 10"; assigned the missing
    // version 9 slot here so the registry stays unique and ascending.
    version: 9,
    name: "transactions-pagination-index",
    up: (db) =>
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_transactions_contractId_timestamp_desc
          ON transactions(contractId, timestamp DESC);
      `),
    down: (db) =>
      db.exec(`DROP INDEX IF EXISTS idx_transactions_contractId_timestamp_desc;`),
  },
  {
    // Issue #492: RBAC roles table + secondary-royalty retry and dead-letter queues.
    version: 10,
    name: "rbac-roles-and-retry-queues",
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_roles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT,
          walletAddress TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('viewer', 'operator', 'admin')),
          assignedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          assignedBy TEXT,
          UNIQUE(contractId, walletAddress)
        );
        CREATE INDEX IF NOT EXISTS idx_user_roles_walletAddress ON user_roles(walletAddress);

        CREATE TABLE IF NOT EXISTS secondary_royalty_retry_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          walletAddress TEXT NOT NULL,
          tokenId TEXT NOT NULL,
          collaborators TEXT,
          totalRoyalties TEXT NOT NULL,
          numberOfSales INTEGER NOT NULL,
          pendingSaleIds TEXT NOT NULL,
          totalDustAllocated TEXT NOT NULL DEFAULT '0',
          dustAuditData TEXT,
          errorMessage TEXT,
          retryCount INTEGER NOT NULL DEFAULT 0,
          nextRetryAt DATETIME NOT NULL,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          lastAttemptAt DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_retry_queue_nextRetryAt ON secondary_royalty_retry_queue(nextRetryAt);
        CREATE INDEX IF NOT EXISTS idx_retry_queue_contractId ON secondary_royalty_retry_queue(contractId);

        CREATE TABLE IF NOT EXISTS secondary_royalty_dlq (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          walletAddress TEXT NOT NULL,
          tokenId TEXT NOT NULL,
          collaborators TEXT,
          totalRoyalties TEXT NOT NULL,
          numberOfSales INTEGER NOT NULL,
          pendingSaleIds TEXT NOT NULL,
          totalDustAllocated TEXT NOT NULL DEFAULT '0',
          dustAuditData TEXT,
          errorMessage TEXT NOT NULL,
          failureReason TEXT NOT NULL,
          retryCount INTEGER NOT NULL DEFAULT 0,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          failedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dlq_contractId ON secondary_royalty_dlq(contractId);
        CREATE INDEX IF NOT EXISTS idx_dlq_createdAt ON secondary_royalty_dlq(createdAt);
      `),
    down: (db) =>
      db.exec(`
        DROP INDEX IF EXISTS idx_dlq_createdAt;
        DROP INDEX IF EXISTS idx_dlq_contractId;
        DROP TABLE IF EXISTS secondary_royalty_dlq;

        DROP INDEX IF EXISTS idx_retry_queue_contractId;
        DROP INDEX IF EXISTS idx_retry_queue_nextRetryAt;
        DROP TABLE IF EXISTS secondary_royalty_retry_queue;

        DROP INDEX IF EXISTS idx_user_roles_walletAddress;
        DROP TABLE IF EXISTS user_roles;
      `),
  },
];
