#![cfg(test)]
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env, IntoVal, Map, String, TryFromVal, Val, Vec as SorobanVec,
};
use stellar_royalty_splitter::{
    auth, ContractError, DataKey, Recipient, RoyaltySplitterClient, StorageKey, MIN_TTL, VERSION,
};

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

fn val_eq<T>(env: &Env, actual: Val, expected: T) -> bool
where
    T: TryFromVal<Env, Val> + PartialEq,
{
    T::try_from_val(env, &actual)
        .map(|value| value == expected)
        .unwrap_or(false)
}

#[test]
#[should_panic]
fn test_distribute_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);
    client.distribute(&token);
}

/// Issue #237 — distribute must reject when stored shares do not sum to 10,000.
#[test]
#[should_panic]
fn test_distribute_rejects_invalid_share_total() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 4000_u32, 3000_u32, 3000_u32],
    );
    mint(&env, &token, &contract_id, 1000);

    // Corrupt share map so totals are 60% instead of 100% (defense-in-depth path).
    // ShareMap is in persistent storage after #322 migration.
    let mut bad_map: Map<Address, u32> = Map::new(&env);
    bad_map.set(admin.clone(), 3000);
    bad_map.set(b.clone(), 3000);
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&DataKey::ShareMap, &bad_map);
    });

    client.distribute(&token);
}

#[test]
fn test_distribute_zero_balance_returns_underfunded_error() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);
    client.initialize(&vec![&env, a, b], &vec![&env, 5000_u32, 5000_u32]);
    // contract balance is 0 - must return the typed underfunded error
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::Underfunded)));
}

#[test]
#[should_panic]
fn test_royalty_rate_exceeds_max_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
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
    env.mock_all_auths_allowing_non_root_auth();
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

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

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
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    // Advance ledger sequence past MIN_TTL (17_280 ledgers).
    env.ledger()
        .with_mut(|ledger| ledger.sequence_number += MIN_TTL as u32 + 1);

    // Both read functions must still return correct data (TTL was extended).
    let collaborators = client.get_collaborators();
    assert_eq!(collaborators.len(), 2);
    assert_eq!(client.get_share(&a), 6000);
    assert_eq!(client.get_share(&b), 4000);
}

/// Issue #289 — state-writing entrypoints must extend TTL so writes succeed
/// after the ledger advances past MIN_TTL.
#[test]
fn test_ttl_state_writes_after_ledger_advance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.set_royalty_rate(&500_u32);

    env.ledger()
        .with_mut(|ledger| ledger.sequence_number += MIN_TTL as u32 + 1);

    client.set_royalty_rate(&750_u32);
    assert_eq!(client.get_royalty_rate(), 750);

    client.pause();
    assert!(client.is_paused());
    client.unpause();
    assert!(!client.is_paused());

    client.update_share(&b, &6000_u32);
    client.update_share(&admin, &4000_u32);

    mint(&env, &token, &contract_id, 1000);
    client.distribute(&token);
    assert!(client.get_last_distribution().is_some());
    assert_eq!(client.get_distribute_count(), 1);

    client.record_secondary_royalty(&token, &admin, &100_i128);
    assert_eq!(client.get_secondary_pool(), 100);
}

/// Issue #291 — snapshot the exact instance storage entries written by initialize.
#[test]
fn test_storage_snapshot_after_initialize() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 7000_u32, 3000_u32],
    );

    env.as_contract(&contract_id, || {
        // Admin and ContractVersion remain in instance storage
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("admin should be stored");
        let stored_version: String = env
            .storage()
            .instance()
            .get(&StorageKey::ContractVersion)
            .expect("contract version should be stored");
        assert_eq!(stored_admin, admin);
        assert_eq!(stored_version, String::from_str(&env, VERSION));

        // Collaborators and ShareMap are in persistent storage after #322 migration
        let stored_collaborators: SorobanVec<Address> = env
            .storage()
            .persistent()
            .get(&StorageKey::Collaborators)
            .expect("collaborators should be stored in persistent storage");
        let stored_shares: Map<Address, u32> = env
            .storage()
            .persistent()
            .get(&StorageKey::ShareMap)
            .expect("share map should be stored in persistent storage");
        assert_eq!(stored_collaborators.len(), 2);
        assert_eq!(stored_collaborators.get(0).unwrap(), admin);
        assert_eq!(stored_collaborators.get(1).unwrap(), collaborator);
        assert_eq!(stored_shares.len(), 2);
        assert_eq!(stored_shares.get(admin).unwrap(), 7000);
        assert_eq!(stored_shares.get(collaborator).unwrap(), 3000);

        assert!(!env.storage().instance().has(&StorageKey::LastDistribution));
        assert!(!env.storage().instance().has(&StorageKey::DistributeHistory));
        assert!(!env.storage().instance().has(&StorageKey::SecondaryPool));
    });
}

/// Issue #291 — snapshot the storage entries added after a successful distribute.
#[test]
fn test_storage_snapshot_after_distribute() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);
    let distribution_timestamp = 1_700_000_000_u64;

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    mint(&env, &token, &contract_id, 10_000);
    env.ledger()
        .with_mut(|ledger| ledger.timestamp = distribution_timestamp);

    client.distribute(&token);

    env.as_contract(&contract_id, || {
        // Admin remains in instance storage
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("admin should remain stored");
        assert_eq!(stored_admin, admin);

        // Collaborators and ShareMap are in persistent storage after #322 migration
        let stored_collaborators: SorobanVec<Address> = env
            .storage()
            .persistent()
            .get(&StorageKey::Collaborators)
            .expect("collaborators should remain stored in persistent storage");
        let stored_shares: Map<Address, u32> = env
            .storage()
            .persistent()
            .get(&StorageKey::ShareMap)
            .expect("share map should remain stored in persistent storage");
        assert_eq!(stored_collaborators.len(), 2);
        assert_eq!(stored_collaborators.get(0).unwrap(), admin);
        assert_eq!(stored_collaborators.get(1).unwrap(), collaborator);
        assert_eq!(stored_shares.len(), 2);
        assert_eq!(stored_shares.get(admin).unwrap(), 6000);
        assert_eq!(stored_shares.get(collaborator).unwrap(), 4000);

        // Instance storage still holds timestamps and counters
        let last_distribution: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::LastDistribution)
            .expect("last distribution timestamp should be stored");
        let distribute_count: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .expect("distribute count should be stored");
        assert_eq!(last_distribution, distribution_timestamp);
        assert_eq!(distribute_count, 1);
        assert!(!env.storage().instance().has(&StorageKey::SecondaryPool));
    });
}

/// Events — distribute emits a ("royalty", "dist_all") event with (token, amount).
#[test]
fn test_distribute_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
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
            && val_eq(&env, data, (token.clone(), amount))
    });
    assert!(found, "dist_all event not emitted");
}

/// Events — set_royalty_rate emits a ("royalty", "rate_set") event with the new rate.
#[test]
fn test_set_royalty_rate_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

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
            && val_eq(&env, data, rate)
    });
    assert!(found, "rate_set event not emitted");
}

/// Events — distribute_secondary_royalties emits a ("royalty", "sec_dist") event.
#[test]
fn test_distribute_secondary_royalties_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

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
            && val_eq(&env, data, (token.clone(), pool_amount))
    });
    assert!(found, "sec_dist event not emitted");
}

#[test]
#[should_panic]
fn test_zero_share_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    // b has a zero share — must panic
    client.initialize(&vec![&env, a, b], &vec![&env, 10000_u32, 0_u32]);
}

#[test]
fn test_collaborator_count() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
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
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
}

/// Issue #160 — pause blocks distribute.
#[test]
#[should_panic]
fn test_distribute_blocked_when_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &contract_id, 1000);

    client.pause();
    // Must panic with "contract is paused"
    client.distribute(&token);
}

/// Issue #160 — pause blocks distribute_secondary_royalties.
#[test]
#[should_panic]
fn test_distribute_secondary_blocked_when_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

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
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
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
    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    // Clear auths so the next call has no authorization
    env.mock_auths(&[]);
    client.pause();
}

// ── #224: royalty rate boundary values ──────────────────────────────────────

/// Rate of 0 is rejected; use a positive basis-point value.
#[test]
fn test_royalty_rate_boundary_zero() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let result = client.try_set_royalty_rate(&0_u32);
    assert_eq!(result, Err(Ok(ContractError::RoyaltyRateZero)));
    assert_eq!(client.get_royalty_rate(), 0);
}

/// Rate of 10,000 is valid (100% royalty).
#[test]
fn test_royalty_rate_boundary_max() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    client.set_royalty_rate(&10_000_u32);
    assert_eq!(client.get_royalty_rate(), 10_000);
}

/// Rate of 10,001 must be rejected with a typed contract error.
#[test]
fn test_royalty_rate_above_max_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let result = client.try_set_royalty_rate(&10_001_u32);
    assert_eq!(result, Err(Ok(ContractError::RoyaltyRateTooHigh)));
    assert_eq!(client.get_royalty_rate(), 0);
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
    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

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
    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

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
        self.0 = self
            .0
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
        env.mock_all_auths_allowing_non_root_auth();
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

/// Issue #281 — property-style royalty split arithmetic.
/// Randomized recipient lists (1-10), sale amounts, and royalty rates are
/// converted into a royalty pool, then distributed through the primary
/// `distribute` path. Invariant: recipient balances sum exactly to
/// `sale_amount * royalty_rate / 10_000`, so no rounding dust is lost or created.
#[test]
fn test_distribute_property_royalty_split_arithmetic() {
    let mut rng = Lcg::new(0x2810_0000_D15A_1B7E);

    for case in 0..50 {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let recipient_count = rng.range(1, 10) as u32;
        let sale_amount: i128 = rng.range(10_000, 1_000_000_000_000_000) as i128;
        let royalty_rate = rng.range(1, 10_000) as u32;
        let expected_royalty = (sale_amount * royalty_rate as i128) / 10_000;

        let mut addrs: std::vec::Vec<Address> = std::vec::Vec::new();
        for _ in 0..recipient_count {
            addrs.push(Address::generate(&env));
        }

        let mut shares: std::vec::Vec<u32> = std::vec::Vec::new();
        let mut remaining: u32 = 10_000;
        for i in 0..recipient_count {
            if i == recipient_count - 1 {
                shares.push(remaining);
            } else {
                let slots_left = (recipient_count - 1 - i) as u64;
                let max_share = (remaining - slots_left as u32) as u64;
                let share = rng.range(1, max_share) as u32;
                shares.push(share);
                remaining -= share;
            }
        }

        let mut soroban_addrs: SorobanVec<Address> = SorobanVec::new(&env);
        let mut soroban_shares: SorobanVec<u32> = SorobanVec::new(&env);
        for addr in &addrs {
            soroban_addrs.push_back(addr.clone());
        }
        for &share in &shares {
            soroban_shares.push_back(share);
        }

        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        client.initialize(&soroban_addrs, &soroban_shares);
        client.set_royalty_rate(&royalty_rate);
        assert_eq!(client.get_royalty_rate(), royalty_rate);

        mint(&env, &token, &contract_id, expected_royalty);
        client.distribute(&token);

        let mut total_paid: i128 = 0;
        for addr in &addrs {
            total_paid += TokenClient::new(&env, &token).balance(addr);
        }

        assert_eq!(
            total_paid, expected_royalty,
            "case={case} recipients={recipient_count} sale_amount={sale_amount} royalty_rate={royalty_rate}"
        );
        assert_eq!(
            TokenClient::new(&env, &token).balance(&contract_id),
            0,
            "case={case} must leave no dust in the contract"
        );
    }
}

/// Issue #252 — fuzz-style: large payment amounts that previously risked i128 overflow
/// when multiplied before dividing (now uses u128 intermediate arithmetic).
/// Tests amounts up to i128::MAX / 10_000 across varied split configurations.
#[test]
fn test_record_secondary_sale_overflow_returns_typed_error() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.set_royalty_rate(&10_000_u32);

    let result = client.try_record_secondary_sale(&i128::MAX);

    assert_eq!(result, Err(Ok(ContractError::ArithmeticOverflow)));
}

#[test]
fn test_distribute_payout_overflow_returns_typed_error_without_state_change() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);
    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 9999_u32, 1_u32],
    );
    mint(&env, &token, &contract_id, i128::MAX);

    let result = client.try_distribute(&token);

    assert_eq!(result, Err(Ok(ContractError::ArithmeticOverflow)));
    assert_eq!(
        TokenClient::new(&env, &token).balance(&contract_id),
        i128::MAX
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);
    assert_eq!(client.get_distribute_count(), 0);
    assert_eq!(client.get_last_distribution(), None);
}

