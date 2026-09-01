# Backend Database Migrations

The backend keeps its SQLite schema evolution in `src/database/core.js`
(see also `src/database.js`, which mirrors the same pattern for an older
code path). This document covers that system — it's separate from the
Soroban contract's own `migrate()` mechanism described in the top-level
[`MIGRATIONS.md`](../MIGRATIONS.md).

## How it works

- `initializeDatabase()` creates a `schema_migrations` table:

  ```sql
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  ```

- Migrations are defined in-code as an ordered array of `{ version, sql }`
  entries inside `initializeDatabase()`.
- On every server startup, `initializeDatabase()` reads which `version`
  numbers are already recorded in `schema_migrations`, then runs the `sql`
  for any migration whose `version` isn't in that set yet, and records it
  immediately after.
- The current schema version is exposed via `getMigrationVersion()`, which
  returns `MAX(version)` from `schema_migrations` (or `0` on a brand-new
  database with no migrations applied yet).
- `GET /api/v1/health` includes this value as `dbVersion` in its response,
  and `GET /api/v1/liveness` uses `getMigrationVersion()` as a cheap
  "is the database file actually readable" probe.

Because each migration is idempotent SQL guarded by its own `version` entry
in `schema_migrations`, restarting the server (including in a fresh
environment with an empty database) always converges the schema to the
latest version regardless of which prior versions, if any, were already
applied.

## Adding a new migration

1. Open `src/database/core.js` and find the `migrations` array inside
   `initializeDatabase()`.
2. Add a new entry with the next unused `version` number and the SQL to run:

   ```js
   migrations.push({
     version: 17, // next unused version number
     sql: `
       ALTER TABLE contributor_tax ADD COLUMN notes TEXT;
     `,
   });
   ```

3. Prefer additive, backward-compatible changes (`ADD COLUMN`,
   `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). SQLite
   doesn't support most `ALTER TABLE` forms (e.g. dropping/renaming
   columns, adding constraints to an existing table) — for those, use the
   rename-create-copy-drop pattern already used by the `version: 2`
   migration in the same file (recreate the table under a `_new` name,
   copy data across, drop the old table, rename).
4. Wrap multi-statement or destructive migrations in `BEGIN; ... COMMIT;`
   so a failure partway through doesn't leave the schema half-migrated.
5. Keep the SQL itself idempotent where practical (`IF NOT EXISTS` /
   `INSERT OR IGNORE`) so re-running `initializeDatabase()` against a
   database that already has the migration applied is a no-op rather than
   an error — this matters for tests and for redeploying the same version
   twice.
6. Add or update a test that asserts `getMigrationVersion()` reflects the
   new version after `initializeDatabase()` runs, and that the new
   column/table/index is actually usable afterward (see
   `backend/tests/health.test.js` and `backend/tests/liveness.test.js` for
   the existing pattern of asserting on `dbVersion`).

## Notes for developers

- Migrations run automatically on every process start — there is no
  separate CLI migration step to remember to run in any environment.
- Never renumber or edit a migration that has already shipped; existing
  databases in the field have already recorded that `version` as applied
  and won't re-run it. Ship schema fixes as a new, higher-numbered
  migration instead.
- `checkDatabase()` (used by the detailed health check) also calls
  `getMigrationVersion()` as part of its lightweight connectivity probe, so
  a broken migration that leaves `schema_migrations` unreadable will show
  up there too.
