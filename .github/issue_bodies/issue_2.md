The Soroban contract validates that collaborator shares sum to 10,000 and rejects zero shares, but the duplicate address check (`DuplicateRecipient` error) is only enforced during `initialize` and `set_recipients`. When collaborators are updated via `set_recipients` or `set_default_recipients` in the contract, or when recipients are provided to `distribute_with_override`, a duplicate address can slip through if validation is bypassed or if persistent storage state becomes corrupted. This could lead to skewed payouts where a single address receives multiple shares.

**Relevant files:**
- `src/lib.rs` - initialize validation (lines ~200–250)
- `src/lib.rs` - distribute_with_override (lines ~600–700)
- `src/lib.rs` - set_recipients, set_default_recipients

## Solution

Ensure all code paths that accept a recipient list (initialize, set_recipients, set_default_recipients, distribute_with_override) perform the same duplicate address validation before any state mutation or transfer. Extract this logic into a dedicated validation function to avoid duplication and inconsistency.

## Acceptance Criteria

- [ ] Create a `validate_unique_addresses()` helper function in the contract
- [ ] Call this helper in initialize, set_recipients, set_default_recipients, and distribute_with_override
- [ ] Add unit tests for duplicate address rejection in each code path
- [ ] Verify that existing valid configurations continue to work (no false positives)
- [ ] Add an integration test confirming a duplicate address in override_recipients is rejected

## Note for Contributors

If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.