#[test]
fn test_distribute_fuzz_large_amounts_no_overflow() {
    let large_amounts: [i128; 6] = [
        i128::MAX / 10_001, // just under overflow boundary
        i128::MAX / 20_000,
        1_000_000_000_000_000_000, // 10^18 stroops
        9_999_999_999_999_999,
        1,
        10_000,
    ];

    let split_configs: [(u32, u32); 4] = [(5_000, 5_000), (9_999, 1), (1, 9_999), (3_333, 6_667)];

    for amount in large_amounts {
        for (share_a, share_b) in split_configs {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
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
            assert_eq!(
                paid, amount,
                "large amount={amount} share=({share_a},{share_b})"
            );
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
        env.mock_all_auths_allowing_non_root_auth();
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
        assert_eq!(
            client.get_secondary_pool(),
            0,
            "Secondary pool must be zero after distribution"
        );
    }
}

// ── Issue #245: hard cap of 10 recipients ────────────────────────────────────

/// Issue #245 — initialize with exactly 10 recipients must succeed.
#[test]
fn test_initialize_with_10_recipients_succeeds() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
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
#[should_panic]
fn test_initialize_with_11_recipients_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
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
#[should_panic]
fn test_initialize_with_15_recipients_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
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
#[should_panic]
fn test_initialize_twice_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Second initialization attempt must panic
    let c = Address::generate(&env);
    let d = Address::generate(&env);
    client.initialize(&vec![&env, c, d], &vec![&env, 6000_u32, 4000_u32]);
}

/// Issue #234 — re-initialization attempt must not modify existing state.
#[test]
fn test_reinitialize_does_not_modify_state() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

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

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
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
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
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
            && val_eq(&env, data, (admin.clone(), new_admin.clone()))
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

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // No mock auths for admin_transfer — must panic on require_auth
    client.admin_transfer(&new_admin);
}

// ── Issue #236: empty recipients guard on distribute ─────────────────────────

/// Calling distribute with an empty collaborators list must panic before transfers.
#[test]
#[should_panic]
fn test_distribute_empty_recipients_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &contract_id, 1000);

    // Collaborators are in persistent storage after #322 migration
    let empty_collaborators: SorobanVec<Address> = vec![&env];
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Collaborators, &empty_collaborators);
    });

    client.distribute(&token);
}

// ── Default Recipients Tests ─────────────────────────────────────────────────

/// Test setting default recipients with admin authorization
#[test]
fn test_set_default_recipients_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipient1 = Recipient {
        address: admin.clone(),
        share: 6000_u32,
    };
    let recipient2 = Recipient {
        address: b.clone(),
        share: 4000_u32,
    };
    let recipients = vec![&env, recipient1, recipient2];

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_default_recipients",
            args: (recipients.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_default_recipients(&recipients);

    let defaults = client.get_default_recipients();
    assert_eq!(defaults.len(), 2);
}

/// Test that set_default_recipients rejects empty list
#[test]
#[should_panic]
fn test_set_default_recipients_empty_list_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let empty_recipients: SorobanVec<Recipient> = vec![&env];
    client.set_default_recipients(&empty_recipients);
}

/// Test that set_default_recipients rejects more than 10 recipients
#[test]
#[should_panic]
fn test_set_default_recipients_too_many_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let mut recipients: SorobanVec<Recipient> = SorobanVec::new(&env);
    for _ in 0..11 {
        recipients.push_back(Recipient {
            address: Address::generate(&env),
            share: 909_u32,
        });
    }

    client.set_default_recipients(&recipients);
}

/// Test that set_default_recipients rejects shares that don't sum to 10000
#[test]
#[should_panic]
fn test_set_default_recipients_invalid_share_sum_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipient1 = Recipient {
        address: admin,
        share: 5000_u32,
    };
    let recipient2 = Recipient {
        address: b,
        share: 4000_u32,
    };
    let recipients = vec![&env, recipient1, recipient2];

    client.set_default_recipients(&recipients);
}

/// Test that set_default_recipients rejects zero shares
#[test]
#[should_panic]
fn test_set_default_recipients_zero_share_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipient1 = Recipient {
        address: admin,
        share: 10000_u32,
    };
    let recipient2 = Recipient {
        address: b,
        share: 0_u32,
    };
    let recipients = vec![&env, recipient1, recipient2];

    client.set_default_recipients(&recipients);
}

/// Test that set_default_recipients rejects invalid basis-point values
#[test]
fn test_set_default_recipients_invalid_basis_points_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone()], &vec![&env, 10000_u32]);

    let recipient = Recipient {
        address: admin,
        share: 10_001_u32,
    };
    let recipients = vec![&env, recipient];

    let result = client.try_set_default_recipients(&recipients);
    assert_eq!(result, Err(Ok(ContractError::InvalidBasisPoints)));
}

/// Test that set_default_recipients rejects duplicate addresses
#[test]
fn test_set_default_recipients_duplicate_address_returns_typed_error() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipient1 = Recipient {
        address: admin.clone(),
        share: 5000_u32,
    };
    let recipient2 = Recipient {
        address: admin.clone(),
        share: 5000_u32,
    };
    let recipients = vec![&env, recipient1, recipient2];

    let result = client.try_set_default_recipients(&recipients);
    assert_eq!(result, Err(Ok(ContractError::DuplicateRecipient)));

    let defaults = client.get_default_recipients();
    assert_eq!(defaults.len(), 0);
}

/// Test that set_default_recipients emits an event
#[test]
fn test_set_default_recipients_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipient1 = Recipient {
        address: admin.clone(),
        share: 6000_u32,
    };
    let recipient2 = Recipient {
        address: b.clone(),
        share: 4000_u32,
    };
    let recipients = vec![&env, recipient1, recipient2];
    client.set_default_recipients(&recipients);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("default").into_val(&env),
                    symbol_short!("rcpt_set").into_val(&env),
                ]
            && val_eq(&env, data, 2_u32)
    });
    assert!(found, "rcpt_set event not emitted");
}

/// Test get_default_recipients returns empty when not set
#[test]
fn test_get_default_recipients_empty_when_not_set() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let defaults = client.get_default_recipients();
    assert_eq!(defaults.len(), 0);
}

/// Test get_default_recipients returns configured list
#[test]
fn test_get_default_recipients_returns_configured() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipient1 = Recipient {
        address: admin.clone(),
        share: 6000_u32,
    };
    let recipient2 = Recipient {
        address: b.clone(),
        share: 4000_u32,
    };
    let recipients = vec![&env, recipient1, recipient2];
    client.set_default_recipients(&recipients);

    let defaults = client.get_default_recipients();
    assert_eq!(defaults.len(), 2);
    assert_eq!(defaults.get(0).unwrap().address, admin);
    assert_eq!(defaults.get(0).unwrap().share, 6000);
    assert_eq!(defaults.get(1).unwrap().address, b);
    assert_eq!(defaults.get(1).unwrap().share, 4000);
}

// ── Distribute with Override Tests ───────────────────────────────────────────

/// Test distribute_with_override uses override recipients when provided
#[test]
fn test_distribute_with_override_uses_override() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 4000_u32, 3000_u32, 3000_u32],
    );

    let default1 = Recipient {
        address: admin.clone(),
        share: 6000_u32,
    };
    let default2 = Recipient {
        address: b.clone(),
        share: 4000_u32,
    };
    let defaults = vec![&env, default1, default2];
    client.set_default_recipients(&defaults);

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    let override1 = Recipient {
        address: c.clone(),
        share: 10000_u32,
    };
    let overrides = vec![&env, override1];
    client.distribute_with_override(&token, &overrides);

    assert_eq!(TokenClient::new(&env, &token).balance(&c), 1000);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("ovr_dist").into_val(&env),
                ]
            && val_eq(
                &env,
                data,
                (
                    stellar_royalty_splitter::EVENT_VERSION,
                    env.ledger().sequence(),
                    token.clone(),
                    amount,
                    1_u32,
                ),
            )
    });
    assert!(found, "override audit event not emitted");
}

/// Test distribute_with_override rejects override recipients that are not initialized collaborators
#[test]
fn test_distribute_with_override_rejects_unauthorized_recipients() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let outsider = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    let unauthorized_override = vec![
        &env,
        Recipient {
            address: outsider.clone(),
            share: 10000_u32,
        },
    ];

    let result = client.try_distribute_with_override(&token, &unauthorized_override);
    assert_eq!(result, Err(Ok(ContractError::CollaboratorNotFound)));
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&outsider), 0);
}

/// Test distribute_with_override rejects override recipients whose shares do not sum to 10000
#[test]
fn test_distribute_with_override_invalid_share_sum_panics_without_distribution() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 4000_u32, 3000_u32, 3000_u32],
    );

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    let bad_override_low = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 5000_u32,
        },
        Recipient {
            address: c.clone(),
            share: 4999_u32,
        },
    ];

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.distribute_with_override(&token, &bad_override_low);
    }));

    assert!(
        result.is_err(),
        "Distribution should panic when override shares sum to 9999"
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&c), 0);

    let bad_override_high = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 5000_u32,
        },
        Recipient {
            address: c.clone(),
            share: 5001_u32,
        },
    ];

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.distribute_with_override(&token, &bad_override_high);
    }));

    assert!(
        result.is_err(),
        "Distribution should panic when override shares sum to 10001"
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&c), 0);
}

/// Test distribute_with_override rejects duplicate override recipients.
#[test]
fn test_distribute_with_override_duplicate_recipients_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    let duplicate_override = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 5000_u32,
        },
        Recipient {
            address: admin.clone(),
            share: 5000_u32,
        },
    ];

    let result = client.try_distribute_with_override(&token, &duplicate_override);
    assert_eq!(result, Err(Ok(ContractError::DuplicateRecipient)));
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), amount);
}

/// Test distribute_with_override falls back to defaults when override is empty
#[test]
fn test_distribute_with_override_falls_back_to_defaults() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let default1 = Recipient {
        address: admin.clone(),
        share: 6000_u32,
    };
    let default2 = Recipient {
        address: b.clone(),
        share: 4000_u32,
    };
    let defaults = vec![&env, default1, default2];
    client.set_default_recipients(&defaults);

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    let empty_override: SorobanVec<Recipient> = vec![&env];
    client.distribute_with_override(&token, &empty_override);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 600);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 400);
}

/// Test distribute_with_override falls back to collaborators when no defaults
#[test]
fn test_distribute_with_override_falls_back_to_collaborators() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    let empty_override: SorobanVec<Recipient> = vec![&env];
    client.distribute_with_override(&token, &empty_override);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
}

/// Test distribute_with_override requires admin auth
#[test]
#[should_panic]
fn test_distribute_with_override_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    env.mock_auths(&[]);
    let empty_override: SorobanVec<Recipient> = vec![&env];
    client.distribute_with_override(&token, &empty_override);
}

/// Test distribute_with_override respects pause
#[test]
#[should_panic]
fn test_distribute_with_override_respects_pause() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    client.pause();

    let empty_override: SorobanVec<Recipient> = vec![&env];
    client.distribute_with_override(&token, &empty_override);
}

// ── Distribute History Counter Tests ────────────────────────────────────────

/// Test get_distribute_count returns 0 when no distributions
#[test]
fn test_get_distribute_count_initially_zero() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    assert_eq!(client.get_distribute_count(), 0);
}

/// Test get_distribute_count increments on distribute
#[test]
fn test_get_distribute_count_increments_on_distribute() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    assert_eq!(client.get_distribute_count(), 0);

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    assert_eq!(client.get_distribute_count(), 1);

    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    assert_eq!(client.get_distribute_count(), 2);
}

/// Test get_distribute_count increments on distribute_with_override
#[test]
fn test_get_distribute_count_increments_on_distribute_with_override() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    assert_eq!(client.get_distribute_count(), 0);

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    let empty_override: SorobanVec<Recipient> = vec![&env];
    client.distribute_with_override(&token, &empty_override);

    assert_eq!(client.get_distribute_count(), 1);
}

/// Test get_distribute_count never decrements
#[test]
fn test_get_distribute_count_never_decrements() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    let count_after_first = client.get_distribute_count();
    assert_eq!(count_after_first, 1);

    client.pause();
    client.unpause();
    client.set_royalty_rate(&250);

    assert_eq!(client.get_distribute_count(), 1);
}

/// Test distribute_history counter overflow safety (saturating arithmetic)
#[test]
fn test_distribute_history_overflow_safety() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&DataKey::DistributeHistory, &u64::MAX);
    });

    assert_eq!(client.get_distribute_count(), u64::MAX);

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    assert_eq!(client.get_distribute_count(), u64::MAX);
}

// ── Multi-Token Distribution Tests ───────────────────────────────────────────

