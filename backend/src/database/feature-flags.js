/**
 * Feature Flags Database Schema and Operations (#1075)
 *
 * Persists runtime feature flags, targeting rules, rollout history, and the
 * error/latency metrics used to monitor a gradual rollout.
 *
 * Mirrors the style of database/rights-schema.js: every operation talks to
 * SQLite when a real connection is open and falls back to in-memory maps when
 * the database is mocked (unit tests), so the service layer stays identical in
 * both environments.
 */

import { db, countWrite } from "./core.js";

// ── In-memory fallback (used when the database is mocked/closed) ──────────────
const _flags = new Map(); // id -> flag
const _flagIdsByName = new Map(); // name -> id
const _rules = new Map(); // id -> rule
const _history = [];
const _metrics = [];
let _nextFlagId = 1;
let _nextRuleId = 1;
let _nextHistoryId = 1;
let _nextMetricId = 1;

function nowIso() {
  return new Date().toISOString();
}

function toBool(value) {
  return value === true || value === 1 || value === "1";
}

function mapFlagRow(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: toBool(row.enabled),
    killed: toBool(row.killed),
    archived: toBool(row.archived),
  };
}

/**
 * Create all feature-flag tables. Safe to call repeatedly.
 */
export function initializeFeatureFlagTables() {
  if (!db.open) return;

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        killed INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        rolloutPercentage INTEGER NOT NULL DEFAULT 100
          CHECK(rolloutPercentage >= 0 AND rolloutPercentage <= 100),
        createdBy TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_feature_flags_name ON feature_flags(name);
      CREATE INDEX IF NOT EXISTS idx_feature_flags_archived ON feature_flags(archived);

      CREATE TABLE IF NOT EXISTS feature_flag_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flagId INTEGER NOT NULL,
        ruleType TEXT NOT NULL CHECK(ruleType IN ('user', 'org', 'role')),
        value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(flagId, ruleType, value),
        FOREIGN KEY(flagId) REFERENCES feature_flags(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_feature_flag_rules_flagId ON feature_flag_rules(flagId);
      CREATE INDEX IF NOT EXISTS idx_feature_flag_rules_lookup ON feature_flag_rules(ruleType, value);

      CREATE TABLE IF NOT EXISTS feature_flag_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flagId INTEGER NOT NULL,
        flagName TEXT NOT NULL,
        action TEXT NOT NULL,
        changedBy TEXT,
        oldValue TEXT,
        newValue TEXT,
        reason TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_feature_flag_history_flagId
        ON feature_flag_history(flagId, timestamp DESC);

      CREATE TABLE IF NOT EXISTS feature_flag_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flagId INTEGER NOT NULL,
        flagName TEXT NOT NULL,
        metricType TEXT NOT NULL CHECK(metricType IN ('request', 'error', 'latency')),
        value REAL NOT NULL DEFAULT 0,
        recordedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_feature_flag_metrics_flag_time
        ON feature_flag_metrics(flagId, recordedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_feature_flag_metrics_type
        ON feature_flag_metrics(metricType, recordedAt DESC);
    `);
  } catch (_e) {
    // Ignore in mocked environments.
  }
}

// Ensure tables exist when the module is loaded.
initializeFeatureFlagTables();

/**
 * Clear every flag/rule/history/metric record. Intended for tests.
 */
export function clearFeatureFlagTables() {
  _flags.clear();
  _flagIdsByName.clear();
  _rules.clear();
  _history.length = 0;
  _metrics.length = 0;
  _nextFlagId = 1;
  _nextRuleId = 1;
  _nextHistoryId = 1;
  _nextMetricId = 1;

  if (db.open) {
    try {
      db.prepare("DELETE FROM feature_flag_metrics").run();
      db.prepare("DELETE FROM feature_flag_history").run();
      db.prepare("DELETE FROM feature_flag_rules").run();
      db.prepare("DELETE FROM feature_flags").run();
    } catch (_e) {
      // Ignore in mocked environments.
    }
  }
}

/**
 * Create a feature flag. Returns the stored flag or null when the name exists.
 */
export function createFlagRecord({
  name,
  description = null,
  enabled = false,
  rolloutPercentage = 100,
  createdBy = null,
}) {
  const now = nowIso();
  const existing = getFlagRecord(name);
  if (existing) return null;

  let insertId;
  if (db.open) {
    try {
      const result = db
        .prepare(
          `INSERT INTO feature_flags
             (name, description, enabled, killed, archived, rolloutPercentage, createdBy, createdAt, updatedAt)
           VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`
        )
        .run(name, description, enabled ? 1 : 0, rolloutPercentage, createdBy, now, now);
      countWrite();
      insertId = Number(result?.lastInsertRowid);
    } catch (_e) {
      // Mocked DB fallback.
    }
  }

  if (!insertId) {
    insertId = _nextFlagId++;
  }

  const flag = {
    id: insertId,
    name,
    description,
    enabled: Boolean(enabled),
    killed: false,
    archived: false,
    rolloutPercentage,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };

  _flags.set(insertId, flag);
  _flagIdsByName.set(name, insertId);
  return flag;
}

/**
 * Get a flag record by name (including archived flags).
 */
export function getFlagRecord(name) {
  if (db.open) {
    try {
      const row = db.prepare("SELECT * FROM feature_flags WHERE name = ?").get(name);
      return mapFlagRow(row);
    } catch (_e) {
      return null;
    }
  }

  const id = _flagIdsByName.get(name);
  return id ? _flags.get(id) || null : null;
}

/**
 * List flag records, newest first. Archived flags are excluded by default.
 */
export function listFlagRecords({ includeArchived = false } = {}) {
  if (db.open) {
    try {
      const sql = includeArchived
        ? "SELECT * FROM feature_flags ORDER BY id DESC"
        : "SELECT * FROM feature_flags WHERE archived = 0 ORDER BY id DESC";
      return db.prepare(sql).all().map(mapFlagRow);
    } catch (_e) {
      return [];
    }
  }

  const records = [..._flags.values()].filter((f) => includeArchived || !f.archived);
  return records.sort((a, b) => b.id - a.id);
}

/**
 * Apply updates to a flag. Returns the updated flag or null when missing.
 */
export function updateFlagRecord(id, updates) {
  const existing = getFlagById(id);
  if (!existing) return null;

  const now = nowIso();
  const next = {
    ...existing,
    ...updates,
    updatedAt: now,
  };

  if (db.open) {
    try {
      db.prepare(
        `UPDATE feature_flags
           SET description = ?, enabled = ?, killed = ?, archived = ?, rolloutPercentage = ?, updatedAt = ?
         WHERE id = ?`
      ).run(
        next.description ?? null,
        next.enabled ? 1 : 0,
        next.killed ? 1 : 0,
        next.archived ? 1 : 0,
        next.rolloutPercentage,
        now,
        id
      );
      countWrite();
    } catch (_e) {
      // Mocked DB fallback.
    }
  }

  _flags.set(id, next);
  _flagIdsByName.set(next.name, id);
  return next;
}

/**
 * Get a flag record by id.
 */
export function getFlagById(id) {
  if (db.open) {
    try {
      const row = db.prepare("SELECT * FROM feature_flags WHERE id = ?").get(id);
      return mapFlagRow(row);
    } catch (_e) {
      return null;
    }
  }
  return _flags.get(id) || null;
}

// ── Rules ─────────────────────────────────────────────────────────────────────

export function addFlagRuleRecord({ flagId, ruleType, value, enabled = true }) {
  const existing = getFlagRuleByValue(flagId, ruleType, value);
  if (existing) return existing;

  const now = nowIso();
  let insertId;

  if (db.open) {
    try {
      const result = db
        .prepare(
          `INSERT INTO feature_flag_rules (flagId, ruleType, value, enabled, createdAt)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(flagId, ruleType, value, enabled ? 1 : 0, now);
      countWrite();
      insertId = Number(result?.lastInsertRowid);
    } catch (_e) {
      // Mocked DB fallback.
    }
  }

  if (!insertId) {
    insertId = _nextRuleId++;
  }

  const rule = {
    id: insertId,
    flagId,
    ruleType,
    value,
    enabled: Boolean(enabled),
    createdAt: now,
  };

  _rules.set(insertId, rule);
  return rule;
}

