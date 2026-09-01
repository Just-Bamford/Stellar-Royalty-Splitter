# Contract Migrations

> Looking for the **backend** database migration system instead (SQLite
> schema, `schema_migrations` table, `dbVersion`)? See
> [`backend/MIGRATIONS.md`](backend/MIGRATIONS.md). This document covers only
> the Soroban contract's own migration mechanism.

The contract exposes `migrate(from_version: String)` so upgraded WASM can apply explicit state changes instead of relying on blind storage compatibility.

Current behavior:

- Requires current admin authorization.
- Records each `(from_version, VERSION)` migration in persistent storage with a ledger timestamp.
- Refuses to run the same migration twice.
- Writes an example optional field placeholder to demonstrate additive schema changes.

Future migration pattern:

1. Add new storage keys as optional values first.
2. In `migrate`, branch on `from_version` and fill defaults for the new keys.
3. Record the migration only after every write succeeds.
4. Keep old getters tolerant of missing optional fields for at least one release.
5. Add integration tests that initialize old-shaped state, call `migrate`, and assert both old and new getters still work.