/// Test distribution works with multiple different token types
#[test]
fn test_multi_token_distribution() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount1: i128 = 1000;
    mint(&env, &token1, &contract_id, amount1);
    client.distribute(&token1);

    assert_eq!(client.get_distribute_count(), 1);
    assert_eq!(TokenClient::new(&env, &token1).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token1).balance(&b), 500);

    let amount2: i128 = 2000;
    mint(&env, &token2, &contract_id, amount2);
    client.distribute(&token2);

    assert_eq!(client.get_distribute_count(), 2);
    assert_eq!(TokenClient::new(&env, &token2).balance(&admin), 1000);
    assert_eq!(TokenClient::new(&env, &token2).balance(&b), 1000);

    assert_eq!(TokenClient::new(&env, &token1).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token1).balance(&b), 500);
}

/// Test distribute_with_override works with multiple tokens
#[test]
fn test_multi_token_distribute_with_override() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let default1 = Recipient {
        address: admin.clone(),
        share: 6000_u32,
    };
    let default2 = Recipient {
        address: b.clone(),
        share: 4000_u32,
    };
    let defaults = vec![&env, default1, default2];
    client.set_default_recipients(&defaults);

    let amount1: i128 = 1000;
    mint(&env, &token1, &contract_id, amount1);
    let override1 = Recipient {
        address: c.clone(),
        share: 10000_u32,
    };
    let overrides = vec![&env, override1];
    client.distribute_with_override(&token1, &overrides);

    assert_eq!(TokenClient::new(&env, &token1).balance(&c), 1000);

    let amount2: i128 = 2000;
    mint(&env, &token2, &contract_id, amount2);
    let empty_override: SorobanVec<Recipient> = vec![&env];
    client.distribute_with_override(&token2, &empty_override);

    assert_eq!(TokenClient::new(&env, &token2).balance(&admin), 1200);
    assert_eq!(TokenClient::new(&env, &token2).balance(&b), 800);
}

// ── Backward Compatibility Tests ─────────────────────────────────────────────

/// Test original distribute() function still works (backward compatibility)
#[test]
fn test_backward_compatibility_original_distribute() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    client.distribute(&token);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
    assert_eq!(client.get_distribute_count(), 1);
}

/// Test existing functionality preserved after changes
#[test]
fn test_existing_functionality_preserved() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    client.pause();
    assert!(client.is_paused());
    client.unpause();
    assert!(!client.is_paused());

    client.update_share(&admin, &6000_u32);
    assert_eq!(client.get_share(&admin), 6000);
    assert_eq!(client.get_share(&b), 4000);

    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);
    assert_eq!(client.get_secondary_pool(), 500);
}

// ── Issue #266: typed storage key isolation ─────────────────────────────────

/// Issue #266 — distinct `StorageKey` variants do not share storage slots.
#[test]
fn test_storage_key_isolation() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    assert_eq!(client.get_share(&admin), 5000);
    assert_eq!(client.get_share(&b), 5000);
    assert!(!client.is_paused());

    // Overwrite Paused without touching ShareMap.
    env.as_contract(&contract_id, || {
        env.storage().instance().set(&StorageKey::Paused, &true);
    });

    assert!(client.is_paused());
    assert_eq!(client.get_share(&admin), 5000);
    assert_eq!(client.get_total_shares(), 10_000);

    // DataKey alias must match StorageKey serialization.
    env.as_contract(&contract_id, || {
        let via_alias: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RoyaltyRate)
            .unwrap_or(0);
        assert_eq!(via_alias, 0);
        env.storage()
            .instance()
            .set(&StorageKey::RoyaltyRate, &250_u32);
    });
    assert_eq!(client.get_royalty_rate(), 250);
}

// ── Issue #267: descriptive auth context ────────────────────────────────────

/// Issue #267 — auth helpers expose function-specific context strings.
#[test]
fn test_auth_message_constants_include_function_context() {
    assert!(auth::msg::INITIALIZE_ADMIN.contains("initialize"));
    assert!(auth::msg::SET_ROYALTY_RATE_ADMIN.contains("set_royalty_rate"));
    assert!(auth::msg::DISTRIBUTE_OVERRIDE_ADMIN.contains("distribute_with_override"));
    assert!(auth::msg::RECORD_SECONDARY_PAYER.contains("record_secondary_royalty"));
    assert!(auth::msg::SET_DEFAULT_RECIPIENTS_ADMIN.contains("set_default_recipients"));
    assert!(auth::msg::SET_RECIPIENTS_ADMIN.contains("set_recipients"));
    assert!(auth::msg::WITHDRAW_ADMIN.contains("withdraw"));
    assert!(auth::msg::INITIALIZE_ADMIN.contains("authorization required"));
}

/// Issue #267 — successful admin calls publish `auth_req` diagnostic context.
#[test]
fn test_auth_req_event_emitted_on_initialize() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let events = env.events().all();
    let found = events.iter().any(|(_cid, topics, _data)| {
        topics == vec![&env, symbol_short!("auth_req").into_val(&env)]
    });
    assert!(
        found,
        "auth_req event should be published before require_auth succeeds"
    );
}

// ── Issue #290: get_admin ───────────────────────────────────────────────────

#[test]
fn test_get_admin_returns_initial_admin() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    assert_eq!(client.get_admin(), admin);
}

#[test]
fn test_get_admin_reflects_admin_transfer() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    assert_eq!(client.get_admin(), admin);

    client.admin_transfer(&new_admin);
    assert_eq!(client.get_admin(), new_admin);
}

#[test]
fn test_get_admin_remains_current_during_proposed_admin_transfer() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let pending_admin = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "propose_admin_transfer",
            args: (&pending_admin,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.propose_admin_transfer(&pending_admin);

    assert_eq!(client.get_admin(), admin);
}

#[test]
fn test_get_admin_reflects_accepted_admin_transfer() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let pending_admin = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "propose_admin_transfer",
            args: (&pending_admin,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.propose_admin_transfer(&pending_admin);

    env.mock_auths(&[MockAuth {
        address: &pending_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.accept_admin();

    assert_eq!(client.get_admin(), pending_admin);
}

#[test]
fn test_get_admin_updates_after_multiple_transfers() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let intermediate_admin = Address::generate(&env);
    let final_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    assert_eq!(client.get_admin(), admin);

    client.admin_transfer(&intermediate_admin);
    assert_eq!(client.get_admin(), intermediate_admin);

    client.admin_transfer(&final_admin);
    assert_eq!(client.get_admin(), final_admin);
}

#[test]
#[should_panic]
fn test_get_admin_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    client.get_admin();
}

// ── Issue #286: contract version ────────────────────────────────────────────

#[test]
fn test_get_version_stored_on_initialize() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    assert_eq!(client.get_version(), String::from_str(&env, VERSION));
}

#[test]
#[should_panic]
fn test_get_version_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    client.get_version();
}

// ── Issue #287: update_wasm ─────────────────────────────────────────────────

const CONTRACT_WASM: &[u8] =
    include_bytes!("../target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm");

fn upload_contract_wasm(env: &Env) -> BytesN<32> {
    env.deployer().upload_contract_wasm(CONTRACT_WASM)
}

#[test]
fn test_update_wasm_preserves_state() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );
    client.pause();

    let wasm_hash = upload_contract_wasm(&env);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "update_wasm",
            args: (wasm_hash.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.update_wasm(&wasm_hash);

    assert_eq!(read_admin(&env, &contract_id), admin);
    assert_eq!(client.get_share(&admin), 6000);
    assert_eq!(client.get_share(&b), 4000);
    assert_eq!(client.get_version(), String::from_str(&env, VERSION));
    assert!(client.is_paused());

    mint(&env, &token, &contract_id, 1000);
    env.mock_all_auths_allowing_non_root_auth();
    client.distribute(&token);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 600);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 400);
}

#[test]
#[should_panic]
fn test_update_wasm_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let wasm_hash = upload_contract_wasm(&env);

    // No mock auths for update_wasm — must panic on require_auth
    client.update_wasm(&wasm_hash);
}

#[test]
#[should_panic]
fn test_update_wasm_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let wasm_hash = upload_contract_wasm(&env);
    client.update_wasm(&wasm_hash);
}

// ── Issue #288: set_recipients ──────────────────────────────────────────────

#[test]
fn test_set_recipients_updates_primary_list() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipients = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 7000_u32,
        },
        Recipient {
            address: c.clone(),
            share: 3000_u32,
        },
    ];
    client.set_recipients(&recipients);

    let stored = client.get_recipients();
    assert_eq!(stored.len(), 2);
    assert_eq!(stored.get(0).unwrap().address, admin);
    assert_eq!(stored.get(0).unwrap().share, 7000);
    assert_eq!(stored.get(1).unwrap().address, c);
    assert_eq!(stored.get(1).unwrap().share, 3000);
    assert_eq!(client.get_share(&c), 3000);
}

#[test]
fn test_set_recipients_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipients = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 7000_u32,
        },
        Recipient {
            address: c.clone(),
            share: 3000_u32,
        },
    ];

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_recipients",
            args: (recipients.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_recipients(&recipients);
}

#[test]
fn test_set_recipients_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipients = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 6000_u32,
        },
        Recipient {
            address: b.clone(),
            share: 4000_u32,
        },
    ];
    client.set_recipients(&recipients);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("recip_set").into_val(&env),
                ]
            && val_eq(&env, data, 2_u32)
    });
    assert!(found, "recip_set event not emitted");
}

#[test]
#[should_panic]
fn test_set_recipients_unauthorized_caller() {
    let env = Env::default();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let recipients = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 6000_u32,
        },
        Recipient {
            address: b.clone(),
            share: 4000_u32,
        },
    ];

    env.mock_auths(&[]);
    client.set_recipients(&recipients);
}

// ── Issue #292: withdraw ────────────────────────────────────────────────────

#[test]
fn test_withdraw_transfers_to_admin() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 750;
    mint(&env, &token, &contract_id, amount);
    client.withdraw(&token, &amount);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
}

#[test]
fn test_withdraw_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 500;
    mint(&env, &token, &contract_id, amount);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "withdraw",
            args: (&token, amount).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.withdraw(&token, &amount);
}

#[test]
fn test_withdraw_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 250;
    mint(&env, &token, &contract_id, amount);
    client.withdraw(&token, &amount);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("withdraw").into_val(&env),
                ]
            && val_eq(&env, data, (token.clone(), amount))
    });
    assert!(found, "withdraw event not emitted");
}

#[test]
#[should_panic]
fn test_withdraw_insufficient_balance_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.withdraw(&token, &100_i128);
}

#[test]
#[should_panic]
fn test_withdraw_unauthorized_caller() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &contract_id, 100);

    env.mock_auths(&[]);
    client.withdraw(&token, &50_i128);
}

// ── Issue #223: zero-balance distribute returns clean error ──────────────────

/// Issue #223 - distribute called with zero contract balance must return a
/// typed error before mutating distribution state.
#[test]
fn test_distribute_zero_balance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Confirm contract balance is zero before calling distribute
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
    assert_eq!(client.get_distribute_count(), 0);
    assert_eq!(client.get_last_distribution(), None);

    // Confirm collaborator balances are zero before the call
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);

    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::Underfunded)));

    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);
    assert_eq!(client.get_distribute_count(), 0);
    assert_eq!(client.get_last_distribution(), None);
}

// ── Issue #322: Persistent storage migration ─────────────────────────────────

#[test]
fn test_collaborators_in_persistent_storage() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.as_contract(&contract_id, || {
        let collaborators: SorobanVec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Collaborators)
            .expect("collaborators must be in persistent storage");
        assert_eq!(collaborators.len(), 2);
        // Must NOT be in instance storage
        assert!(!env.storage().instance().has(&DataKey::Collaborators));
    });
}

#[test]
fn test_share_map_in_persistent_storage() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    env.as_contract(&contract_id, || {
        let share_map: Map<Address, u32> = env
            .storage()
            .persistent()
            .get(&DataKey::ShareMap)
            .expect("share map must be in persistent storage");
        assert_eq!(share_map.get(a).unwrap(), 6000);
        assert_eq!(share_map.get(b).unwrap(), 4000);
        // Must NOT be in instance storage
        assert!(!env.storage().instance().has(&DataKey::ShareMap));
    });
}

#[test]
fn test_default_recipients_in_persistent_storage() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let r1 = Recipient {
        address: a.clone(),
        share: 7000_u32,
    };
    let r2 = Recipient {
        address: b.clone(),
        share: 3000_u32,
    };
    client.set_default_recipients(&vec![&env, r1, r2]);

    env.as_contract(&contract_id, || {
        let defaults: SorobanVec<Recipient> = env
            .storage()
            .persistent()
            .get(&DataKey::DefaultRecipients)
            .expect("default recipients must be in persistent storage");
        assert_eq!(defaults.len(), 2);
        // Must NOT be in instance storage
        assert!(!env.storage().instance().has(&DataKey::DefaultRecipients));
    });
}

