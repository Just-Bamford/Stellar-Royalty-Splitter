#![cfg(test)]
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, IntoVal, Vec as SorobanVec,
};
use stellar_royalty_splitter::{DataKey, RoyaltySplitterClient};

fn setup(env: &Env) -> (Address, RoyaltySplitterClient) {
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(env, &contract_id);
    (contract_id, client)
}

fn make_token(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract(admin.clone())
}

fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(to, &amount);
}

#[test]
#[should_panic(expected = "contract not initialized")]
fn test_distribute_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);
    client.distribute(&token);
}

#[test]
#[should_panic(expected = "no balance to distribute")]
fn test_distribute_zero_balance_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);
    client.initialize(&vec![&env, a, b], &vec![&env, 5000_u32, 5000_u32]);
    // contract balance is 0 — must panic
    client.distribute(&token);
}

#[test]
#[should_panic(expected = "shares must sum to 10000")]
fn test_royalty_rate_exceeds_max_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    // shares sum to 10001, not 10000
    client.initialize(&vec![&env, a, b], &vec![&env, 5001_u32, 5000_u32]);
}

/// Issue #106 — worst-case dust: last collaborator holds 1 bp (0.01%) and the
/// distribution amount is 9_999 stroops (just under 10_000).
/// Concretely: payout_a = 9_999 * 9_999 / 10_000 = 9_998, dust = 1.
#[test]
fn test_dust_bounded_for_1bp_last_collaborator() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let last = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), last.clone()],
        &vec![&env, 9999_u32, 1_u32],
    );

    let amount: i128 = 9_999;
    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    let admin_payout = TokenClient::new(&env, &token).balance(&admin);
    let last_payout = TokenClient::new(&env, &token).balance(&last);

    assert_eq!(admin_payout, 9_998);
    assert_eq!(last_payout, 1);
    assert_eq!(admin_payout + last_payout, amount);
}

/// Issue #116 — distribute uses specific mock_auths so the test fails if
/// admin.require_auth() is removed from the contract.
#[test]
fn test_distribute_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths();
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "distribute",
            args: (&token,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.distribute(&token);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
}

/// TTL — advancing the ledger past MIN_TTL and calling a read function must
/// still succeed because every public function extends the TTL on entry.
#[test]
fn test_ttl_extended_after_ledger_advance() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 6000_u32, 4000_u32]);

    // Advance ledger sequence past MIN_TTL (17_280 ledgers).
    env.ledger().set_sequence_number(env.ledger().sequence() + 17_281);

    // Both read functions must still return correct data (TTL was extended).
    let collaborators = client.get_collaborators();
    assert_eq!(collaborators.len(), 2);
    assert_eq!(client.get_share(&a), 6000);
    assert_eq!(client.get_share(&b), 4000);
}

/// Events — distribute emits a ("royalty", "dist_all") event with (token, amount).
#[test]
fn test_distribute_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("dist_all").into_val(&env),
                ]
            && data == (token.clone(), amount).into_val(&env)
    });
    assert!(found, "dist_all event not emitted");
}

/// Events — set_royalty_rate emits a ("royalty", "rate_set") event with the new rate.
#[test]
fn test_set_royalty_rate_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let rate: u32 = 250;
    client.set_royalty_rate(&rate);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("rate_set").into_val(&env),
                ]
            && data == rate.into_val(&env)
    });
    assert!(found, "rate_set event not emitted");
}

/// Events — distribute_secondary_royalties emits a ("royalty", "sec_dist") event.
#[test]
fn test_distribute_secondary_royalties_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);
    client.distribute_secondary_royalties();

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("sec_dist").into_val(&env),
                ]
            && data == (token.clone(), pool_amount).into_val(&env)
    });
    assert!(found, "sec_dist event not emitted");
}

#[test]
#[should_panic(expected = "share cannot be zero")]
fn test_zero_share_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    // b has a zero share — must panic
    client.initialize(&vec![&env, a, b], &vec![&env, 10000_u32, 0_u32]);
}

#[test]
fn test_collaborator_count() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    client.initialize(
        &vec![&env, a, b, c],
        &vec![&env, 5000_u32, 3000_u32, 2000_u32],
    );
    assert_eq!(client.collaborator_count(), 3);
}

#[test]
#[should_panic]
fn test_unauthorized_init_rejected() {
    let env = Env::default();
    // No mock_all_auths — require_auth() on the admin must reject the call.
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin, b], &vec![&env, 5000_u32, 5000_u32]);
}

