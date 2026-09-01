#![cfg(test)]
//! Property-based ("fuzz") tests for royalty allocation inputs (#715).
//!
//! Complements the hand-picked valid-allocation invariants already covered
//! for `distribute()` under "Issue #685" further down in
//! `tests/integration_test.rs` (payout conservation, no negative payouts,
//! no stranded funds, shares unchanged). This suite instead targets
//! `distribute_with_override`'s recipient-list validation (shared with
//! `set_recipients` / `set_default_recipients` via `validate_recipient_list`)
//! with randomly generated **valid and invalid** allocation combinations —
//! duplicate addresses, zero shares, share totals that don't sum to 10,000,
//! empty lists, and oversized lists — plus a wide range of distribution
//! amounts.
//!
//! Run with: `cargo test --test fuzz_royalty_allocation`
//! (also runs as part of a plain `cargo test`). No nightly toolchain,
//! `cargo-fuzz`, or live network required — see the "Property-Based / Fuzz
//! Tests" section of `TESTING.md` for the full guide, including how to
//! reproduce a specific case proptest reports as failing.
//!
//! Design notes:
//! - Recipient addresses are drawn from a small fixed-size pool per test
//!   run (not generated fresh per recipient), so proptest can and does
//!   produce genuine duplicate-address inputs — exercising that path is
//!   one of #715's explicit goals.
//! - Distribution amounts are bounded to `u64::MAX` — well within what
//!   `StellarAssetClient::mint` and the contract's own
//!   `checked_bps_amount`/`checked_add`/`checked_sub` overflow guards are
//!   designed to handle, per the issue's "keep generated inputs within
//!   supported contract limits" note. Every case builds its own
//!   `Env::default()` local test host; none of this touches a live network.

use proptest::prelude::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env,
};
use stellar_royalty_splitter::{ContractError, Recipient, RoyaltySplitterClient, MAX_RECIPIENTS};

const ADDRESS_POOL_SIZE: usize = 12;

fn setup(env: &Env) -> (Address, RoyaltySplitterClient<'_>) {
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(env, &contract_id);
    (contract_id, client)
}

/// A candidate `Recipient`, expressed as an index into a fixed address pool
/// (so proptest can generate genuine duplicate addresses) plus a raw share
/// value (so it can generate zero-share entries and totals that don't sum
/// to 10,000).
#[derive(Debug, Clone)]
struct RawRecipient {
    address_index: usize,
    share: u32,
}

/// 0 to 15 raw recipients: spans both sides of `MAX_RECIPIENTS` (10) and
/// includes the empty-list case.
fn raw_recipients_strategy() -> impl Strategy<Value = Vec<RawRecipient>> {
    proptest::collection::vec(
        (0..ADDRESS_POOL_SIZE, any::<u32>()).prop_map(|(address_index, share)| RawRecipient {
            address_index,
            share,
        }),
        0..15,
    )
}

/// Builds recipients whose shares are guaranteed to sum to exactly 10,000
/// and whose addresses are guaranteed distinct — i.e. a structurally valid
/// allocation, for property checks that need a "this should succeed"
/// baseline (recipient count still varies 1..=MAX_RECIPIENTS).
fn valid_recipients_strategy() -> impl Strategy<Value = Vec<RawRecipient>> {
    (1..=MAX_RECIPIENTS as usize).prop_map(|n| {
        let base = 10_000u32 / n as u32;
        let remainder = 10_000u32 - base * n as u32;
        (0..n)
            .map(|i| RawRecipient {
                address_index: i,
                share: if i == n - 1 { base + remainder } else { base },
            })
            .collect()
    })
}

fn to_recipients(env: &Env, pool: &[Address], raw: &[RawRecipient]) -> soroban_sdk::Vec<Recipient> {
    let mut recipients = vec![env];
    for r in raw {
        recipients.push_back(Recipient {
            address: pool[r.address_index].clone(),
            share: r.share,
        });
    }
    recipients
}

fn has_duplicate_address(raw: &[RawRecipient]) -> bool {
    for i in 0..raw.len() {
        for j in (i + 1)..raw.len() {
            if raw[i].address_index == raw[j].address_index {
                return true;
            }
        }
    }
    false
}