// ── Issue #320: Two-step admin transfer ──────────────────────────────────────

#[test]
fn test_propose_admin_does_not_change_admin_immediately() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.propose_admin_transfer(&new_admin);

    // Admin must still be original — transfer not complete until accept_admin
    assert_eq!(client.get_admin(), admin);
}

#[test]
fn test_accept_admin_completes_transfer() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.propose_admin_transfer(&new_admin);
    client.accept_admin();

    assert_eq!(client.get_admin(), new_admin);
}

#[test]
fn test_accept_admin_without_proposal_returns_error() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // No pending admin transfer has been proposed — must return an error
    let result = client.try_accept_admin();
    assert!(
        result.is_err(),
        "accept_admin without a pending proposal must error"
    );
}

#[test]
fn test_accept_admin_requires_pending_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.propose_admin_transfer(&new_admin);

    // Only the pending admin (new_admin) must sign accept_admin
    env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.accept_admin();
    assert_eq!(client.get_admin(), new_admin);
}

#[test]
fn test_propose_admin_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.propose_admin_transfer(&new_admin);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("adm_prop").into_val(&env),
                ]
            && val_eq(&env, data, new_admin.clone())
    });
    assert!(found, "adm_prop event not emitted");
}

#[test]
fn test_accept_admin_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.propose_admin_transfer(&new_admin);
    client.accept_admin();

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("adm_acc").into_val(&env),
                ]
            && val_eq(&env, data, (admin.clone(), new_admin.clone()))
    });
    assert!(found, "adm_acc event not emitted");
}

#[test]
fn test_admin_transfer_blocked_when_multisig_active() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.set_admins(&vec![&env, admin.clone(), b.clone()], &2);

    // admin_transfer must be blocked when multi-sig is active
    let result = client.try_admin_transfer(&new_admin);
    assert!(
        result.is_err(),
        "admin_transfer must error when multi-sig is active"
    );
    // Admin unchanged
    assert_eq!(client.get_admin(), admin);
}

// ── Issue #321: Multi-sig admin support ──────────────────────────────────────

#[test]
fn test_set_admins_stores_list() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.set_admins(&vec![&env, admin.clone(), b.clone(), c.clone()], &2);

    let admins = client.get_admins();
    assert_eq!(admins.len(), 3);
    assert_eq!(admins.get(0).unwrap(), admin);
    assert_eq!(admins.get(1).unwrap(), b);
    assert_eq!(admins.get(2).unwrap(), c);
}

#[test]
fn test_get_admins_returns_empty_before_set() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    assert_eq!(client.get_admins().len(), 0);
}

#[test]
fn test_multisig_sensitive_function_requires_threshold_auths() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    // Set 2-of-2 multi-sig
    client.set_admins(&vec![&env, admin.clone(), b.clone()], &2);

    mint(&env, &token, &contract_id, 1000);

    // Both admins must sign — provide both auth entries for the `distribute` entrypoint
    env.mock_auths(&[
        MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "distribute",
                args: (&token,).into_val(&env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &b,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "distribute",
                args: (&token,).into_val(&env),
                sub_invokes: &[],
            },
        },
    ]);
    client.distribute(&token);

    // Verify distribution happened
    let admin_bal = TokenClient::new(&env, &token).balance(&admin);
    let b_bal = TokenClient::new(&env, &token).balance(&b);
    assert_eq!(admin_bal + b_bal, 1000);
}

#[test]
fn test_multisig_fails_with_fewer_than_threshold_auths() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    // Set 2-of-2 multi-sig
    client.set_admins(&vec![&env, admin.clone(), b.clone()], &2);

    mint(&env, &token, &contract_id, 1000);

    // Only provide one auth when two are required — must fail
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "distribute",
            args: (&token,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_distribute(&token);
    assert!(
        result.is_err(),
        "distribute must fail with only 1 of 2 required auths"
    );
}

#[test]
fn test_set_admins_requires_current_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let intruder = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Provide auth for intruder only (not admin) — must fail authorization
    env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_admins",
            args: (vec![&env, intruder.clone()], 1_u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_set_admins(&vec![&env, intruder.clone()], &1);
    assert!(
        result.is_err(),
        "set_admins must require current admin auth"
    );
}

#[test]
fn test_set_admins_rejects_zero_threshold() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let result = client.try_set_admins(&vec![&env, admin.clone()], &0);
    assert!(result.is_err(), "threshold of 0 must be rejected");
}

#[test]
fn test_set_admins_rejects_threshold_exceeds_list() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // threshold=3 but only 2 admins in list — must be rejected
    let result = client.try_set_admins(&vec![&env, admin.clone(), b.clone()], &3);
    assert!(
        result.is_err(),
        "threshold exceeding admin count must be rejected"
    );
}

#[test]
fn test_set_admins_rejects_empty_list() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let result = client.try_set_admins(&vec![&env], &1);
    assert!(result.is_err(), "empty admin list must be rejected");
}

// ── Issue #323: set_royalty_rate history log ──────────────────────────────────

#[test]
fn test_rate_history_empty_before_first_change() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    assert_eq!(client.get_royalty_rate_history().len(), 0);
}

#[test]
fn test_rate_history_records_entry_on_set() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.ledger().with_mut(|l| l.timestamp = 1_000_000);
    client.set_royalty_rate(&500_u32);

    let history = client.get_royalty_rate_history();
    assert_eq!(history.len(), 1);

    let entry = history.get(0).unwrap();
    assert_eq!(entry.old_rate, 0);
    assert_eq!(entry.new_rate, 500);
    assert_eq!(entry.timestamp, 1_000_000);
    assert_eq!(entry.caller, admin);
}

#[test]
fn test_rate_history_records_consecutive_changes() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.ledger().with_mut(|l| l.timestamp = 100);
    client.set_royalty_rate(&200_u32);

    env.ledger().with_mut(|l| l.timestamp = 200);
    client.set_royalty_rate(&400_u32);

    env.ledger().with_mut(|l| l.timestamp = 300);
    client.set_royalty_rate(&600_u32);

    let history = client.get_royalty_rate_history();
    assert_eq!(history.len(), 3);

    let e0 = history.get(0).unwrap();
    assert_eq!(e0.old_rate, 0);
    assert_eq!(e0.new_rate, 200);
    assert_eq!(e0.timestamp, 100);

    let e1 = history.get(1).unwrap();
    assert_eq!(e1.old_rate, 200);
    assert_eq!(e1.new_rate, 400);
    assert_eq!(e1.timestamp, 200);

    let e2 = history.get(2).unwrap();
    assert_eq!(e2.old_rate, 400);
    assert_eq!(e2.new_rate, 600);
    assert_eq!(e2.timestamp, 300);
}

#[test]
fn test_rate_history_capped_at_limit() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Write CAP + 3 entries — history must never exceed RATE_HISTORY_CAP
    let total = RATE_HISTORY_CAP + 3;
    for i in 1..=total {
        // Alternate between two valid rates so old_rate != new_rate every call
        let rate = if i % 2 == 0 { 100_u32 } else { 200_u32 };
        env.ledger().with_mut(|l| l.timestamp = i as u64 * 10);
        client.set_royalty_rate(&rate);
    }

    let history = client.get_royalty_rate_history();
    assert_eq!(
        history.len(),
        RATE_HISTORY_CAP,
        "history must be capped at RATE_HISTORY_CAP"
    );

    // Oldest entry dropped — first remaining entry should reflect change (total - CAP + 1)
    let first = history.get(0).unwrap();
    let expected_ts = (total - RATE_HISTORY_CAP + 1) as u64 * 10;
    assert_eq!(
        first.timestamp, expected_ts,
        "oldest entry should have been evicted"
    );
}

#[test]
fn test_rate_history_in_persistent_storage() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.set_royalty_rate(&300_u32);

    env.as_contract(&contract_id, || {
        let h: SorobanVec<RoyaltyRateChange> = env
            .storage()
            .persistent()
            .get(&DataKey::RoyaltyRateHistory)
            .expect("history must be in persistent storage");
        assert_eq!(h.len(), 1);
        // Must NOT be in instance storage
        assert!(!env.storage().instance().has(&DataKey::RoyaltyRateHistory));
    });
}

// ── Pause/Unpause Flow Tests ────────────────────────────────────────────────

/// Test that pause() sets the paused state correctly.
#[test]
fn test_pause_sets_paused_state() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Initially not paused
    assert!(!client.is_paused());

    // Pause the contract
    client.pause();

    // Verify paused state
    assert!(client.is_paused());
}

/// Test that unpause() clears the paused state correctly.
#[test]
fn test_unpause_clears_paused_state() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Pause first
    client.pause();
    assert!(client.is_paused());

    // Unpause the contract
    client.unpause();

    // Verify unpaused state
    assert!(!client.is_paused());
}

/// Test that distribute() fails with ContractPaused error when paused.
#[test]
fn test_distribute_fails_with_error_when_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &contract_id, 1000);

    // Pause the contract
    client.pause();

    // Verify distribute fails with the correct error
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

/// Test that distribute() succeeds after unpause.
#[test]
fn test_distribute_succeeds_after_unpause_with_balances() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &contract_id, 1000);

    // Pause and verify distribute fails
    client.pause();
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));

    // Unpause
    client.unpause();
    assert!(!client.is_paused());

    // Distribute should now succeed
    client.distribute(&token);

    // Verify balances were distributed correctly
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
}

/// Test that only admin can call pause().
#[test]
fn test_pause_requires_admin_authorization() {
    let env = Env::default();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    // Initialize with mock_all_auths
    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Clear auths and try to pause without authorization
    env.mock_auths(&[]);

    // Should panic due to missing authorization
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.pause();
    }));
    assert!(result.is_err(), "pause() should panic without admin auth");
}

/// Test that only admin can call unpause().
#[test]
fn test_unpause_requires_admin_authorization() {
    let env = Env::default();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    // Initialize and pause with mock_all_auths
    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.pause();

    // Clear auths and try to unpause without authorization
    env.mock_auths(&[]);

    // Should panic due to missing authorization
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.unpause();
    }));
    assert!(result.is_err(), "unpause() should panic without admin auth");
}

/// Test that pause() requires specific admin auth (not just any auth).
#[test]
fn test_pause_requires_specific_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Use specific mock auth for admin
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.pause();
    assert!(client.is_paused());
}

/// Test that unpause() requires specific admin auth (not just any auth).
#[test]
fn test_unpause_requires_specific_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.pause();

    // Use specific mock auth for admin
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "unpause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.unpause();
    assert!(!client.is_paused());
}

/// Test that distribute_secondary_royalties() fails with ContractPaused error when paused.
#[test]
fn test_distribute_secondary_fails_with_error_when_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Record some secondary royalties
    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);

    // Pause the contract
    client.pause();

    // Verify distribute_secondary_royalties fails with the correct error
    let result = client.try_distribute_secondary_royalties();
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

/// Test that distribute_secondary_royalties() succeeds after unpause.
#[test]
fn test_distribute_secondary_succeeds_after_unpause() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Record some secondary royalties
    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);

    // Pause and verify distribute_secondary_royalties fails
    client.pause();
    let result = client.try_distribute_secondary_royalties();
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));

    // Unpause
    client.unpause();
    assert!(!client.is_paused());

    // Distribute secondary royalties should now succeed
    client.distribute_secondary_royalties();

    // Verify balances were distributed correctly
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 250);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 250);
    assert_eq!(client.get_secondary_pool(), 0);
}

/// Test multiple pause/unpause cycles work correctly.
#[test]
fn test_multiple_pause_unpause_cycles() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Cycle 1: pause -> unpause
    client.pause();
    assert!(client.is_paused());
    client.unpause();
    assert!(!client.is_paused());

    // Distribute should work
    mint(&env, &token, &contract_id, 1000);
    client.distribute(&token);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);

    // Cycle 2: pause -> unpause
    client.pause();
    assert!(client.is_paused());
    client.unpause();
    assert!(!client.is_paused());

    // Distribute should work again
    mint(&env, &token, &contract_id, 2000);
    client.distribute(&token);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 1500);
}

/// Test that paused state persists across multiple operations.
#[test]
fn test_paused_state_persists() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Pause the contract
    client.pause();
    assert!(client.is_paused());

    // Perform other operations (that don't require unpaused state)
    client.set_royalty_rate(&500_u32);
    assert_eq!(client.get_royalty_rate(), 500);

    // Paused state should still be true
    assert!(client.is_paused());

    // Distribute should still fail
    mint(&env, &token, &contract_id, 1000);
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

