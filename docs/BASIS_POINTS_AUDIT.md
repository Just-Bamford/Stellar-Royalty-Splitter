# Basis-Point Arithmetic Audit

Royalty shares are represented in basis points where `10_000` equals 100%.

Audited paths:

- `initialize` and `reveal_initialize` validate that collaborator shares sum to `10_000`.
- `set_recipients`, `set_default_recipients`, and `distribute_with_override` share recipient-list validation.
- `distribute`, `distribute_with_override`, `distribute_secondary_royalties`, and `record_secondary_sale` route payout math through `checked_bps_amount`.

Overflow assumptions:

- Amounts must be non-negative `i128` values.
- Basis points are bounded by validation to `0..=10_000`.
- Multiplication is performed as `u128` with `checked_mul`, then bounded back to `i128`.
- Share totals use checked addition before comparing with `10_000`.

Rounding behavior:

- All non-final recipients receive `amount * bps / 10_000`.
- The last recipient receives `amount - total_calculated`.
- This conserves the full input amount and bounds rounding dust by at most `recipient_count - 1` stroops.

Regression coverage:

- `tests/fuzz_royalty_allocation.rs` covers malformed and valid recipient allocations with property tests.
- `tests/integration_test.rs` covers concrete dust and conservation cases.
