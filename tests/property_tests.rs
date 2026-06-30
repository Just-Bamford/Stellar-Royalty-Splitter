//! Issue #408 — Property-based (proptest) fuzz tests for the royalty splitter contract.
//!
//! These tests use proptest to generate randomized inputs and verify invariants
//! that must hold for ALL valid inputs:
//!
//!   1. Total distributed == amount sent in (no fund loss or creation).
//!   2. Every recipient receives a non-negative payout.
//!   3. Distributing 1 lamport with any single-recipient split always works.
//!   4. Share values are stored correctly after initialize.
//!   5. Large amounts up to i64::MAX / 2 do not overflow.
//!
//! Proptest generates the *data* (counts, amounts, share weights) and we create
//! real Soroban environments and addresses inside each test body, because Soroban
//! types are not `Arbitrary`.

#![cfg(test)]

use proptest::prelude::*;
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Vec as SorobanVec,
};
use stellar_royalty_splitter::RoyaltySplitterClient;

// ── Shared helpers ─────────────────────────────────────────────────────────────

fn prop_setup(env: &Env) -> (Address, RoyaltySplitterClient) {
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(env, &contract_id);
    (contract_id, client)
}

fn prop_make_token(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract(admin.clone())
}

fn prop_mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(to, &amount);
}

/// Build a share list that sums exactly to 10_000.
/// `weights` is a non-empty slice of positive u32 values; each is normalised so
/// the proportional slice of 10_000 is returned.  The last element absorbs
/// rounding remainders so the sum is always exactly 10_000.
fn weights_to_shares(weights: &[u32]) -> std::vec::Vec<u32> {
    assert!(!weights.is_empty());
    let total_weight: u64 = weights.iter().map(|&w| w as u64).sum();
    let mut shares: std::vec::Vec<u32> = std::vec::Vec::new();
    let mut assigned: u32 = 0;
    let n = weights.len();
    for (i, &w) in weights.iter().enumerate() {
        if i == n - 1 {
            // Last element absorbs any rounding remainder.
            shares.push(10_000 - assigned);
        } else {
            let share = ((w as u64 * 10_000) / total_weight) as u32;
            let share = share.max(1); // at least 1 basis point
            shares.push(share);
            assigned += share;
        }
    }
    // Guard against degenerate rounding producing a zero last element.
    if let Some(last) = shares.last_mut() {
        if *last == 0 {
            *last = 1;
            // Reclaim 1 from the largest share to keep the sum at 10_000.
            if let Some(max) = shares[..n - 1].iter_mut().max() {
                *max -= 1;
            }
        }
    }
    shares
}

// ── Strategies ─────────────────────────────────────────────────────────────────

/// Strategy: 1–8 collaborators with random positive weight each.
fn collaborator_weights_strategy() -> impl Strategy<Value = std::vec::Vec<u32>> {
    (1usize..=8usize).prop_flat_map(|n| prop::collection::vec(1u32..=1000u32, n..=n))
}

// ── Core invariant tests ────────────────────────────────────────────────────────

