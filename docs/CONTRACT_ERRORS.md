# Contract Error Reference

This document maps every numeric error code emitted by the `RoyaltySplitter` on-chain contract to its meaning, the condition that triggers it, and the recommended client-side handling.

Error codes correspond to the `ContractError` enum in [`src/lib.rs`](../src/lib.rs) and are exposed in Soroban failure payloads as `Error(Contract, #N)`.

The frontend utility at [`frontend/src/lib/contract-errors.ts`](../frontend/src/lib/contract-errors.ts) maps these codes to human-readable messages via `extractContractError`.

---

## Error Code Table

| Code | Name | Trigger Condition | Recommended Handling |
|------|------|-------------------|----------------------|
| 1 | `Underfunded` | `distribute` / `batch_distribute` called when the contract holds zero tokens. | Check the contract balance before initiating a distribution. Top up the contract first. |
| 2 | `AlreadyInitialized` | `initialize` called on a contract that already has an admin stored. | Do not call `initialize` more than once per contract. Check `is_initialized()` first. |
| 3 | `EmptyCollaborators` | `initialize` called with an empty collaborator list. | Provide at least one collaborator address. |
| 4 | `TooManyRecipients` | Collaborator or recipient list length exceeds `MAX_COLLABORATORS` (10) / `MAX_RECIPIENTS` (10). | Split into separate contracts or reduce the collaborator count. |
| 5 | `LengthMismatch` | `collaborators` and `shares` arrays passed to `initialize` have different lengths. | Ensure both arrays have identical lengths before submitting. |
| 6 | `InvalidShareTotal` | The sum of all basis-point shares does not equal exactly 10,000 (100%). | Validate that shares sum to 10,000 on the client before submitting. |
| 7 | `ZeroShare` | A collaborator or recipient has a share of `0`. | Assign a positive basis-point value (≥ 1) to every recipient. |
| 8 | `DuplicateRecipient` | The same wallet address appears more than once in the collaborator or recipient list. | Deduplicate the address list before submitting. |
| 9 | `InvalidBasisPoints` | A recipient's share exceeds 10,000 basis points. | Ensure each individual share is in the range [1, 10000]. |
| 10 | `NotInitialized` | A function that requires initialization (e.g., `get_version`) was called before `initialize`. | Check `is_initialized()` before calling state-dependent functions. |
| 11 | `NoCollaborators` | A function requiring the collaborator list was called but the list is not stored. | Re-initialize or call `set_recipients` to restore the collaborator list. |
| 12 | `NoShareMap` | A function requiring the share map was called but the map is not stored. | Re-initialize or call `set_recipients` to restore the share map. |
| 13 | `ArithmeticOverflow` | A payout calculation overflowed a `u128` / `i128` boundary. | Report the amount; amounts this large are not expected under normal operation. |
| 14 | `RoyaltyRateZero` | `set_royalty_rate` called with `new_rate = 0`. | Provide a positive basis-point value (≥ 1). |
| 15 | `RoyaltyRateTooHigh` | `set_royalty_rate` called with `new_rate > 10,000`. | Ensure the rate is in the range [1, 10000]. |
| 16 | `ContractPaused` | `distribute` or `distribute_secondary_royalties` called while the contract is paused. | Check `is_paused()` before distributing. Notify the admin to call `unpause` when ready. |
| 17 | `AmountNotPositive` | `withdraw` called with `amount ≤ 0`. | Provide a positive withdrawal amount. |
| 18 | `InsufficientBalance` | `withdraw` requested more tokens than the contract currently holds. | Query `get_balance` first and withdraw no more than the available balance. |
| 19 | `EmptyRecipients` | `distribute_with_override` / `batch_distribute` called with no recipients configured and no override list supplied. | Configure default recipients via `set_default_recipients`, or pass an explicit override list. |
| 20 | `AmountTooSmall` | The token balance is positive but smaller than the number of recipients (cannot give each at least 1 stroop). | Wait for more royalties to accumulate before distributing, or reduce the recipient count. |
| 21 | `PoolExceedsBalance` | The tracked secondary royalty pool value exceeds the contract's actual token balance (accounting inconsistency). | Do not distribute secondary royalties; investigate any manual transfers out of the contract. |
| 22 | `NoSecondaryRoyalties` | `distribute_secondary_royalties` called when the pool is empty (no royalties recorded since the last distribution). | Check the pool balance via `get_secondary_pool` before calling distribute. |
| 23 | `NoSecondaryToken` | `distribute_secondary_royalties` called before any secondary royalty has been recorded (no token address set). | Record at least one secondary royalty payment first via `record_secondary_royalty`. |
| 24 | `CollaboratorNotFound` | `get_share` or `update_share` called with an address that is not in the share map. | Verify the address is a registered collaborator via `is_collaborator` before querying. |
| 25 | `InvalidUpdatedShareTotal` | `update_share` called with a new share value that would cause the total to differ from 10,000. | Adjust other collaborators' shares to maintain a total of exactly 10,000 before updating. |
| 26 | `SalePriceNotPositive` | `record_secondary_sale` called with `sale_price ≤ 0`. | Provide a positive sale price. |
| 27 | `InputTooLarge` | `set_admins` called with more than `MAX_ADMIN_LIST` (10) addresses. | Reduce the admin list to 10 entries or fewer. |
| 32 | `TooManyBatchTokens` | `batch_distribute` called with more than `MAX_BATCH_TOKENS` (50) token addresses. | Split the token list into multiple `batch_distribute` calls of 50 tokens or fewer. |
| 33 | `RoyaltyAmountNotPositive` | `record_secondary_royalty` called with `royalty_amount ≤ 0`. | Provide a positive royalty amount. |
| 34 | `NoPendingAdminRotation` | `cancel_admin_rotation` / `finalize_admin_rotation` called with no rotation in progress. | Call `get_pending_admin_rotation()` first to confirm one is pending. |
| 35 | `AdminRotationTimelockNotElapsed` | `finalize_admin_rotation` called before `initiated_at + timelock` has passed. | Wait until the timelock elapses; check `get_pending_admin_rotation()` and `get_admin_rotation_timelock()`. |
| 36 | `InvalidTimelockDuration` | `set_admin_rotation_timelock` called with a value outside `[MIN_ADMIN_ROTATION_TIMELOCK, MAX_ADMIN_ROTATION_TIMELOCK]` (1 hour – 30 days). | Choose a duration within the allowed range. |

---

## Adding New Error Codes

When introducing a new error variant to the contract:

1. Append the new variant to the `ContractError` enum in `src/lib.rs` — never insert between existing variants, as this shifts all subsequent codes.
2. Add the corresponding entry to `CONTRACT_ERROR_MESSAGES` in `frontend/src/lib/contract-errors.ts`.
3. Add a row to the table above.
4. Add a test case in `frontend/src/lib/contract-errors.test.ts`.