fn has_zero_share(raw: &[RawRecipient]) -> bool {
    raw.iter().any(|r| r.share == 0)
}

fn shares_sum_to_10_000(raw: &[RawRecipient]) -> bool {
    let mut total: u64 = 0;
    for r in raw {
        total += r.share as u64;
        if total > u32::MAX as u64 {
            return false;
        }
    }
    total == 10_000
}

fn is_structurally_valid(raw: &[RawRecipient]) -> bool {
    !raw.is_empty()
        && raw.len() <= MAX_RECIPIENTS as usize
        && !has_duplicate_address(raw)
        && !has_zero_share(raw)
        && shares_sum_to_10_000(raw)
}

/// Initializes a contract, funds it with `amount` of a fresh token (when
/// `amount > 0`), and returns a fixed pool of distinct addresses recipients
/// can be drawn from. Mirrors `setup_split` in `integration_test.rs`, but
/// keeps the address pool separate from the two collaborators `initialize`
/// itself requires, since `distribute_with_override`'s recipients here are
/// deliberately unconstrained (that's what's being fuzzed).
fn build_fixture<'a>(
    env: &'a Env,
    amount: i128,
) -> (Address, RoyaltySplitterClient<'a>, Address, Vec<Address>) {
    let (contract_id, client) = setup(env);

    let address_pool: Vec<Address> = (0..ADDRESS_POOL_SIZE)
        .map(|_| Address::generate(env))
        .collect();

    client.initialize(
        &vec![env, address_pool[0].clone(), address_pool[1].clone()],
        &vec![env, 5000_u32, 5000_u32],
    );

    let token_admin = Address::generate(env);
    let token = env.register_stellar_asset_contract(token_admin);
    if amount > 0 {
        StellarAssetClient::new(env, &token).mint(&contract_id, &amount);
    }

    (contract_id, client, token, address_pool)
}