function mapRuleRow(row) {
  if (!row) return null;
  return { ...row, enabled: toBool(row.enabled) };
}

export function getFlagRuleRecord(id) {
  if (db.open) {
    try {
      return mapRuleRow(db.prepare("SELECT * FROM feature_flag_rules WHERE id = ?").get(id));
    } catch (_e) {
      return null;
    }
  }
  return _rules.get(id) || null;
}

export function listFlagRules(flagId) {
  if (db.open) {
    try {
      return db
        .prepare("SELECT * FROM feature_flag_rules WHERE flagId = ? ORDER BY id ASC")
        .all(flagId)
        .map(mapRuleRow);
    } catch (_e) {
      return [];
    }
  }

  return [..._rules.values()]
    .filter((r) => r.flagId === flagId)
    .sort((a, b) => a.id - b.id);
}

export function getFlagRuleByValue(flagId, ruleType, value) {
  if (db.open) {
    try {
      return mapRuleRow(
        db
          .prepare(
            "SELECT * FROM feature_flag_rules WHERE flagId = ? AND ruleType = ? AND value = ?"
          )
          .get(flagId, ruleType, value)
      );
    } catch (_e) {
      return null;
    }
  }

  return (
    [..._rules.values()].find(
      (r) => r.flagId === flagId && r.ruleType === ruleType && r.value === value
    ) || null
  );
}