/// Issue #160 — pause blocks distribute.
#[test]
#[should_panic(expected = "contract is paused")]
fn test_distribute_blocked_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    mint(&env, &token, &contract_id, 1000);

    client.pause();
    // Must panic with "contract is paused"
    client.distribute(&token);
}

/// Issue #160 — pause blocks distribute_secondary_royalties.
#[test]
#[should_panic(expected = "contract is paused")]
fn test_distribute_secondary_blocked_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);

    client.pause();
    // Must panic with "contract is paused"
    client.distribute_secondary_royalties();
}

/// Issue #160 — unpause re-enables distribute.
#[test]
fn test_distribute_succeeds_after_unpause() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    mint(&env, &token, &contract_id, 1000);

    client.pause();
    assert!(client.is_paused());

    client.unpause();
    assert!(!client.is_paused());

    // Should succeed now
    client.distribute(&token);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
}

/// Issue #160 — pause and unpause require admin auth.
#[test]
#[should_panic]
fn test_pause_requires_admin_auth() {
    let env = Env::default();
    // No mock_all_auths — require_auth() must reject non-admin callers.
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    // Clear auths so the next call has no authorization
    env.mock_auths(&[]);
    client.pause();
}

// ── #224: royalty rate boundary values ──────────────────────────────────────

/// Rate of 0 is valid (disables royalties).
#[test]
fn test_royalty_rate_boundary_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin, b], &vec![&env, 5000_u32, 5000_u32]);

    client.set_royalty_rate(&0_u32);
    assert_eq!(client.get_royalty_rate(), 0);
}

/// Rate of 10,000 is valid (100% royalty).
#[test]
fn test_royalty_rate_boundary_max() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin, b], &vec![&env, 5000_u32, 5000_u32]);

    client.set_royalty_rate(&10_000_u32);
    assert_eq!(client.get_royalty_rate(), 10_000);
}

/// Rate of 10,001 must be rejected with a descriptive error.
#[test]
#[should_panic(expected = "royalty rate cannot exceed 10000 basis points")]
fn test_royalty_rate_above_max_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin, b], &vec![&env, 5000_u32, 5000_u32]);

    client.set_royalty_rate(&10_001_u32);
}

// ── Issue #219: unauthorized caller for set_royalty_rate ─────────────────────

/// A non-admin address calling set_royalty_rate must panic.
/// Does NOT use mock_all_auths() — simulates a real unauthorized caller.
/// Pattern mirrors test_pause_requires_admin_auth.
#[test]
#[should_panic]
fn test_set_royalty_rate_unauthorized_caller() {
    let env = Env::default();

    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    // Initialize with mock_all_auths so setup succeeds
    env.mock_all_auths();
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    // Clear all auths — the next call has no authorization at all,
    // simulating a non-admin (or any unauthorized) caller.
    env.mock_auths(&[]);

    // Must panic: require_auth() on admin will fail
    client.set_royalty_rate(&500_u32);
}

// ── Issue #220: unauthorized caller for distribute ───────────────────────────

/// Calling distribute without admin auth must be rejected atomically.
/// No token transfers should occur and the contract balance must remain unchanged.
/// Does NOT use mock_all_auths() for the distribute call.
#[test]
#[should_panic]
fn test_distribute_unauthorized_caller() {
    let env = Env::default();

    let (contract_id, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    // Initialize and fund the contract
    env.mock_all_auths();
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let amount: i128 = 1_000;
    mint(&env, &token, &contract_id, amount);

    // Verify the contract has the expected balance before the unauthorized call
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), amount);

    // Clear all auths — simulate a non-admin caller with no authorization
    env.mock_auths(&[]);

    // Must panic: require_auth() on admin will reject this call before any
    // token transfers occur, leaving the contract balance unchanged.
    client.distribute(&token);
}

// ── Issue #252: fuzz-style tests for distribute ──────────────────────────────

/// Simple deterministic LCG for reproducible pseudo-random test inputs.
struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    fn range(&mut self, min: u64, max: u64) -> u64 {
        min + self.next() % (max - min + 1)
    }
}