/// Test that read-only operations work when paused.
#[test]
fn test_read_operations_work_when_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );
    client.set_royalty_rate(&250_u32);

    // Pause the contract
    client.pause();
    assert!(client.is_paused());

    // All read operations should still work
    assert!(client.is_initialized());
    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_royalty_rate(), 250);
    assert_eq!(client.collaborator_count(), 2);
    assert_eq!(client.get_share(&admin), 6000);
    assert_eq!(client.get_share(&b), 4000);
    assert!(client.is_collaborator(&admin));
    assert_eq!(client.get_total_shares(), 10_000);

    let recipients = client.get_recipients();
    assert_eq!(recipients.len(), 2);
}

// ── Emergency Pause Mechanism Tests (Issue #406) ───────────────────────────────

/// Test that any collaborator can call `pause_emergency`.
#[test]
fn test_collaborator_can_emergency_pause() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator1 = Address::generate(&env);
    let collaborator2 = Address::generate(&env);

    client.initialize(
        &vec![
            &env,
            admin.clone(),
            collaborator1.clone(),
            collaborator2.clone(),
        ],
        &vec![&env, 4000_u32, 3000_u32, 3000_u32],
    );

    env.mock_auths(&[MockAuth {
        address: &collaborator1,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause_emergency",
            args: (&collaborator1,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause_emergency(&collaborator1);
    assert!(client.is_paused());
}

/// Test that emergency pause tracks timestamp and source and emits an event.
#[test]
fn test_emergency_pause_tracks_metadata() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let pause_time = env.ledger().timestamp();

    env.mock_auths(&[MockAuth {
        address: &collaborator,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause_emergency",
            args: (&collaborator,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause_emergency(&collaborator);

    let (timestamp, source, remaining) = client.get_pause_info();
    assert_eq!(timestamp, pause_time);
    assert_eq!(source, collaborator);
    assert!(remaining > 0);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("pause_emergency").into_val(&env),
                ]
            && val_eq(
                &env,
                data,
                (
                    stellar_royalty_splitter::EVENT_VERSION,
                    env.ledger().sequence(),
                    collaborator.clone(),
                    pause_time,
                ),
            )
    });
    assert!(found, "pause_emergency event not emitted");
}

/// Test that emergency pause auto-expires after 48 hours.
#[test]
fn test_emergency_pause_auto_expires() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.mock_auths(&[MockAuth {
        address: &collaborator,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause_emergency",
            args: (&collaborator,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause_emergency(&collaborator);
    assert!(client.is_paused());

    mint(&env, &token, &contract_id, 1000);
    env.ledger().with_mut(|ledger| {
        ledger.sequence_number += 1;
        ledger.timestamp += stellar_royalty_splitter::EMERGENCY_PAUSE_DURATION + 1;
    });

    assert!(!client.is_paused(), "emergency pause should auto-expire");
    let (timestamp, source, remaining) = client.get_pause_info();
    assert_eq!(timestamp, 0);
    assert_eq!(remaining, 0);
    assert_eq!(
        source,
        Address::from_string(
            &env,
            &String::from_str(&env, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        )
        .unwrap()
    );

    client.distribute(&token);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&collaborator), 500);
}

/// Test that emergency pause cannot be called when already paused.
#[test]
fn test_cannot_emergency_pause_when_already_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator1 = Address::generate(&env);
    let collaborator2 = Address::generate(&env);

    client.initialize(
        &vec![
            &env,
            admin.clone(),
            collaborator1.clone(),
            collaborator2.clone(),
        ],
        &vec![&env, 4000_u32, 3000_u32, 3000_u32],
    );

    env.mock_auths(&[MockAuth {
        address: &collaborator1,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause_emergency",
            args: (&collaborator1,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause_emergency(&collaborator1);
    assert!(client.is_paused());

    env.mock_auths(&[MockAuth {
        address: &collaborator2,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause_emergency",
            args: (&collaborator2,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.pause_emergency(&collaborator2);
    }));
    assert!(
        result.is_err(),
        "second emergency pause should fail while paused"
    );
}

/// Test that admin pause also tracks metadata for consistency.
#[test]
fn test_admin_pause_tracks_metadata() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let pause_time = env.ledger().timestamp();
    client.pause();

    let (timestamp, source, remaining) = client.get_pause_info();
    assert_eq!(timestamp, pause_time);
    assert_eq!(source, admin); // Admin is the source
    assert_eq!(remaining, 0); // Admin pause doesn't auto-expire
}

/// Test that get_pause_info returns zeros when not paused.
#[test]
fn test_get_pause_info_when_not_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let (timestamp, source, remaining) = client.get_pause_info();
    assert_eq!(timestamp, 0);
    assert_eq!(remaining, 0);
}

/// Test that unpause clears pause metadata.
#[test]
fn test_unpause_clears_pause_metadata() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    client.pause();
    assert!(client.is_paused());

    client.unpause();
    assert!(!client.is_paused());

    let (timestamp, source, remaining) = client.get_pause_info();
    assert_eq!(timestamp, 0);
    assert_eq!(remaining, 0);
}

// ── Batch Distribute Tests ──────────────────────────────────────────────────

/// Test that unpause requires a 3-of-5 admin quorum when emergency pause is active.
#[test]
fn test_emergency_unpause_requires_three_of_five_admin_auths() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let admin4 = Address::generate(&env);
    let admin5 = Address::generate(&env);
    let collaborator = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![
            &env,
            admin.clone(),
            collaborator.clone(),
            admin2.clone(),
            admin3.clone(),
            admin4.clone(),
            admin5.clone(),
        ],
        &vec![
            &env, 2000_u32, 2000_u32, 2000_u32, 2000_u32, 1000_u32, 1000_u32,
        ],
    );
    client.set_admins(
        &vec![
            &env,
            admin.clone(),
            admin2.clone(),
            admin3.clone(),
            admin4.clone(),
            admin5.clone(),
        ],
        &3,
    );

    env.mock_auths(&[MockAuth {
        address: &collaborator,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause_emergency",
            args: (&collaborator,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause_emergency(&collaborator);
    assert!(client.is_paused());

    env.mock_auths(&[
        MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "unpause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &admin2,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "unpause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &admin3,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "unpause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        },
    ]);
    client.unpause();
    assert!(!client.is_paused());
}

/// Test that emergency unpause rejects fewer than three admin signatures.
#[test]
fn test_emergency_unpause_rejects_below_threshold() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let admin4 = Address::generate(&env);
    let admin5 = Address::generate(&env);
    let collaborator = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![
            &env,
            admin.clone(),
            collaborator.clone(),
            admin2.clone(),
            admin3.clone(),
            admin4.clone(),
            admin5.clone(),
        ],
        &vec![
            &env, 2000_u32, 2000_u32, 2000_u32, 2000_u32, 1000_u32, 1000_u32,
        ],
    );
    client.set_admins(
        &vec![
            &env,
            admin.clone(),
            admin2.clone(),
            admin3.clone(),
            admin4.clone(),
            admin5.clone(),
        ],
        &3,
    );

    env.mock_auths(&[MockAuth {
        address: &collaborator,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause_emergency",
            args: (&collaborator,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause_emergency(&collaborator);
    assert!(client.is_paused());

    env.mock_auths(&[
        MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "unpause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &admin2,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "unpause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        },
    ]);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.unpause();
    }));
    assert!(
        result.is_err(),
        "unpause should reject below-threshold admin auths"
    );
}

/// Test that concurrent emergency pause attempts only let the first one win.
#[test]
fn test_concurrent_emergency_pause_attempts() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator1 = Address::generate(&env);
    let collaborator2 = Address::generate(&env);

    client.initialize(
        &vec![
            &env,
            admin.clone(),
            collaborator1.clone(),
            collaborator2.clone(),
        ],
        &vec![&env, 4000_u32, 3000_u32, 3000_u32],
    );

    env.mock_auths(&[MockAuth {
        address: &collaborator1,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause_emergency",
            args: (&collaborator1,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause_emergency(&collaborator1);
    assert!(client.is_paused());

    env.mock_auths(&[MockAuth {
        address: &collaborator2,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause_emergency",
            args: (&collaborator2,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.pause_emergency(&collaborator2);
    }));
    assert!(
        result.is_err(),
        "second emergency pause attempt should fail"
    );
}

/// Test that batch_distribute processes multiple tokens in one call.
#[test]
fn test_batch_distribute_multiple_tokens() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    // Create three different tokens
    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);
    let token3 = make_token(&env, &token_admin);

    // Mint different amounts to the contract for each token
    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 2000);
    mint(&env, &token3, &contract_id, 3000);

    // Batch distribute all three tokens
    client.batch_distribute(&vec![&env, token1.clone(), token2.clone(), token3.clone()]);

    // Verify token1 distribution (1000 total: 600 + 400)
    assert_eq!(TokenClient::new(&env, &token1).balance(&admin), 600);
    assert_eq!(TokenClient::new(&env, &token1).balance(&b), 400);

    // Verify token2 distribution (2000 total: 1200 + 800)
    assert_eq!(TokenClient::new(&env, &token2).balance(&admin), 1200);
    assert_eq!(TokenClient::new(&env, &token2).balance(&b), 800);

    // Verify token3 distribution (3000 total: 1800 + 1200)
    assert_eq!(TokenClient::new(&env, &token3).balance(&admin), 1800);
    assert_eq!(TokenClient::new(&env, &token3).balance(&b), 1200);

    // Verify distribute count incremented by 3
    assert_eq!(client.get_distribute_count(), 3);
}

/// Test that batch_distribute emits events for each token.
#[test]
fn test_batch_distribute_emits_events() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 2000);

    client.batch_distribute(&vec![&env, token1.clone(), token2.clone()]);

    let events = env.events().all();

    // Check for dist_all events for both tokens
    let token1_event = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("dist_all").into_val(&env),
                ]
            && val_eq(&env, data, (token1.clone(), 1000_i128))
    });
    assert!(token1_event, "token1 dist_all event not emitted");

    let token2_event = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("dist_all").into_val(&env),
                ]
            && val_eq(&env, data, (token2.clone(), 2000_i128))
    });
    assert!(token2_event, "token2 dist_all event not emitted");

    // Check for batch completion event
    let batch_event = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("batch").into_val(&env),
                ]
            && val_eq(&env, data, 2_u32)
    });
    assert!(batch_event, "batch completion event not emitted");
}

/// Test that batch_distribute requires admin authorization.
#[test]
fn test_batch_distribute_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    mint(&env, &token1, &contract_id, 1000);

    // Use specific mock auth for admin
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "batch_distribute",
            args: (vec![&env, token1.clone()],).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.batch_distribute(&vec![&env, token1]);
    assert_eq!(client.get_distribute_count(), 1);
}

/// Test that batch_distribute fails when paused.
#[test]
fn test_batch_distribute_fails_when_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    mint(&env, &token1, &contract_id, 1000);

    client.pause();

    let result = client.try_batch_distribute(&vec![&env, token1]);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

/// Test that batch_distribute succeeds after unpause.
#[test]
fn test_batch_distribute_succeeds_after_unpause() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);
    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 2000);

    client.pause();
    client.unpause();

    client.batch_distribute(&vec![&env, token1.clone(), token2.clone()]);

    assert_eq!(TokenClient::new(&env, &token1).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token2).balance(&admin), 1000);
}

/// Test that batch_distribute with single token works correctly.
#[test]
fn test_batch_distribute_single_token() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 7000_u32, 3000_u32],
    );

    let token = make_token(&env, &token_admin);
    mint(&env, &token, &contract_id, 10_000);

    client.batch_distribute(&vec![&env, token.clone()]);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 7000);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 3000);
    assert_eq!(client.get_distribute_count(), 1);
}

/// Test that batch_distribute fails if any token has zero balance.
#[test]
fn test_batch_distribute_fails_on_zero_balance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 1000);
    // token2 has zero balance

    let result = client.try_batch_distribute(&vec![&env, token1, token2]);
    assert_eq!(result, Err(Ok(ContractError::NoBalance)));
}

/// Test that batch_distribute handles dust correctly for each token.
#[test]
fn test_batch_distribute_handles_dust_correctly() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // Three recipients with shares that create dust
    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 3333_u32, 3333_u32, 3334_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 10_000);
    mint(&env, &token2, &contract_id, 20_000);

    client.batch_distribute(&vec![&env, token1.clone(), token2.clone()]);

    // Verify token1 distribution (10,000 total)
    let admin_bal1 = TokenClient::new(&env, &token1).balance(&admin);
    let b_bal1 = TokenClient::new(&env, &token1).balance(&b);
    let c_bal1 = TokenClient::new(&env, &token1).balance(&c);
    assert_eq!(admin_bal1 + b_bal1 + c_bal1, 10_000);

    // Verify token2 distribution (20,000 total)
    let admin_bal2 = TokenClient::new(&env, &token2).balance(&admin);
    let b_bal2 = TokenClient::new(&env, &token2).balance(&b);
    let c_bal2 = TokenClient::new(&env, &token2).balance(&c);
    assert_eq!(admin_bal2 + b_bal2 + c_bal2, 20_000);
}

