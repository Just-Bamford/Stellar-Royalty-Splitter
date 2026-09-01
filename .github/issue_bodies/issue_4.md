The contract has a `VERSION` constant and an `update_wasm()` entrypoint for upgrades, but there is no formal state migration framework. If a future version introduces breaking storage changes (e.g., new required fields, changed data types), old instances will fail or behave unexpectedly after upgrade. The current design preserves instance storage blindly, which works for additive changes but not for schema evolution.

**Relevant files:**
- `src/lib.rs` - VERSION constant (line ~45), update_wasm function
- `src/storage.rs` - storage access patterns

## Solution

Design a contract versioning and migration system:
1. Embed a migration function in the contract that runs on-demand (`migrate()` entrypoint)
2. Track applied migrations in storage to prevent re-running
3. Document migration patterns for future developers (e.g., "how to add a new field", "how to deprecate a field")
4. Add tests for migration scenarios (initialize on old version, upgrade, verify state is correct)

## Acceptance Criteria

- [ ] Add a `migrate(from_version: String)` entrypoint that applies version-specific state transformations
- [ ] Store applied migrations in persistent storage with timestamps
- [ ] Write at least one example migration (e.g., adding a new optional field)
- [ ] Add integration tests confirming state is correctly transformed
- [ ] Document migration patterns in a new `MIGRATIONS.md` file
- [ ] Verify upgrade path from current version to next version works

## Note for Contributors

If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.
