#![cfg(test)]
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env, IntoVal, Map, String, TryFromVal, Val, Vec as SorobanVec,
};
use stellar_royalty_splitter::{
    auth, ContractError, DataKey, Recipient, RoyaltyRateChange, RoyaltySplitterClient, StorageKey,
    MIN_TTL, RATE_HISTORY_CAP, VERSION,
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
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
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
fn test_distribute_zero_balance_returns_typed_error() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);
    client.initialize(&vec![&env, a, b], &vec![&env, 5000_u32, 5000_u32]);
    // Contract balance is 0, so distribute returns a typed contract error.
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::NoBalance)));
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

/// Test that set_default_recipients rejects duplicate addresses
#[test]
#[should_panic]
fn test_set_default_recipients_duplicate_address_panics() {
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

    client.set_default_recipients(&recipients);
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

    let override1 = Recipient {
        address: c.clone(),
        share: 10000_u32,
    };
    let overrides = vec![&env, override1];
    client.distribute_with_override(&token, &overrides);

    assert_eq!(TokenClient::new(&env, &token).balance(&c), 1000);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);
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

/// Issue #223 - distribute called with zero contract balance must return a typed
/// error before mutating distribution state.
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
    assert_eq!(result, Err(Ok(ContractError::NoBalance)));

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
    client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

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
    client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 6000_u32, 4000_u32]);

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
    client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    let r1 = Recipient { address: a.clone(), share: 7000_u32 };
    let r2 = Recipient { address: b.clone(), share: 3000_u32 };
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

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    // No pending admin transfer has been proposed — must return an error
    let result = client.try_accept_admin();
    assert!(result.is_err(), "accept_admin without a pending proposal must error");
}

#[test]
fn test_accept_admin_requires_pending_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
    client.set_admins(&vec![&env, admin.clone(), b.clone()], &2);

    // admin_transfer must be blocked when multi-sig is active
    let result = client.try_admin_transfer(&new_admin);
    assert!(result.is_err(), "admin_transfer must error when multi-sig is active");
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

    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

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
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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
    assert!(result.is_err(), "distribute must fail with only 1 of 2 required auths");
}

#[test]
fn test_set_admins_requires_current_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let intruder = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

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
    assert!(result.is_err(), "set_admins must require current admin auth");
}

#[test]
fn test_set_admins_rejects_zero_threshold() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

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
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    // threshold=3 but only 2 admins in list — must be rejected
    let result = client.try_set_admins(&vec![&env, admin.clone(), b.clone()], &3);
    assert!(result.is_err(), "threshold exceeding admin count must be rejected");
}

#[test]
fn test_set_admins_rejects_empty_list() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

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
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    assert_eq!(client.get_royalty_rate_history().len(), 0);
}

#[test]
fn test_rate_history_records_entry_on_set() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

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
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

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
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

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
    client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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