/// Test that batch_distribute works with default recipients.
#[test]
fn test_batch_distribute_with_default_recipients() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Set custom default recipients
    let custom_recipients = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 2000,
        },
        Recipient {
            address: b.clone(),
            share: 3000,
        },
        Recipient {
            address: c.clone(),
            share: 5000,
        },
    ];
    client.set_default_recipients(&custom_recipients);

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 10_000);
    mint(&env, &token2, &contract_id, 5_000);

    client.batch_distribute(&vec![&env, token1.clone(), token2.clone()]);

    // Verify token1 distribution with custom shares
    assert_eq!(TokenClient::new(&env, &token1).balance(&admin), 2000);
    assert_eq!(TokenClient::new(&env, &token1).balance(&b), 3000);
    assert_eq!(TokenClient::new(&env, &token1).balance(&c), 5000);

    // Verify token2 distribution with custom shares
    assert_eq!(TokenClient::new(&env, &token2).balance(&admin), 1000);
    assert_eq!(TokenClient::new(&env, &token2).balance(&b), 1500);
    assert_eq!(TokenClient::new(&env, &token2).balance(&c), 2500);
}

/// Test that batch_distribute with many tokens increments counter correctly.
#[test]
fn test_batch_distribute_counter_increment() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Create 5 tokens
    let mut tokens: SorobanVec<Address> = SorobanVec::new(&env);
    for _ in 0..5 {
        let token = make_token(&env, &token_admin);
        mint(&env, &token, &contract_id, 1000);
        tokens.push_back(token);
    }

    assert_eq!(client.get_distribute_count(), 0);

    client.batch_distribute(&tokens);

    // Counter should increment by 5
    assert_eq!(client.get_distribute_count(), 5);
}

/// Test that batch_distribute updates last distribution timestamp.
#[test]
fn test_batch_distribute_updates_timestamp() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 2000);

    let timestamp = 1_700_000_000_u64;
    env.ledger().with_mut(|ledger| ledger.timestamp = timestamp);

    assert!(client.get_last_distribution().is_none());

    client.batch_distribute(&vec![&env, token1, token2]);

    assert_eq!(client.get_last_distribution(), Some(timestamp));
}

/// Test that batch_distribute fails if amount is too small for any token.
#[test]
fn test_batch_distribute_fails_on_amount_too_small() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 1); // Only 1 stroop, but 2 recipients

    let result = client.try_batch_distribute(&vec![&env, token1, token2]);
    assert_eq!(result, Err(Ok(ContractError::AmountTooSmall)));
}

/// Test batch_distribute with large number of tokens.
#[test]
fn test_batch_distribute_large_batch() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Create 10 tokens
    let mut tokens: SorobanVec<Address> = SorobanVec::new(&env);
    for i in 0..10 {
        let token = make_token(&env, &token_admin);
        mint(&env, &token, &contract_id, (i + 1) * 1000);
        tokens.push_back(token);
    }

    client.batch_distribute(&tokens);

    // Verify all distributions occurred
    assert_eq!(client.get_distribute_count(), 10);

    // Verify balances for a few tokens
    let token0 = tokens.get(0).unwrap();
    assert_eq!(TokenClient::new(&env, &token0).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token0).balance(&b), 500);

    let token9 = tokens.get(9).unwrap();
    assert_eq!(TokenClient::new(&env, &token9).balance(&admin), 5000);
    assert_eq!(TokenClient::new(&env, &token9).balance(&b), 5000);
}

// ── Batch Distribute Tests ──────────────────────────────────────────────────

/// Test that batch_distribute processes multiple tokens in one call.
#[test]
fn test_batch_distribute_multiple_tokens() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    // Create three different tokens
    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);
    let token3 = make_token(&env, &token_admin);

    // Mint different amounts to the contract for each token
    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 2000);
    mint(&env, &token3, &contract_id, 3000);

    // Batch distribute all three tokens
    client.batch_distribute(&vec![&env, token1.clone(), token2.clone(), token3.clone()]);

    // Verify token1 distribution (1000 total: 600 + 400)
    assert_eq!(TokenClient::new(&env, &token1).balance(&admin), 600);
    assert_eq!(TokenClient::new(&env, &token1).balance(&b), 400);

    // Verify token2 distribution (2000 total: 1200 + 800)
    assert_eq!(TokenClient::new(&env, &token2).balance(&admin), 1200);
    assert_eq!(TokenClient::new(&env, &token2).balance(&b), 800);

    // Verify token3 distribution (3000 total: 1800 + 1200)
    assert_eq!(TokenClient::new(&env, &token3).balance(&admin), 1800);
    assert_eq!(TokenClient::new(&env, &token3).balance(&b), 1200);

    // Verify distribute count incremented by 3
    assert_eq!(client.get_distribute_count(), 3);
}

/// Test that batch_distribute emits events for each token.
#[test]
fn test_batch_distribute_emits_events() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 2000);

    client.batch_distribute(&vec![&env, token1.clone(), token2.clone()]);

    let events = env.events().all();

    // Check for dist_all events for both tokens
    let token1_event = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("dist_all").into_val(&env),
                ]
            && val_eq(&env, data, (token1.clone(), 1000_i128))
    });
    assert!(token1_event, "token1 dist_all event not emitted");

    let token2_event = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("dist_all").into_val(&env),
                ]
            && val_eq(&env, data, (token2.clone(), 2000_i128))
    });
    assert!(token2_event, "token2 dist_all event not emitted");

    // Check for batch completion event
    let batch_event = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("batch").into_val(&env),
                ]
            && val_eq(&env, data, 2_u32)
    });
    assert!(batch_event, "batch completion event not emitted");
}

/// Test that batch_distribute requires admin authorization.
#[test]
fn test_batch_distribute_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    mint(&env, &token1, &contract_id, 1000);

    // Use specific mock auth for admin
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "batch_distribute",
            args: (vec![&env, token1.clone()],).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.batch_distribute(&vec![&env, token1]);
    assert_eq!(client.get_distribute_count(), 1);
}

/// Test that batch_distribute fails when paused.
#[test]
fn test_batch_distribute_fails_when_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    mint(&env, &token1, &contract_id, 1000);

    client.pause();

    let result = client.try_batch_distribute(&vec![&env, token1]);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

/// Test that batch_distribute succeeds after unpause.
#[test]
fn test_batch_distribute_succeeds_after_unpause() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);
    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 2000);

    client.pause();
    client.unpause();

    client.batch_distribute(&vec![&env, token1.clone(), token2.clone()]);

    assert_eq!(TokenClient::new(&env, &token1).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token2).balance(&admin), 1000);
}

/// Test that batch_distribute with single token works correctly.
#[test]
fn test_batch_distribute_single_token() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 7000_u32, 3000_u32],
    );

    let token = make_token(&env, &token_admin);
    mint(&env, &token, &contract_id, 10_000);

    client.batch_distribute(&vec![&env, token.clone()]);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 7000);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 3000);
    assert_eq!(client.get_distribute_count(), 1);
}

/// Test that batch_distribute fails if any token has zero balance.
#[test]
fn test_batch_distribute_fails_on_zero_balance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 1000);
    // token2 has zero balance

    let result = client.try_batch_distribute(&vec![&env, token1, token2]);
    assert_eq!(result, Err(Ok(ContractError::NoBalance)));
}

/// Test that batch_distribute handles dust correctly for each token.
#[test]
fn test_batch_distribute_handles_dust_correctly() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // Three recipients with shares that create dust
    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 3333_u32, 3333_u32, 3334_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 10_000);
    mint(&env, &token2, &contract_id, 20_000);

    client.batch_distribute(&vec![&env, token1.clone(), token2.clone()]);

    // Verify token1 distribution (10,000 total)
    let admin_bal1 = TokenClient::new(&env, &token1).balance(&admin);
    let b_bal1 = TokenClient::new(&env, &token1).balance(&b);
    let c_bal1 = TokenClient::new(&env, &token1).balance(&c);
    assert_eq!(admin_bal1 + b_bal1 + c_bal1, 10_000);

    // Verify token2 distribution (20,000 total)
    let admin_bal2 = TokenClient::new(&env, &token2).balance(&admin);
    let b_bal2 = TokenClient::new(&env, &token2).balance(&b);
    let c_bal2 = TokenClient::new(&env, &token2).balance(&c);
    assert_eq!(admin_bal2 + b_bal2 + c_bal2, 20_000);
}

/// Test that batch_distribute works with default recipients.
#[test]
fn test_batch_distribute_with_default_recipients() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Set custom default recipients
    let custom_recipients = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 2000,
        },
        Recipient {
            address: b.clone(),
            share: 3000,
        },
        Recipient {
            address: c.clone(),
            share: 5000,
        },
    ];
    client.set_default_recipients(&custom_recipients);

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 10_000);
    mint(&env, &token2, &contract_id, 5_000);

    client.batch_distribute(&vec![&env, token1.clone(), token2.clone()]);

    // Verify token1 distribution with custom shares
    assert_eq!(TokenClient::new(&env, &token1).balance(&admin), 2000);
    assert_eq!(TokenClient::new(&env, &token1).balance(&b), 3000);
    assert_eq!(TokenClient::new(&env, &token1).balance(&c), 5000);

    // Verify token2 distribution with custom shares
    assert_eq!(TokenClient::new(&env, &token2).balance(&admin), 1000);
    assert_eq!(TokenClient::new(&env, &token2).balance(&b), 1500);
    assert_eq!(TokenClient::new(&env, &token2).balance(&c), 2500);
}

/// Test that batch_distribute with many tokens increments counter correctly.
#[test]
fn test_batch_distribute_counter_increment() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Create 5 tokens
    let mut tokens: SorobanVec<Address> = SorobanVec::new(&env);
    for _ in 0..5 {
        let token = make_token(&env, &token_admin);
        mint(&env, &token, &contract_id, 1000);
        tokens.push_back(token);
    }

    assert_eq!(client.get_distribute_count(), 0);

    client.batch_distribute(&tokens);

    // Counter should increment by 5
    assert_eq!(client.get_distribute_count(), 5);
}

/// Test that batch_distribute updates last distribution timestamp.
#[test]
fn test_batch_distribute_updates_timestamp() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 2000);

    let timestamp = 1_700_000_000_u64;
    env.ledger().with_mut(|ledger| ledger.timestamp = timestamp);

    assert!(client.get_last_distribution().is_none());

    client.batch_distribute(&vec![&env, token1, token2]);

    assert_eq!(client.get_last_distribution(), Some(timestamp));
}

/// Test that batch_distribute fails if amount is too small for any token.
#[test]
fn test_batch_distribute_fails_on_amount_too_small() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let token1 = make_token(&env, &token_admin);
    let token2 = make_token(&env, &token_admin);

    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 1); // Only 1 stroop, but 2 recipients

    let result = client.try_batch_distribute(&vec![&env, token1, token2]);
    assert_eq!(result, Err(Ok(ContractError::AmountTooSmall)));
}

/// Test batch_distribute with large number of tokens.
#[test]
fn test_batch_distribute_large_batch() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Create 10 tokens
    let mut tokens: SorobanVec<Address> = SorobanVec::new(&env);
    for i in 0..10 {
        let token = make_token(&env, &token_admin);
        mint(&env, &token, &contract_id, (i + 1) * 1000);
        tokens.push_back(token);
    }

    client.batch_distribute(&tokens);

    // Verify all distributions occurred
    assert_eq!(client.get_distribute_count(), 10);

    // Verify balances for a few tokens
    let token0 = tokens.get(0).unwrap();
    assert_eq!(TokenClient::new(&env, &token0).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token0).balance(&b), 500);

    let token9 = tokens.get(9).unwrap();
    assert_eq!(TokenClient::new(&env, &token9).balance(&admin), 5000);
    assert_eq!(TokenClient::new(&env, &token9).balance(&b), 5000);
}

// ── Issue #402: Admin Transfer Time-Lock Tests ───────────────────────────