proptest! {
    /// #715: the contract must never panic in a way that skips validation —
    /// every call either succeeds (only for a structurally valid list, funds
    /// permitting) or returns a typed `ContractError` via
    /// `try_distribute_with_override`, across arbitrary combinations of
    /// duplicate addresses, zero shares, share totals that don't sum to
    /// 10,000, empty lists, and oversized lists.
    #[test]
    fn no_panics_on_malformed_recipient_combinations(
        raw in raw_recipients_strategy(),
        amount in 1_i128..=(u64::MAX as i128),
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_contract_id, client, token, address_pool) = build_fixture(&env, amount);
        let recipients = to_recipients(&env, &address_pool, &raw);

        let result = client.try_distribute_with_override(&token, &recipients);

        if raw.is_empty() {
            // Fallback list has 2 collaborators from setup
            if amount >= 2 {
                prop_assert!(result.is_ok(), "fallback allocation unexpectedly rejected: {:?}", result);
            } else {
                prop_assert_eq!(result, Err(Ok(ContractError::AmountTooSmall.into())));
            }
        } else if is_structurally_valid(&raw) {
            if amount >= raw.len() as i128 {
                prop_assert!(result.is_ok(), "valid allocation unexpectedly rejected: {:?}", result);
            } else {
                // amount < recipient count: AmountTooSmall is the one
                // legitimate rejection reason for an otherwise-valid list.
                prop_assert_eq!(result, Err(Ok(ContractError::AmountTooSmall.into())));
            }
        } else if raw.len() > MAX_RECIPIENTS as usize {
            prop_assert_eq!(result, Err(Ok(ContractError::TooManyRecipients.into())));
        } else if has_zero_share(&raw) {
            prop_assert_eq!(result, Err(Ok(ContractError::ZeroShare.into())));
        } else if has_duplicate_address(&raw) {
            prop_assert_eq!(result, Err(Ok(ContractError::DuplicateRecipient.into())));
        } else {
            let mut total: u64 = 0;
            let mut overflows = false;
            for r in &raw {
                total += r.share as u64;
                if total > u32::MAX as u64 {
                    overflows = true;
                    break;
                }
            }
            if overflows {
                prop_assert_eq!(result, Err(Ok(ContractError::ArithmeticOverflow.into())));
            } else {
                prop_assert_eq!(result, Err(Ok(ContractError::InvalidShareTotal.into())));
            }
        }
    }

    /// #715: a rejected (invalid) allocation must never move funds or mutate
    /// distribution bookkeeping — the contract's token balance and
    /// distribute counter are unchanged after the failed call.
    #[test]
    fn rejected_allocation_preserves_contract_state(
        raw in raw_recipients_strategy(),
        amount in 1_i128..=(u64::MAX as i128),
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client, token, address_pool) = build_fixture(&env, amount);
        let recipients = to_recipients(&env, &address_pool, &raw);

        let would_succeed = (is_structurally_valid(&raw) && amount >= raw.len() as i128)
            || (raw.is_empty() && amount >= 2);
        // Only exercise the "invalid input" side of this property; the
        // valid-input, state-changes-as-expected side is covered by
        // `no_panics_on_malformed_recipient_combinations` above and by the
        // existing `test_distribute_with_override_uses_override` test.
        prop_assume!(!would_succeed);

        let balance_before = TokenClient::new(&env, &token).balance(&contract_id);
        let count_before = client.get_distribute_count();

        let result = client.try_distribute_with_override(&token, &recipients);
        prop_assert!(result.is_err(), "structurally invalid allocation unexpectedly succeeded: {:?}", raw);

        let balance_after = TokenClient::new(&env, &token).balance(&contract_id);
        let count_after = client.get_distribute_count();

        prop_assert_eq!(balance_before, balance_after);
        prop_assert_eq!(count_before, count_after);
    }

    /// #715: for any structurally valid allocation and any distribution
    /// amount at least as large as the recipient count, every recipient's
    /// payout must be non-negative and the sum of all payouts must exactly
    /// equal the distributed amount (no dust created or destroyed).
    #[test]
    fn valid_allocation_payouts_are_conserved(
        raw in valid_recipients_strategy(),
        amount in 1_i128..=(u64::MAX as i128),
    ) {
        prop_assume!(amount >= raw.len() as i128);

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client, token, address_pool) = build_fixture(&env, amount);
        let recipients = to_recipients(&env, &address_pool, &raw);

        client.distribute_with_override(&token, &recipients);

        let token_client = TokenClient::new(&env, &token);
        // Every recipient in `raw` has a distinct address_index by
        // construction (valid_recipients_strategy assigns index == position),
        // so summing each recipient's post-distribution balance double-counts
        // nothing.
        let mut total_paid: i128 = 0;
        for r in &raw {
            let balance = token_client.balance(&address_pool[r.address_index]);
            prop_assert!(balance >= 0);
            total_paid += balance;
        }

        prop_assert_eq!(total_paid, amount);
        prop_assert_eq!(
            token_client.balance(&contract_id),
            0,
            "contract should retain no dust after a full distribution"
        );
    }

    /// #715: distribution amounts smaller than the recipient count must be
    /// rejected (AmountTooSmall) rather than silently rounding some
    /// recipients down to a zero-stroop payout.
    #[test]
    fn amount_smaller_than_recipient_count_is_rejected(
        raw in valid_recipients_strategy(),
    ) {
        prop_assume!(raw.len() > 1);
        let amount = raw.len() as i128 - 1;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_contract_id, client, token, address_pool) = build_fixture(&env, amount);
        let recipients = to_recipients(&env, &address_pool, &raw);

        let result = client.try_distribute_with_override(&token, &recipients);
        prop_assert_eq!(result, Err(Ok(ContractError::AmountTooSmall.into())));
    }
}

/// #715: a specific, previously-unverified shape kept as a standalone
/// regression test alongside the fuzz properties above — a recipient list
/// containing only duplicates of the admin's own address. Documented here
/// as a concrete reproducible case in the sense #715 asks for ("record
/// reproducible failing inputs"); proptest itself additionally persists any
/// newly discovered failing case under `proptest-regressions/` the first
/// time this suite actually runs.
#[test]
fn admin_self_duplicate_is_rejected_not_silently_deduplicated() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);
    StellarAssetClient::new(&env, &token).mint(&contract_id, &1000_i128);

    let recipients = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 5000_u32,
        },
        Recipient {
            address: admin,
            share: 5000_u32,
        },
    ];

    let result = client.try_distribute_with_override(&token, &recipients);
    assert_eq!(result, Err(Ok(ContractError::DuplicateRecipient.into())));
}