/// Issue #252 — fuzz-style: 20 iterations of randomized recipient counts (1–10),
/// payment amounts (1 to 10^15 stroops), and share splits that sum to 10,000.
/// Invariant: sum of all payouts equals total distributed amount (no lost dust).
#[test]
fn test_distribute_fuzz_style_invariant() {
    let mut rng = Lcg::new(0xDEAD_BEEF_CAFE_1234);

    for _ in 0..20 {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);

        let n = rng.range(1, 10) as u32;

        let mut addrs: std::vec::Vec<Address> = std::vec::Vec::new();
        for _ in 0..n {
            addrs.push(Address::generate(&env));
        }

        // Generate shares that sum exactly to 10_000 (≥ 1 each)
        let mut shares: std::vec::Vec<u32> = std::vec::Vec::new();
        let mut remaining: u32 = 10_000;
        for i in 0..n {
            if i == n - 1 {
                shares.push(remaining);
            } else {
                let slots_left = (n - 1 - i) as u64;
                let max_share = (remaining - slots_left as u32) as u64;
                let share = rng.range(1, max_share) as u32;
                shares.push(share);
                remaining -= share;
            }
        }

        let amount: i128 = rng.range(1, 1_000_000_000_000_000) as i128;

        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs {
            soroban_addrs.push_back(addr.clone());
        }
        for &s in &shares {
            soroban_shares.push_back(s);
        }

        client.initialize(&soroban_addrs, &soroban_shares);
        mint(&env, &token, &contract_id, amount);
        client.distribute(&token);

        let mut total_paid: i128 = 0;
        for addr in &addrs {
            total_paid += TokenClient::new(&env, &token).balance(addr);
        }
        assert_eq!(
            total_paid, amount,
            "Payout sum must equal distributed amount (n={n}, amount={amount})"
        );
    }
}

/// Issue #252 — fuzz-style: large payment amounts that previously risked i128 overflow
/// when multiplied before dividing (now uses u128 intermediate arithmetic).
/// Tests amounts up to i128::MAX / 10_000 across varied split configurations.
#[test]
fn test_distribute_fuzz_large_amounts_no_overflow() {
    let large_amounts: [i128; 6] = [
        i128::MAX / 10_001,       // just under overflow boundary
        i128::MAX / 20_000,
        1_000_000_000_000_000_000, // 10^18 stroops
        9_999_999_999_999_999,
        1,
        10_000,
    ];

    let split_configs: [(u32, u32); 4] = [
        (5_000, 5_000),
        (9_999, 1),
        (1, 9_999),
        (3_333, 6_667),
    ];

    for amount in large_amounts {
        for (share_a, share_b) in split_configs {
            let env = Env::default();
            env.mock_all_auths();
            let (contract_id, client) = setup(&env);

            let admin = Address::generate(&env);
            let b = Address::generate(&env);
            let token_admin = Address::generate(&env);
            let token = make_token(&env, &token_admin);

            client.initialize(
                &vec![&env, admin.clone(), b.clone()],
                &vec![&env, share_a, share_b],
            );
            mint(&env, &token, &contract_id, amount);
            client.distribute(&token);

            let paid = TokenClient::new(&env, &token).balance(&admin)
                + TokenClient::new(&env, &token).balance(&b);
            assert_eq!(paid, amount, "large amount={amount} share=({share_a},{share_b})");
        }
    }
}

/// Issue #252 — fuzz-style: randomized secondary royalty distributions (1–10 recipients)
/// verify the pool is fully emptied with no dust left behind.
#[test]
fn test_distribute_secondary_fuzz_style() {
    let mut rng = Lcg::new(0xCAFE_BABE_1234_5678);

    for _ in 0..15 {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);

        let n = rng.range(1, 10) as u32;

        let mut addrs: std::vec::Vec<Address> = std::vec::Vec::new();
        for _ in 0..n {
            addrs.push(Address::generate(&env));
        }

        let mut shares: std::vec::Vec<u32> = std::vec::Vec::new();
        let mut remaining: u32 = 10_000;
        for i in 0..n {
            if i == n - 1 {
                shares.push(remaining);
            } else {
                let slots_left = (n - 1 - i) as u64;
                let max_share = (remaining - slots_left as u32) as u64;
                let share = rng.range(1, max_share) as u32;
                shares.push(share);
                remaining -= share;
            }
        }

        let pool_amount: i128 = rng.range(1, 1_000_000_000_000_000) as i128;

        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs {
            soroban_addrs.push_back(addr.clone());
        }
        for &s in &shares {
            soroban_shares.push_back(s);
        }

        client.initialize(&soroban_addrs, &soroban_shares);
        mint(&env, &token, &addrs[0], pool_amount);
        client.record_secondary_royalty(&token, &addrs[0], &pool_amount);
        client.distribute_secondary_royalties();

        let mut total_paid: i128 = 0;
        for addr in &addrs {
            total_paid += TokenClient::new(&env, &token).balance(addr);
        }
        assert_eq!(
            total_paid, pool_amount,
            "Secondary pool must be fully distributed (n={n}, pool={pool_amount})"
        );
        assert_eq!(client.get_secondary_pool(), 0, "Secondary pool must be zero after distribution");
    }
}

