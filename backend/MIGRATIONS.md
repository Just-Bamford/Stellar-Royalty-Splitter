# Database Migrations

The backend uses a small, versioned migration system (issue #519) to evolve the
SQLite schema in a controlled, reversible way. It replaces the previous
forward-only inline loop, which had no rollback support and reused version
numbers (two migrations both used `version: 10`, which threw a `PRIMARY KEY`
violation on a fresh database).

## How it works

- **Engine:** [`src/database/migrations.js`](src/database/migrations.js) — applies,
  rolls back, and reports the status of migrations. Every operation works on an
  injected `db` handle, so it is unit-testable in isolation.
- **Registry:** the `MIGRATIONS` array in the same file. Each entry is:

  ```js
  {
    version: 11,                 // unique, strictly ascending integer
    name: "add-widgets-table",   // short, descriptive
    up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS widgets (...);`),
    down: (db) => db.exec(`DROP TABLE IF EXISTS widgets;`),
    // irreversible: true,       // optional — down throws; rollback is refused
    // selfTransaction: true,    // optional — migration manages its own txn/PRAGMA
  }
  ```

- **Tracking:** applied versions are stored in the `schema_migrations`
  (`version`, `name`, `applied_at`) table.
- **Boot path:** `initializeDatabase()` creates the baseline tables and then calls
  `migrateUp(db, {}, MIGRATIONS)`, so a server start always converges to the
  latest schema. The CLI shares the exact same engine and registry.

Each migration runs inside a transaction together with its bookkeeping write, so
a failure leaves the database unchanged for that step. Migrations flagged
`irreversible` (e.g. the baseline, or a destructive table rebuild) cannot be
rolled back — `migrateDown` stops with a clear error rather than risking data
loss.

## CLI usage

Run from the `backend/` directory:

```bash
npm run migrate:status      # show every migration and whether it is applied
npm run migrate:up          # apply all pending migrations
npm run migrate:down        # roll back the most recently applied migration

# Lower-level forms:
node scripts/migrate.js up --to 8        # apply pending migrations up to v8
node scripts/migrate.js down --step 2    # roll back the last 2 migrations
node scripts/migrate.js down --to 5      # roll back until the current version is 5
```

`migrate:status` example output:

```
Current schema version: 10

  ver  status     name
  ---  ---------  ----------------------------------------
    1  applied    baseline
    2  applied    enforce-fk-cascade
    ...
   10  applied    rbac-roles-and-retry-queues
```

## Adding a migration

1. Append a new object to `MIGRATIONS` with the next unused `version`.
2. Write `up(db)` to apply the change and `down(db)` to reverse it. Prefer
   `IF NOT EXISTS` / `IF EXISTS` guards so re-runs are safe.
3. If the change cannot be reversed safely, set `irreversible: true`.
4. Add or update tests in [`tests/migrations.test.js`](tests/migrations.test.js).
5. Verify with `npm run migrate:status`, `npm run migrate:up`, and (in a scratch
   database) `npm run migrate:down`.

The registry is validated at startup by `assertRegistryValid` — duplicate or
out-of-order versions fail fast instead of corrupting the schema.

## Rollback safety

- Rollbacks run newest-first and are transactional.
- `migrateDown` will not roll back past an `irreversible` migration.
- For production rollbacks, always take a database backup first; rolling back a
  migration that drops a table or column is destructive by nature.
