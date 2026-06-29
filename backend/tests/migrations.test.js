/**
 * Tests for the database migration versioning system (#519).
 *
 * The migration engine is exercised against an in-memory SQLite database with a
 * small synthetic registry so up/down/rollback/status behaviour is verified in
 * isolation from the application schema. A final block asserts invariants on the
 * real project registry (unique, strictly-ascending versions with up/down
 * scripts) — this is the guard that prevents the duplicate-version regression
 * that previously broke fresh database initialization.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const Database = (await import("better-sqlite3")).default;
const {
  MIGRATIONS,
  migrateUp,
  migrateDown,
  getStatus,
  getCurrentVersion,
  getAppliedVersions,
  assertRegistryValid,
} = await import("../src/database/migrations.js");

const tableExists = (db, name) =>
  !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);

const indexExists = (db, name) =>
  !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name);

/** A self-contained registry that does not depend on any baseline schema. */
function makeRegistry() {
  return [
    {
      version: 1,
      name: "create-foo",
      up: (db) => db.exec("CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT);"),
      down: (db) => db.exec("DROP TABLE IF EXISTS foo;"),
    },
    {
      version: 2,
      name: "index-foo-val",
      up: (db) => db.exec("CREATE INDEX idx_foo_val ON foo(val);"),
      down: (db) => db.exec("DROP INDEX IF EXISTS idx_foo_val;"),
    },
    {
      version: 3,
      name: "create-bar",
      up: (db) => db.exec("CREATE TABLE bar (id INTEGER PRIMARY KEY);"),
      down: (db) => db.exec("DROP TABLE IF EXISTS bar;"),
    },
  ];
}

describe("migration engine — up", () => {
  let db;
  let registry;
  beforeEach(() => {
    db = new Database(":memory:");
    registry = makeRegistry();
  });

  test("applies all pending migrations in order and records versions", () => {
    const applied = migrateUp(db, {}, registry);
    expect(applied).toEqual([1, 2, 3]);
    expect(getCurrentVersion(db)).toBe(3);
    expect(getAppliedVersions(db)).toEqual([1, 2, 3]);
    expect(tableExists(db, "foo")).toBe(true);
    expect(indexExists(db, "idx_foo_val")).toBe(true);
    expect(tableExists(db, "bar")).toBe(true);
  });

  test("is idempotent — a second run applies nothing", () => {
    migrateUp(db, {}, registry);
    const second = migrateUp(db, {}, registry);
    expect(second).toEqual([]);
    expect(getCurrentVersion(db)).toBe(3);
  });

  test("respects a target version with --to", () => {
    const applied = migrateUp(db, { to: 2 }, registry);
    expect(applied).toEqual([1, 2]);
    expect(getCurrentVersion(db)).toBe(2);
    expect(tableExists(db, "bar")).toBe(false);
  });
});

describe("migration engine — down (rollback)", () => {
  let db;
  let registry;
  beforeEach(() => {
    db = new Database(":memory:");
    registry = makeRegistry();
    migrateUp(db, {}, registry);
  });

  test("rolls back the most recent migration by default", () => {
    const reverted = migrateDown(db, {}, registry);
    expect(reverted).toEqual([3]);
    expect(getCurrentVersion(db)).toBe(2);
    expect(tableExists(db, "bar")).toBe(false);
    expect(tableExists(db, "foo")).toBe(true);
  });

  test("rolls back N migrations with --step", () => {
    const reverted = migrateDown(db, { steps: 2 }, registry);
    expect(reverted).toEqual([3, 2]);
    expect(getCurrentVersion(db)).toBe(1);
    expect(indexExists(db, "idx_foo_val")).toBe(false);
    expect(tableExists(db, "foo")).toBe(true);
  });

  test("rolls back to a target version with --to", () => {
    const reverted = migrateDown(db, { to: 0 }, registry);
    expect(reverted).toEqual([3, 2, 1]);
    expect(getCurrentVersion(db)).toBe(0);
    expect(tableExists(db, "foo")).toBe(false);
    expect(tableExists(db, "bar")).toBe(false);
  });

  test("a down/up round-trip restores the schema", () => {
    migrateDown(db, { to: 0 }, registry);
    const reapplied = migrateUp(db, {}, registry);
    expect(reapplied).toEqual([1, 2, 3]);
    expect(tableExists(db, "foo")).toBe(true);
    expect(tableExists(db, "bar")).toBe(true);
  });

  test("refuses to roll back an irreversible migration", () => {
    const irreversibleRegistry = [
      {
        version: 1,
        name: "irreversible",
        irreversible: true,
        up: (d) => d.exec("CREATE TABLE keep (id INTEGER);"),
        down: () => {
          throw new Error("should not be called");
        },
      },
    ];
    const d = new Database(":memory:");
    migrateUp(d, {}, irreversibleRegistry);
    expect(() => migrateDown(d, {}, irreversibleRegistry)).toThrow(/irreversible/i);
    // The migration remains applied because rollback was refused.
    expect(getCurrentVersion(d)).toBe(1);
  });
});

describe("migration engine — status & validation", () => {
  test("status reports applied/pending per migration", () => {
    const db = new Database(":memory:");
    const registry = makeRegistry();
    migrateUp(db, { to: 1 }, registry);
    const status = getStatus(db, registry);
    expect(status).toEqual([
      { version: 1, name: "create-foo", applied: true },
      { version: 2, name: "index-foo-val", applied: false },
      { version: 3, name: "create-bar", applied: false },
    ]);
  });

  test("rejects a registry with duplicate versions", () => {
    const bad = [
      { version: 1, name: "a", up: () => {}, down: () => {} },
      { version: 1, name: "b", up: () => {}, down: () => {} },
    ];
    expect(() => assertRegistryValid(bad)).toThrow(/Duplicate migration version/);
  });

  test("rejects a non-ascending registry", () => {
    const bad = [
      { version: 2, name: "a", up: () => {}, down: () => {} },
      { version: 1, name: "b", up: () => {}, down: () => {} },
    ];
    expect(() => assertRegistryValid(bad)).toThrow(/ascending/);
  });
});

describe("project migration registry", () => {
  test("has unique, strictly-ascending versions with up/down scripts", () => {
    // Guards the regression where two migrations both used version 10 and broke
    // fresh database initialization with a PRIMARY KEY violation.
    expect(() => assertRegistryValid(MIGRATIONS)).not.toThrow();

    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);

    for (const m of MIGRATIONS) {
      expect(typeof m.up).toBe("function");
      expect(typeof m.down).toBe("function");
      expect(typeof m.name).toBe("string");
    }
  });
});