export function deleteFlagRuleRecord(id) {
  const existing = getFlagRuleRecord(id);
  if (!existing) return false;

  if (db.open) {
    try {
      db.prepare("DELETE FROM feature_flag_rules WHERE id = ?").run(id);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback.
    }
  }

  _rules.delete(id);
  return true;
}

// ── History ───────────────────────────────────────────────────────────────────

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function addFlagHistoryRecord({
  flagId,
  flagName,
  action,
  changedBy = "system",
  oldValue = null,
  newValue = null,
  reason = null,
}) {
  const now = nowIso();
  const oldStr = oldValue == null ? null : JSON.stringify(oldValue);
  const newStr = newValue == null ? null : JSON.stringify(newValue);

  if (db.open) {
    try {
      db.prepare(
        `INSERT INTO feature_flag_history
           (flagId, flagName, action, changedBy, oldValue, newValue, reason, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(flagId, flagName, action, changedBy, oldStr, newStr, reason, now);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback.
    }
  }

  _history.push({
    id: _nextHistoryId++,
    flagId,
    flagName,
    action,
    changedBy,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    reason,
    timestamp: now,
  });
}

export function getFlagHistoryRecords(flagId) {
  if (db.open) {
    try {
      return db
        .prepare(
          "SELECT * FROM feature_flag_history WHERE flagId = ? ORDER BY timestamp DESC, id DESC"
        )
        .all(flagId)
        .map((row) => ({
          ...row,
          oldValue: parseMaybeJson(row.oldValue),
          newValue: parseMaybeJson(row.newValue),
        }));
    } catch (_e) {
      return [];
    }
  }

  return _history
    .filter((h) => h.flagId === flagId)
    .slice()
    .sort((a, b) => b.id - a.id);
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export function addFlagMetricRecord({ flagId, flagName, metricType, value = 0 }) {
  const now = nowIso();

  if (db.open) {
    try {
      db.prepare(
        `INSERT INTO feature_flag_metrics (flagId, flagName, metricType, value, recordedAt)
         VALUES (?, ?, ?, ?, ?)`
      ).run(flagId, flagName, metricType, value, now);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback.
    }
  }

  const record = {
    id: _nextMetricId++,
    flagId,
    flagName,
    metricType,
    value,
    recordedAt: now,
  };
  _metrics.push(record);
  return record;
}

export function getFlagMetricRecords(flagId, since = null) {
  if (db.open) {
    try {
      const rows = since
        ? db
            .prepare(
              "SELECT * FROM feature_flag_metrics WHERE flagId = ? AND recordedAt >= ? ORDER BY recordedAt DESC"
            )
            .all(flagId, since)
        : db
            .prepare("SELECT * FROM feature_flag_metrics WHERE flagId = ? ORDER BY recordedAt DESC")
            .all(flagId);
      return rows;
    } catch (_e) {
      return [];
    }
  }

  return _metrics
    .filter((m) => m.flagId === flagId && (!since || m.recordedAt >= since))
    .slice()
    .sort((a, b) => b.id - a.id);
}
