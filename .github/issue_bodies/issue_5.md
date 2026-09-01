The contract has `record_secondary_royalty()` and `distribute_secondary_royalties()` functions, but test coverage for edge cases is sparse:
- Multiple secondary royalties recorded in the same block without distribution
- Secondary pool overflow or underflow scenarios
- Rounding behavior when distributing a secondary pool with many collaborators
- State consistency after a failed distribution attempt

**Relevant files:**
- `tests/integration_test.rs` - existing tests
- `src/lib.rs` - record_secondary_royalty (line ~900), distribute_secondary_royalties (line ~1000)

## Solution

Add comprehensive integration tests for secondary royalty scenarios, focusing on state transitions, rounding correctness, and failure recovery. Test the secondary pool as a separate payment lane independent of primary distributions.

## Acceptance Criteria

- [ ] Test recording multiple secondary royalties without intermediate distribution
- [ ] Verify secondary pool balance accumulates correctly
- [ ] Test distribution of secondary pool with varying collaborator counts (2, 5, 10)
- [ ] Verify rounding: last collaborator receives remainder, total matches input
- [ ] Test that secondary royalties use correct token (set by first record_secondary_royalty call)
- [ ] Add at least 5 new integration tests; all existing tests pass

## Note for Contributors

If you're assigned to this issue, write a better description for your PR. Clearly explain what was changed, why it was needed, how it was implemented, and how it was tested.