// ── Issue #245: hard cap of 10 recipients ────────────────────────────────────

/// Issue #245 — initialize with exactly 10 recipients must succeed.
#[test]
fn test_initialize_with_10_recipients_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);

    let mut addrs: SorobanVec<Address> = SorobanVec::new(&env);
    let mut shares: SorobanVec<u32> = SorobanVec::new(&env);
    
    for _ in 0..10 {
        addrs.push_back(Address::generate(&env));
        shares.push_back(1_000_u32);
    }

    client.initialize(&addrs, &shares);
    assert_eq!(client.collaborator_count(), 10);
}

/// Issue #245 — initialize with 11 recipients must panic with descriptive error.
#[test]
#[should_panic(expected = "too many recipients: maximum 10 allowed")]
fn test_initialize_with_11_recipients_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);

    let mut addrs: SorobanVec<Address> = SorobanVec::new(&env);
    let mut shares: SorobanVec<u32> = SorobanVec::new(&env);
    
    for i in 0..11 {
        addrs.push_back(Address::generate(&env));
        // First recipient gets 1000, others get 900 to sum to 10,000
        shares.push_back(if i == 0 { 1_000_u32 } else { 900_u32 });
    }

    client.initialize(&addrs, &shares);
}

/// Issue #245 — initialize with 15 recipients must panic with descriptive error.
#[test]
#[should_panic(expected = "too many recipients: maximum 10 allowed")]
fn test_initialize_with_15_recipients_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);

    let mut addrs: SorobanVec<Address> = SorobanVec::new(&env);
    let mut shares: SorobanVec<u32> = SorobanVec::new(&env);
    
    for _ in 0..15 {
        addrs.push_back(Address::generate(&env));
        shares.push_back(666_u32); // Won't sum to 10,000 but cap check happens first
    }

    client.initialize(&addrs, &shares);
}

// ── Issue #234: re-initialization guard ──────────────────────────────────────

/// Issue #234 — calling initialize twice must panic with descriptive error.
#[test]
#[should_panic(expected = "already initialized")]
fn test_initialize_twice_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    
    client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    
    // Second initialization attempt must panic
    let c = Address::generate(&env);
    let d = Address::generate(&env);
    client.initialize(&vec![&env, c, d], &vec![&env, 6000_u32, 4000_u32]);
}

/// Issue #234 — re-initialization attempt must not modify existing state.
#[test]
fn test_reinitialize_does_not_modify_state() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    
    client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    
    let original_count = client.collaborator_count();
    let original_share_a = client.get_share(&a);
    
    // Attempt second initialization (will panic, but we catch it)
    let c = Address::generate(&env);
    let d = Address::generate(&env);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.initialize(&vec![&env, c, d], &vec![&env, 6000_u32, 4000_u32]);
    }));
    
    assert!(result.is_err(), "Second initialization should panic");
    
    // Verify original state is unchanged
    assert_eq!(client.collaborator_count(), original_count);
    assert_eq!(client.get_share(&a), original_share_a);
}

// ── Issue #242: admin_transfer ───────────────────────────────────────────────

fn read_admin(env: &Env, contract_id: &Address) -> Address {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set")
    })
}

#[test]
fn test_admin_transfer_updates_admin() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    env.mock_all_auths();
    client.initialize(
        &vec![&env, admin.clone(), b],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "admin_transfer",
            args: (&new_admin,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.admin_transfer(&new_admin);

    assert_eq!(read_admin(&env, &contract_id), new_admin);
}

#[test]
fn test_admin_transfer_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.admin_transfer(&new_admin);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("admin_xfr").into_val(&env),
                ]
            && data == (admin, new_admin).into_val(&env)
    });
    assert!(found, "admin_xfr event not emitted");
}

#[test]
#[should_panic]
fn test_admin_transfer_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    env.mock_all_auths();
    client.initialize(
        &vec![&env, admin, b],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // No mock auths for admin_transfer — must panic on require_auth
    client.admin_transfer(&new_admin);
}

// ── Issue #236: empty recipients guard on distribute ─────────────────────────

/// Calling distribute with an empty collaborators list must panic before transfers.
#[test]
#[should_panic(expected = "recipients list cannot be empty")]
fn test_distribute_empty_recipients_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &contract_id, 1000);

    let empty_collaborators: SorobanVec<Address> = vec![&env];
    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::Collaborators, &empty_collaborators);
    });

    client.distribute(&token);
}