/// Test that propose_admin_transfer stores timestamp with pending admin.
#[test]
fn test_propose_admin_transfer_stores_timestamp() {
    /// Issue #398 — dust is tracked and distributed in the next batch.
    #[test]
    fn test_dust_tracked_and_distributed_in_next_batch() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

        client.propose_admin_transfer(&new_admin);

        let (pending, timestamp, remaining) = client.get_pending_admin_transfer();
        assert_eq!(pending, new_admin);
        assert!(timestamp > 0);
        assert!(remaining > 0);
    }

    /// Test that accept_admin fails before time-lock expires.
    #[test]
    fn test_accept_admin_fails_before_timelock() {
        let b = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        client.initialize(
            &vec![&env, admin.clone(), b.clone()],
            &vec![&env, 5000_u32, 5000_u32],
        );

        // Set royalty rate and record secondary royalties
        client.set_royalty_rate(&1000_u32); // 10%
        StellarAssetClient::new(&env, &token).mint(&admin, &10_000);
        StellarAssetClient::new(&env, &token).approve(&admin, &contract_id, &1000, &9999999);
        client.record_secondary_royalty(&token, &admin, &1000);

        // First distribution - will have dust from rounding
        client.distribute_secondary_royalties();

        let admin_balance = TokenClient::new(&env, &token).balance(&admin);
        let b_balance = TokenClient::new(&env, &token).balance(&b);

        // 1000 * 10% = 100 total, split 50/50 = 50 each
        assert_eq!(admin_balance, 50);
        assert_eq!(b_balance, 50);

        // Record more royalties
        StellarAssetClient::new(&env, &token).mint(&admin, &10_000);
        StellarAssetClient::new(&env, &token).approve(&admin, &contract_id, &1000, &9999999);
        client.record_secondary_royalty(&token, &admin, &1000);

        // Second distribution - should include accumulated dust
        client.distribute_secondary_royalties();

        let admin_balance2 = TokenClient::new(&env, &token).balance(&admin);
        let b_balance2 = TokenClient::new(&env, &token).balance(&b);

        // Each should have received another 50 + dust from previous round
        assert!(admin_balance2 >= 100);
        assert!(b_balance2 >= 100);
    }

    /// Issue #398 — dust doesn't exceed 1 basis point limit.
    #[test]
    fn test_dust_within_safety_limit() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        client.initialize(
            &vec![&env, admin.clone(), b.clone(), c.clone()],
            &vec![&env, 3333_u32, 3333_u32, 3334_u32],
        );

        client.set_royalty_rate(&1000_u32);
        StellarAssetClient::new(&env, &token).mint(&admin, &10_000);
        StellarAssetClient::new(&env, &token).approve(&admin, &contract_id, &9999, &9999999);
        client.record_secondary_royalty(&token, &admin, &9999);

        // Distribution with odd amount to create dust
        client.distribute_secondary_royalties();

        // Verify dust is within limit (100 stroops = 1 basis point)
        let total_distributed = TokenClient::new(&env, &token).balance(&admin)
            + TokenClient::new(&env, &token).balance(&b)
            + TokenClient::new(&env, &token).balance(&c);

        // 9999 * 10% = 999.9, rounded to 999
        // Dust should be minimal
        assert!(total_distributed <= 9999);
    }

    /// Issue #398 — dust accumulation with many small transactions.
    #[test]
    fn test_dust_accumulation_many_small_transactions() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

        client.propose_admin_transfer(&new_admin);

        // Try to accept immediately - should fail
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.accept_admin();
        }));
        assert!(result.is_err());
    }

    /// Test that accept_admin succeeds after time-lock expires.
    #[test]
    fn test_accept_admin_succeeds_after_timelock() {
        let b = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        client.initialize(
            &vec![&env, admin.clone(), b.clone()],
            &vec![&env, 5000_u32, 5000_u32],
        );

        client.set_royalty_rate(&1000_u32);

        // Record many small royalty payments
        for _ in 0..10 {
            StellarAssetClient::new(&env, &token).mint(&admin, &100);
            StellarAssetClient::new(&env, &token).approve(&admin, &contract_id, &10, &9999999);
            client.record_secondary_royalty(&token, &admin, &10);
        }

        // Total pool: 100
        client.distribute_secondary_royalties();

        let admin_balance = TokenClient::new(&env, &token).balance(&admin);
        let b_balance = TokenClient::new(&env, &token).balance(&b);

        // 100 total, split 50/50 = 50 each
        assert_eq!(admin_balance, 50);
        assert_eq!(b_balance, 50);

        // Verify dust was tracked (should be 0 or very small)
        let pool_after = client.get_secondary_pool();
        assert_eq!(pool_after, 0);
    }

    /// Issue #398 — dust is tracked and distributed in the next batch.
    #[test]
    fn test_dust_tracked_and_distributed_in_next_batch() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

        client.propose_admin_transfer(&new_admin);

        // Fast-forward past 48-hour time-lock
        env.ledger()
            .set(stellar_royalty_splitter::ADMIN_TRANSFER_TIMELOCK_DURATION + 1);

        client.accept_admin();

        // Verify admin changed
        assert_eq!(client.get_admin(), new_admin);

        // Verify pending admin cleared
        let (pending, timestamp, remaining) = client.get_pending_admin_transfer();
        assert_eq!(pending, Address::generate(&env)); // Should be zero address
        assert_eq!(timestamp, 0);
    }

    /// Test that cancel_admin_proposal removes pending transfer.
    #[test]
    fn test_cancel_admin_proposal() {
        let b = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        client.initialize(
            &vec![&env, admin.clone(), b.clone()],
            &vec![&env, 5000_u32, 5000_u32],
        );

        // Set royalty rate and record secondary royalties
        client.set_royalty_rate(&1000_u32); // 10%
        StellarAssetClient::new(&env, &token).mint(&admin, &10_000);
        TokenClient::new(&env, &token).approve(&admin, &contract_id, &1000, &9999999);
        client.record_secondary_royalty(&token, &admin, &1000);

        // First distribution - will have dust from rounding
        client.distribute_secondary_royalties();

        let admin_balance = TokenClient::new(&env, &token).balance(&admin);
        let b_balance = TokenClient::new(&env, &token).balance(&b);

        // 1000 * 10% = 100 total, split 50/50 = 50 each
        assert_eq!(admin_balance, 50);
        assert_eq!(b_balance, 50);

        // Record more royalties
        StellarAssetClient::new(&env, &token).mint(&admin, &10_000);
        TokenClient::new(&env, &token).approve(&admin, &contract_id, &1000, &9999999);
        client.record_secondary_royalty(&token, &admin, &1000);

        // Second distribution - should include accumulated dust
        client.distribute_secondary_royalties();

        let admin_balance2 = TokenClient::new(&env, &token).balance(&admin);
        let b_balance2 = TokenClient::new(&env, &token).balance(&b);

        // Each should have received another 50 + dust from previous round
        assert!(admin_balance2 >= 100);
        assert!(b_balance2 >= 100);
    }

    /// Issue #398 — dust doesn't exceed 1 basis point limit.
    #[test]
    fn test_dust_within_safety_limit() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

        client.propose_admin_transfer(&new_admin);

        client.cancel_admin_proposal();

        // Verify pending admin cleared
        let (pending, timestamp, remaining) = client.get_pending_admin_transfer();
        assert_eq!(pending, Address::generate(&env)); // Should be zero address
        assert_eq!(timestamp, 0);
    }

    /// Test that get_pending_admin_transfer returns zero when no pending transfer.
    #[test]
    fn test_get_pending_admin_transfer_when_none() {
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        client.initialize(
            &vec![&env, admin.clone(), b.clone(), c.clone()],
            &vec![&env, 3333_u32, 3333_u32, 3334_u32],
        );

        client.set_royalty_rate(&1000_u32);
        StellarAssetClient::new(&env, &token).mint(&admin, &10_000);
        TokenClient::new(&env, &token).approve(&admin, &contract_id, &9999, &9999999);
        client.record_secondary_royalty(&token, &admin, &9999);

        // Distribution with odd amount to create dust
        client.distribute_secondary_royalties();

        // Verify dust is within limit (100 stroops = 1 basis point)
        let total_distributed = TokenClient::new(&env, &token).balance(&admin)
            + TokenClient::new(&env, &token).balance(&b)
            + TokenClient::new(&env, &token).balance(&c);

        // 9999 * 10% = 999.9, rounded to 999
        // Dust should be minimal
        assert!(total_distributed <= 9999);
    }

    /// Issue #398 — dust accumulation with many small transactions.
    #[test]
    fn test_dust_accumulation_many_small_transactions() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let b = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        client.initialize(
            &vec![&env, admin.clone(), b.clone()],
            &vec![&env, 5000_u32, 5000_u32],
        );

        client.set_royalty_rate(&1000_u32);

        // Record many small royalty payments
        for _ in 0..10 {
            StellarAssetClient::new(&env, &token).mint(&admin, &100);
            TokenClient::new(&env, &token).approve(&admin, &contract_id, &10, &9999999);
            client.record_secondary_royalty(&token, &admin, &10);
        }

        // Total pool: 100
        client.distribute_secondary_royalties();

        let admin_balance = TokenClient::new(&env, &token).balance(&admin);
        let b_balance = TokenClient::new(&env, &token).balance(&b);

        // 100 total, split 50/50 = 50 each
        assert_eq!(admin_balance, 50);
        assert_eq!(b_balance, 50);

        // Verify dust was tracked (should be 0 or very small)
        let pool_after = client.get_secondary_pool();
        assert_eq!(pool_after, 0);
    }

    /// Issue #405 — events include event_version field.
    #[test]
    fn test_events_include_event_version() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);

        client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

        let (pending, timestamp, remaining) = client.get_pending_admin_transfer();
        assert_eq!(pending, Address::generate(&env)); // Should be zero address
        assert_eq!(timestamp, 0);
        assert_eq!(remaining, 0);
    }

    /// Test that cancel_admin_proposal fails when no pending transfer.
    #[test]
    fn test_cancel_admin_proposal_fails_when_none() {
        let b = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        client.initialize(
            &vec![&env, admin.clone(), b.clone()],
            &vec![&env, 5000_u32, 5000_u32],
        );

        // Check initialize event includes version
        let events = env.events().all();
        let init_event = events.get(0).unwrap();
        let topics = init_event.1.clone();
        assert_eq!(topics.len(), 2);

        // The data should include event_version as first element
        let data: SorobanVec<Val> = init_event.2.clone().into_val(&env);
        assert!(data.len() >= 2); // At least event_version and ledger_sequence
    }

    /// Issue #405 — events include ledger sequence for ordering.
    #[test]
    fn test_events_include_ledger_sequence() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let b = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        client.initialize(
            &vec![&env, admin.clone(), b.clone()],
            &vec![&env, 5000_u32, 5000_u32],
        );

        // Set ledger sequence
        env.ledger().with_mut(|ledger| ledger.sequence_number = 100);

        client.set_royalty_rate(&500_u32);

        // Check rate_set event includes ledger sequence
        let events = env.events().all();
        // Find the rate_set event (should be after init)
        for i in 0..events.len() {
            let event = events.get(i).unwrap();
            let topics = event.1.clone();
            if topics.len() >= 2 {
                // Check if this is a royalty event
                let topic_str = format!("{:?}", topics.get(0).unwrap());
                if topic_str.contains("royalty") {
                    let data: SorobanVec<Val> = event.2.clone().into_val(&env);
                    assert!(data.len() >= 2); // event_version and ledger_sequence
                }
            }
        }
    }

    /// Issue #405 — event ordering across multiple transactions.
    #[test]
    fn test_event_ordering_with_ledger_sequence() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);

        client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

        // Try to cancel without pending transfer - should fail
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.cancel_admin_proposal();
        }));
        assert!(result.is_err());
    }

    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Perform multiple operations with different ledger sequences
    env.ledger().with_mut(|ledger| ledger.sequence_number = 100);
    client.set_royalty_rate(&1000_u32);

    env.ledger().with_mut(|ledger| ledger.sequence_number = 200);
    client.set_royalty_rate(&1500_u32);

    env.ledger().with_mut(|ledger| ledger.sequence_number = 300);
    client.set_royalty_rate(&2000_u32);

    // Events should be emitted in order
    let events = env.events().all();
    let mut royalty_events = 0;
    for i in 0..events.len() {
        let event = events.get(i).unwrap();
        let topics = event.1.clone();
        if topics.len() >= 2 {
            let topic_str = format!("{:?}", topics.get(0).unwrap());
            if topic_str.contains("royalty") {
                royalty_events += 1;
            }
        }
    }

    // Should have multiple royalty events
    assert!(royalty_events >= 3);
}

/// Issue #405 — events emitted before state changes for atomicity.
#[test]
fn test_events_emitted_before_state_changes() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // The initialize event should be emitted before the version is set
    // This is tested by checking the event exists
    let version = client.get_version();
    assert_eq!(
        version,
        String::from_str(&env, stellar_royalty_splitter::VERSION)
    );

    // Event should have been emitted
    let events = env.events().all();
    assert!(events.len() > 0);
}

// ── Issue #410: Additional snapshot tests for storage state transitions ────────