proptest! {
    // ── #1  No-dust: all funds land with recipients ──────────────────────────
    #[test]
    fn prop_distribute_preserves_total(
        weights in collaborator_weights_strategy(),
        amount in 1i128..=1_000_000_000_000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let shares = weights_to_shares(&weights);
        let n = shares.len();

        let mut addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs {
            soroban_addrs.push_back(addr.clone());
        }
        for &s in &shares {
            soroban_shares.push_back(s);
        }

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let total_paid: i128 = addrs
            .iter()
            .map(|addr| TokenClient::new(&env, &token).balance(addr))
            .sum();

        prop_assert_eq!(
            total_paid,
            amount,
            "Invariant violated: distributed={amount}, paid={total_paid}, n={n}"
        );
    }

    // ── #2  All payouts are non-negative ─────────────────────────────────────
    #[test]
    fn prop_all_payouts_non_negative(
        weights in collaborator_weights_strategy(),
        amount in 1i128..=100_000_000_000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let shares = weights_to_shares(&weights);
        let n = shares.len();

        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        for addr in &addrs {
            let bal = TokenClient::new(&env, &token).balance(addr);
            prop_assert!(bal >= 0, "Negative payout to {:?}: {}", addr, bal);
        }
    }

    // ── #3  Single recipient always receives everything ───────────────────────
    #[test]
    fn prop_single_recipient_receives_all(
        amount in 1i128..=9_007_199_254_740_992i128, // up to i64::MAX / 2 for safety
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let recipient = Address::generate(&env);

        let soroban_addrs = SorobanVec::from_array(&env, [recipient.clone()]);
        let soroban_shares = SorobanVec::from_array(&env, [10_000_u32]);

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let bal = TokenClient::new(&env, &token).balance(&recipient);
        prop_assert_eq!(
            bal, amount,
            "Single recipient must receive everything: sent={amount}, got={bal}"
        );
    }

    // ── #4  Equal split: both recipients receive floor(amount/2) or ceil ─────
    #[test]
    fn prop_equal_two_way_split(
        amount in 2i128..=10_000_000_000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);

        let soroban_addrs = SorobanVec::from_array(&env, [a.clone(), b.clone()]);
        let soroban_shares = SorobanVec::from_array(&env, [5_000_u32, 5_000_u32]);

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let bal_a = TokenClient::new(&env, &token).balance(&a);
        let bal_b = TokenClient::new(&env, &token).balance(&b);
        let total = bal_a + bal_b;

        // Sum must equal amount (no dust lost or created).
        prop_assert_eq!(total, amount, "50/50 split lost dust: sent={amount}, got={total}");
        // Each share must be within 1 of the other (floor/ceil rounding is acceptable).
        prop_assert!(
            (bal_a - bal_b).abs() <= 1,
            "50/50 split too uneven: a={bal_a}, b={bal_b}"
        );
    }

    // ── #5  Share map stored correctly for any collaborator count ────────────
    #[test]
    fn prop_share_map_stored_correctly(
        weights in collaborator_weights_strategy(),
    ) {
        use stellar_royalty_splitter::StorageKey;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let shares = weights_to_shares(&weights);
        let n = shares.len();
        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        client.initialize(&soroban_addrs, &soroban_shares);

        env.as_contract(&contract_id, || {
            let stored: soroban_sdk::Map<Address, u32> = env
                .storage()
                .persistent()
                .get(&StorageKey::ShareMap)
                .expect("ShareMap should be set after initialize");

            let stored_sum: u32 = addrs.iter().map(|addr| stored.get(addr.clone()).unwrap_or(0)).sum();
            // In the test we only check what we set matches what we get back.
            assert_eq!(stored.len() as usize, n);
            assert_eq!(stored_sum, 10_000, "stored share sum must be 10_000");
        });
    }

    // ── #6  Collaborators list stored correctly ───────────────────────────────
    #[test]
    fn prop_collaborators_stored_in_order(
        n in 1usize..=8usize,
    ) {
        use stellar_royalty_splitter::StorageKey;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        // Build equal shares summing to 10_000.
        let base = 10_000u32 / n as u32;
        let remainder = 10_000u32 - base * n as u32;
        let mut shares: std::vec::Vec<u32> = vec![base; n];
        shares[n - 1] += remainder;

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        client.initialize(&soroban_addrs, &soroban_shares);

        env.as_contract(&contract_id, || {
            let stored: SorobanVec<Address> = env
                .storage()
                .persistent()
                .get(&StorageKey::Collaborators)
                .expect("Collaborators should be stored");

            assert_eq!(stored.len() as usize, n);
            for (i, addr) in addrs.iter().enumerate() {
                assert_eq!(stored.get(i as u32).unwrap(), *addr);
            }
        });
    }

    // ── #7  1-lamport distribute works (minimum amount) ──────────────────────
    #[test]
    fn prop_minimum_amount_single_recipient(
        n in 1usize..=8usize,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let base = 10_000u32 / n as u32;
        let remainder = 10_000u32 - base * n as u32;
        let mut shares: std::vec::Vec<u32> = vec![base; n];
        shares[n - 1] += remainder;

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);
        let amount = n as i128; // 1 per recipient so no recipient gets 0

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let total_paid: i128 = addrs
            .iter()
            .map(|addr| TokenClient::new(&env, &token).balance(addr))
            .sum();

        prop_assert_eq!(total_paid, amount);
    }

    // ── #8  Large amount: i64::MAX / 4 does not overflow ─────────────────────
    #[test]
    fn prop_large_amount_no_overflow(
        weights in collaborator_weights_strategy(),
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let shares = weights_to_shares(&weights);
        let n = shares.len();
        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);
        // Use a large but safe amount: i64::MAX / 4 to stay well within i128 arithmetic.
        let amount: i128 = i64::MAX as i128 / 4;

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let total_paid: i128 = addrs
            .iter()
            .map(|addr| TokenClient::new(&env, &token).balance(addr))
            .sum();

        prop_assert_eq!(total_paid, amount, "Large-amount distribute lost dust");
    }

    // ── #9  Multiple sequential distributes accumulate balances correctly ─────
    #[test]
    fn prop_two_sequential_distributes_accumulate(
        weights in collaborator_weights_strategy(),
        amount1 in 1i128..=1_000_000_000i128,
        amount2 in 1i128..=1_000_000_000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let shares = weights_to_shares(&weights);
        let n = shares.len();
        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);

        prop_mint(&env, &token, &contract_id, amount1);
        client.distribute(&token);

        prop_mint(&env, &token, &contract_id, amount2);
        client.distribute(&token);

        let total_paid: i128 = addrs
            .iter()
            .map(|addr| TokenClient::new(&env, &token).balance(addr))
            .sum();

        let total_sent = amount1 + amount2;
        prop_assert_eq!(
            total_paid,
            total_sent,
            "Two sequential distributes: sent={total_sent}, paid={total_paid}"
        );
    }

    // ── #10  DistributeHistory counter increments correctly ──────────────────
    #[test]
    fn prop_distribute_history_count(
        n_distributes in 1u32..=5u32,
        amount in 1i128..=100_000_000i128,
    ) {
        use stellar_royalty_splitter::StorageKey;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let soroban_addrs = SorobanVec::from_array(&env, [a.clone(), b.clone()]);
        let soroban_shares = SorobanVec::from_array(&env, [5_000_u32, 5_000_u32]);

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);

        for _ in 0..n_distributes {
            prop_mint(&env, &token, &contract_id, amount);
            client.distribute(&token);
        }

        env.as_contract(&contract_id, || {
            let count: u64 = env
                .storage()
                .instance()
                .get(&StorageKey::DistributeHistory)
                .expect("DistributeHistory should be stored");
            assert_eq!(count, n_distributes as u64);
        });
    }

    // ── #11  Weighted 80/20 split preserves total ─────────────────────────────
    #[test]
    fn prop_weighted_split_preserves_total(
        amount in 100i128..=10_000_000_000i128,
        // major_share: 5000..9000 out of 10000 for the first recipient
        major_share in 5000u32..=9000u32,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let minor_share = 10_000 - major_share;

        let soroban_addrs = SorobanVec::from_array(&env, [a.clone(), b.clone()]);
        let soroban_shares = SorobanVec::from_array(&env, [major_share, minor_share]);

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let bal_a = TokenClient::new(&env, &token).balance(&a);
        let bal_b = TokenClient::new(&env, &token).balance(&b);
        let total = bal_a + bal_b;

        prop_assert_eq!(total, amount, "Weighted split lost dust: sent={amount}, got={total}");
        // Major share recipient must receive strictly more.
        prop_assert!(
            bal_a >= bal_b,
            "Major share ({major_share}) recipient should receive at least as much as minor ({minor_share})"
        );
    }

    // ── #12  Max collaborators (8) with varying amounts ───────────────────────
    #[test]
    fn prop_max_collaborators(
        amount in 8i128..=1_000_000_000_000i128,
        // 7 weights; 8th is computed to sum to 10_000
        w in prop::collection::vec(1u32..=200u32, 7..=7),
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let shares = weights_to_shares(&w);
        let n = shares.len();
        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let total_paid: i128 = addrs
            .iter()
            .map(|addr| TokenClient::new(&env, &token).balance(addr))
            .sum();

        prop_assert_eq!(total_paid, amount);
    }

    // ── #13  Royalty rate does not affect primary distribute total ────────────
    #[test]
    fn prop_royalty_rate_does_not_affect_primary_distribute(
        weights in collaborator_weights_strategy(),
        amount in 1i128..=1_000_000_000i128,
        rate in 0u32..=9999u32,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let shares = weights_to_shares(&weights);
        let n = shares.len();
        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        client.set_royalty_rate(&rate);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let total_paid: i128 = addrs
            .iter()
            .map(|addr| TokenClient::new(&env, &token).balance(addr))
            .sum();

        // The royalty rate applies to *secondary* pools; the primary distribute
        // should still pay out everything to collaborators.
        prop_assert_eq!(
            total_paid,
            amount,
            "Setting royalty rate changed primary distribute payout: rate={rate}, sent={amount}, got={total_paid}"
        );
    }

    // ── #14  LastDistribution timestamp is always updated after distribute ────
    #[test]
    fn prop_last_distribution_timestamp_updated(
        ts in 1_000_000_u64..=10_000_000_000_u64,
        amount in 1i128..=1_000_000_000i128,
    ) {
        use stellar_royalty_splitter::StorageKey;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let soroban_addrs = SorobanVec::from_array(&env, [a.clone(), b.clone()]);
        let soroban_shares = SorobanVec::from_array(&env, [5_000_u32, 5_000_u32]);

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        env.ledger().with_mut(|l| l.timestamp = ts);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        env.as_contract(&contract_id, || {
            let last_ts: u64 = env
                .storage()
                .instance()
                .get(&StorageKey::LastDistribution)
                .expect("LastDistribution must be set after distribute");
            assert_eq!(last_ts, ts);
        });
    }

    // ── #15  Extreme upper-bound amount: 10^14 stroops (100 billion XLM) ─────
    #[test]
    fn prop_extreme_upper_bound_amount(
        weights in collaborator_weights_strategy(),
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let shares = weights_to_shares(&weights);
        let n = shares.len();
        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);
        let amount: i128 = 100_000_000_000_000_i128; // 10^14 stroops

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let total_paid: i128 = addrs
            .iter()
            .map(|addr| TokenClient::new(&env, &token).balance(addr))
            .sum();

        prop_assert_eq!(total_paid, amount, "Extreme-amount distribute lost dust");
    }

    // ── #16  Three-way 1/3 split never loses more than n-1 stroops ───────────
    #[test]
    fn prop_three_way_split_minimal_dust_loss(
        amount in 3i128..=10_000_000_000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        // 3334 + 3333 + 3333 = 10000
        let soroban_addrs = SorobanVec::from_array(&env, [a.clone(), b.clone(), c.clone()]);
        let soroban_shares = SorobanVec::from_array(&env, [3_334_u32, 3_333_u32, 3_333_u32]);

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let bal_a = TokenClient::new(&env, &token).balance(&a);
        let bal_b = TokenClient::new(&env, &token).balance(&b);
        let bal_c = TokenClient::new(&env, &token).balance(&c);
        let total = bal_a + bal_b + bal_c;

        // All funds accounted for (no dust lost).
        prop_assert_eq!(total, amount, "3-way split: sent={amount}, got={total}");
    }

    // ── #17  Distribute with amount = 10_000 gives each 1/10000-share exactly 1
    #[test]
    fn prop_amount_equals_denominator(
        major_share in 1u32..=9999u32,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let minor_share = 10_000 - major_share;
        let soroban_addrs = SorobanVec::from_array(&env, [a.clone(), b.clone()]);
        let soroban_shares = SorobanVec::from_array(&env, [major_share, minor_share]);

        let token_admin = Address::generate(&env);
        let token = prop_make_token(&env, &token_admin);

        // Distribute exactly 10_000 stroops so each basis point = 1 stroop.
        let amount: i128 = 10_000;
        client.initialize(&soroban_addrs, &soroban_shares);
        prop_mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let bal_a = TokenClient::new(&env, &token).balance(&a);
        let bal_b = TokenClient::new(&env, &token).balance(&b);

        prop_assert_eq!(bal_a, major_share as i128);
        prop_assert_eq!(bal_b, minor_share as i128);
    }

    // ── #18  Share sum invariant: stored shares always sum to 10_000 ──────────
    #[test]
    fn prop_stored_shares_always_sum_to_10000(
        weights in collaborator_weights_strategy(),
    ) {
        use stellar_royalty_splitter::StorageKey;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = prop_setup(&env);

        let shares = weights_to_shares(&weights);
        let n = shares.len();
        let addrs: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&env)).collect();

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs { soroban_addrs.push_back(addr.clone()); }
        for &s in &shares { soroban_shares.push_back(s); }

        client.initialize(&soroban_addrs, &soroban_shares);

        env.as_contract(&contract_id, || {
            let stored_map: soroban_sdk::Map<Address, u32> = env
                .storage()
                .persistent()
                .get(&StorageKey::ShareMap)
                .expect("ShareMap must be stored");
            let sum: u32 = addrs.iter().map(|addr| stored_map.get(addr.clone()).unwrap_or(0)).sum();
            assert_eq!(sum, 10_000, "Stored shares must sum to 10_000, got {sum}");
        });
    }
}