/// Issue #410 — After admin_transfer, PendingAdmin is set in instance storage.
#[test]
fn test_snapshot_pending_admin_set_after_admin_transfer() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

    client.admin_transfer(&new_admin);

    env.as_contract(&contract_id, || {
        let pending: Address = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdmin)
            .expect("PendingAdmin should be set after admin_transfer");
        assert_eq!(pending, new_admin);
        // Admin must not have changed yet.
        let current_admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("Admin should still be set");
        assert_eq!(current_admin, admin);
    });
}

/// Issue #410 — After accept_admin, Admin changes to new_admin and PendingAdmin is cleared.
#[test]
fn test_snapshot_admin_changes_and_pending_cleared_after_accept_admin() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let new_admin = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

    client.admin_transfer(&new_admin);
    client.accept_admin();

    env.as_contract(&contract_id, || {
        // Admin must now be new_admin.
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("Admin should be stored after accept_admin");
        assert_eq!(stored_admin, new_admin);
        // PendingAdmin must be cleared.
        assert!(
            !env.storage().instance().has(&StorageKey::PendingAdmin),
            "PendingAdmin should be cleared after accept_admin"
        );
    });
}

/// Issue #410 — After pause, Paused=true is stored in instance storage.
#[test]
fn test_snapshot_paused_true_after_pause() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

    client.pause();

    env.as_contract(&contract_id, || {
        let paused: bool = env
            .storage()
            .instance()
            .get(&StorageKey::Paused)
            .expect("Paused should be stored after pause");
        assert!(paused, "Paused should be true after pause()");
    });
}

/// Issue #410 — After unpause, Paused is false or cleared in instance storage.
#[test]
fn test_snapshot_paused_cleared_after_unpause() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

    client.pause();
    client.unpause();

    env.as_contract(&contract_id, || {
        // Either the key is absent, or the value is false.
        let paused: bool = env
            .storage()
            .instance()
            .get(&StorageKey::Paused)
            .unwrap_or(false);
        assert!(!paused, "Paused should be false or absent after unpause()");
    });
}

/// Issue #410 — After set_royalty_rate, RoyaltyRate is stored and RoyaltyRateHistory is updated.
#[test]
fn test_snapshot_royalty_rate_stored_and_history_updated() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

    let new_rate: u32 = 500;
    client.set_royalty_rate(&new_rate);

    env.as_contract(&contract_id, || {
        let stored_rate: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .expect("RoyaltyRate should be stored after set_royalty_rate");
        assert_eq!(stored_rate, new_rate);

        // RoyaltyRateHistory in persistent storage must be non-empty.
        let history_exists = env
            .storage()
            .persistent()
            .has(&StorageKey::RoyaltyRateHistory);
        assert!(
            history_exists,
            "RoyaltyRateHistory should exist after set_royalty_rate"
        );
    });
}

/// Issue #410 — After two distributes, DistributeHistory counter equals 2.
#[test]
fn test_snapshot_distribute_history_has_both_records_after_two_distributes() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5_000_u32, 5_000_u32],
    );

    mint(&env, &token, &contract_id, 10_000);
    env.ledger().with_mut(|l| l.timestamp = 1_700_000_001);
    client.distribute(&token);

    mint(&env, &token, &contract_id, 20_000);
    env.ledger().with_mut(|l| l.timestamp = 1_700_000_002);
    client.distribute(&token);

    env.as_contract(&contract_id, || {
        let count: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .expect("DistributeHistory should be stored after two distributes");
        assert_eq!(
            count, 2,
            "DistributeHistory should be 2 after two distributes"
        );
    });
}

/// Issue #410 — Collaborators count is exactly 3 after initialize with 3 collaborators.
#[test]
fn test_snapshot_collaborators_count_after_initialize_with_three() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    client.initialize(
        &vec![&env, a.clone(), b.clone(), c.clone()],
        &vec![&env, 4_000_u32, 3_000_u32, 3_000_u32],
    );

    env.as_contract(&contract_id, || {
        let stored: SorobanVec<Address> = env
            .storage()
            .persistent()
            .get(&StorageKey::Collaborators)
            .expect("Collaborators should be stored");
        assert_eq!(stored.len(), 3, "Collaborators count should be 3");
    });
}

/// Issue #410 — ShareMap has exact values after initialize.
#[test]
fn test_snapshot_share_map_exact_values_after_initialize() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    client.initialize(
        &vec![&env, a.clone(), b.clone(), c.clone()],
        &vec![&env, 4_000_u32, 3_500_u32, 2_500_u32],
    );

    env.as_contract(&contract_id, || {
        let stored: Map<Address, u32> = env
            .storage()
            .persistent()
            .get(&StorageKey::ShareMap)
            .expect("ShareMap should be stored");
        assert_eq!(stored.get(a).unwrap(), 4_000, "a's share should be 4000");
        assert_eq!(stored.get(b).unwrap(), 3_500, "b's share should be 3500");
        assert_eq!(stored.get(c).unwrap(), 2_500, "c's share should be 2500");
    });
}

/// Issue #410 — ContractVersion is stored on initialize and matches VERSION constant.
#[test]
fn test_snapshot_contract_version_stored_on_initialize() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone()], &vec![&env, 10_000_u32]);

    env.as_contract(&contract_id, || {
        let stored_version: String = env
            .storage()
            .instance()
            .get(&StorageKey::ContractVersion)
            .expect("ContractVersion should be stored after initialize");
        assert_eq!(
            stored_version,
            String::from_str(&env, VERSION),
            "ContractVersion should match the VERSION constant"
        );
    });
}

/// Issue #410 — LastDistribution timestamp matches ledger timestamp after distribute.
#[test]
fn test_snapshot_last_distribution_timestamp_after_distribute() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6_000_u32, 4_000_u32],
    );

    let expected_ts: u64 = 1_750_000_000;
    mint(&env, &token, &contract_id, 50_000);
    env.ledger().with_mut(|l| l.timestamp = expected_ts);
    client.distribute(&token);

    env.as_contract(&contract_id, || {
        let last_ts: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::LastDistribution)
            .expect("LastDistribution should be stored after distribute");
        assert_eq!(
            last_ts, expected_ts,
            "LastDistribution timestamp should equal ledger timestamp"
        );
    });
}

// ── Issue #468: secondary royalty logic tests ─────────────────────────────────

/// Distributing with an empty secondary pool returns the typed NoSecondaryRoyalties error.
#[test]
fn test_secondary_royalty_empty_pool_returns_typed_error() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // No record_secondary_royalty called — pool is empty.
    let result = client.try_distribute_secondary_royalties();
    assert_eq!(result, Err(Ok(ContractError::NoSecondaryRoyalties)));
}

/// Multiple record_secondary_royalty calls accumulate into the pool.
#[test]
fn test_secondary_royalty_multiple_contributions_accumulate() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    mint(&env, &token, &admin, 300);
    client.record_secondary_royalty(&token, &admin, &100_i128);
    client.record_secondary_royalty(&token, &admin, &200_i128);

    assert_eq!(client.get_secondary_pool(), 300);
}

/// Exact three-way split: pool=10 with 5000/3000/2000 shares → each recipient
/// gets 5/3/2 stroops with zero rounding dust.
#[test]
fn test_secondary_royalty_exact_three_way_split() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 5000_u32, 3000_u32, 2000_u32],
    );

    let pool: i128 = 10;
    mint(&env, &token, &admin, pool);
    client.record_secondary_royalty(&token, &admin, &pool);
    client.distribute_secondary_royalties();

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&admin), 5, "admin should receive 5");
    assert_eq!(token_client.balance(&b), 3, "b should receive 3");
    assert_eq!(token_client.balance(&c), 2, "c (last) should receive 2");
}

/// With an odd pool (7 stroops) split 50/50, the last recipient absorbs the
/// integer-division dust: first gets 3, last gets 4.
#[test]
fn test_secondary_royalty_dust_absorbed_by_last_recipient() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let pool: i128 = 7;
    mint(&env, &token, &admin, pool);
    client.record_secondary_royalty(&token, &admin, &pool);
    client.distribute_secondary_royalties();

    let token_client = TokenClient::new(&env, &token);
    // 7 * 5000 / 10000 = 3 for first; last gets 7 - 3 = 4
    assert_eq!(token_client.balance(&admin), 3, "admin should receive 3");
    assert_eq!(token_client.balance(&b), 4, "b (last) absorbs dust and receives 4");
}

/// After a successful distribution the secondary pool is reset to zero.
#[test]
fn test_secondary_royalty_pool_zeroed_after_distribution() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let pool: i128 = 200;
    mint(&env, &token, &admin, pool);
    client.record_secondary_royalty(&token, &admin, &pool);
    client.distribute_secondary_royalties();

    assert_eq!(client.get_secondary_pool(), 0, "pool should be zeroed after distribution");
}

/// PoolExceedsBalance is returned when the recorded pool is larger than the
/// actual token balance (e.g. after accounting inconsistency).
#[test]
fn test_secondary_royalty_pool_exceeds_balance_returns_typed_error() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Record 100 stroops — pool = 100, contract balance = 100.
    let pool: i128 = 100;
    mint(&env, &token, &admin, pool);
    client.record_secondary_royalty(&token, &admin, &pool);

    // Force the pool counter above the real balance.
    env.as_contract(&contract_id, || {
        env.storage()
            .instance()
            .set(&StorageKey::SecondaryPool, &1_000_i128);
    });

    let result = client.try_distribute_secondary_royalties();
    assert_eq!(result, Err(Ok(ContractError::PoolExceedsBalance)));
}

/// Large pool (1000 stroops) with near-equal thirds (3333/3333/3334) distributes
/// without losing a stroop: 333 + 333 + 334 = 1000.
#[test]
fn test_secondary_royalty_rounding_precision_large_pool() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 3333_u32, 3333_u32, 3334_u32],
    );

    let pool: i128 = 1000;
    mint(&env, &token, &admin, pool);
    client.record_secondary_royalty(&token, &admin, &pool);
    client.distribute_secondary_royalties();

    let token_client = TokenClient::new(&env, &token);
    // 1000 * 3333 / 10000 = 333 each for first two; last gets 1000 - 333 - 333 = 334
    assert_eq!(token_client.balance(&admin), 333);
    assert_eq!(token_client.balance(&b), 333);
    assert_eq!(token_client.balance(&c), 334);
    assert_eq!(
        token_client.balance(&admin) + token_client.balance(&b) + token_client.balance(&c),
        pool,
        "all stroops must be accounted for"
    );
}

/// distribute_with_override returns AmountTooSmall when the contract balance
/// is less than the number of override recipients (3 recipients, 2 stroops).
#[test]
fn test_distribute_with_override_amount_too_small_returns_typed_error() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Balance = 2 stroops, 3 override recipients → amount (2) < n (3).
    mint(&env, &token, &contract_id, 2);

    let overrides = vec![
        &env,
        Recipient { address: admin.clone(), share: 5000_u32 },
        Recipient { address: b.clone(), share: 3000_u32 },
        Recipient { address: c.clone(), share: 2000_u32 },
    ];

    let result = client.try_distribute_with_override(&token, &overrides);
    assert_eq!(result, Err(Ok(ContractError::AmountTooSmall)));
}

/// distribute_with_override succeeds at the exact boundary: n recipients with
/// exactly n stroops (2 recipients, 2 stroops → each receives 1 stroop).
#[test]
fn test_distribute_with_override_exactly_n_stroops_succeeds() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Exact boundary: 2 recipients, 2 stroops.
    mint(&env, &token, &contract_id, 2);

    let overrides = vec![
        &env,
        Recipient { address: admin.clone(), share: 5000_u32 },
        Recipient { address: b.clone(), share: 5000_u32 },
    ];

    client.distribute_with_override(&token, &overrides);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&admin), 1, "admin should receive 1 stroop");
    assert_eq!(token_client.balance(&b), 1, "b should receive 1 stroop");
}

/// distribute_with_override returns InvalidShareTotal when override shares
/// do not sum to exactly 10 000.
#[test]
fn test_distribute_with_override_invalid_share_total_returns_typed_error() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    mint(&env, &token, &contract_id, 1000);

    // Shares sum to 9999, not 10000.
    let bad_overrides = vec![
        &env,
        Recipient { address: admin.clone(), share: 5000_u32 },
        Recipient { address: b.clone(), share: 4999_u32 },
    ];

    let result = client.try_distribute_with_override(&token, &bad_overrides);
    assert_eq!(result, Err(Ok(ContractError::InvalidShareTotal)));
}

/// A single override recipient at 10 000 basis points receives the entire
/// contract balance.
#[test]
fn test_distribute_with_override_single_recipient_gets_full_amount() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let sole = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let amount: i128 = 500;
    mint(&env, &token, &contract_id, amount);

    let overrides = vec![
        &env,
        Recipient { address: sole.clone(), share: 10000_u32 },
    ];

    client.distribute_with_override(&token, &overrides);

    assert_eq!(TokenClient::new(&env, &token).balance(&sole), amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
}
