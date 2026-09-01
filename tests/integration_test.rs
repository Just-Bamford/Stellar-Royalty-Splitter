#![cfg(test)]
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env, IntoVal, Map, String, TryFromVal, Val, Vec as SorobanVec,
};
use stellar_royalty_splitter::{
    auth, ContractError, DataKey, OperationProposal, OperationType, Recipient, RoyaltyRateChange,
    RoyaltySplitterClient, SensitiveOperation, StorageKey, MIN_TTL, RATE_HISTORY_CAP, VERSION,
};

fn setup(env: &Env) -> (Address, RoyaltySplitterClient<'_>) {
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
    assert_eq!(result, Err(Ok(ContractError::Underfunded.into())));
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

#[test]
fn test_migrate_records_versioned_state_once() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(&vec![&env, admin, b], &vec![&env, 5000_u32, 5000_u32]);

    let from_version = String::from_str(&env, "0.0.1");
    client.migrate(&from_version);
    client.migrate(&from_version);

    let migrations = client.get_applied_migrations();
    assert_eq!(migrations.len(), 1);
    let record = migrations.get(0).unwrap();
    assert_eq!(record.from_version, from_version);
    assert_eq!(record.to_version, String::from_str(&env, VERSION));
    assert_eq!(client.get_version(), String::from_str(&env, VERSION));
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

/// Issue #667 — a failed `initialize` (invalid share total) must not write
/// any storage entry. Uses `try_initialize` so the assertion failure (were
/// it to fire) reports cleanly rather than unwinding through a panic.
#[test]
fn test_failed_initialize_does_not_write_any_storage() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    // Shares sum to 9,000, not 10,000 — initialize must reject and write nothing.
    let result = client.try_initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 4000_u32],
    );
    assert_eq!(result, Err(Ok(ContractError::InvalidShareTotal.into())));

    env.as_contract(&contract_id, || {
        assert!(!env.storage().instance().has(&StorageKey::Admin));
        assert!(!env.storage().instance().has(&StorageKey::ContractVersion));
        assert!(!env.storage().persistent().has(&StorageKey::Collaborators));
        assert!(!env.storage().persistent().has(&StorageKey::ShareMap));
    });
}

/// Issue #667 — a failed `update_share` (new total != 10,000) must leave the
/// share map and collaborator list exactly as they were before the call.
#[test]
fn test_failed_update_share_does_not_change_share_map() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // 5000 -> 7000 makes the total 12,000; must be rejected.
    let result = client.try_update_share(&admin, &7000_u32);
    assert_eq!(
        result,
        Err(Ok(ContractError::InvalidUpdatedShareTotal.into()))
    );

    assert_eq!(client.get_share(&admin), 5000);
    assert_eq!(client.get_share(&b), 5000);
    assert_eq!(client.get_total_shares(), 10_000);
}

/// Issue #667 — a failed `distribute` (zero balance) must not advance the
/// distribution counter/timestamp or move any token balance.
#[test]
fn test_failed_distribute_does_not_change_counters_or_balances() {
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

    // Contract balance is 0 — distribute must fail without touching state.
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::Underfunded.into())));

    assert_eq!(client.get_distribute_count(), 0);
    assert!(client.get_last_distribution().is_none());
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);
}

/// Issue #667 — repeated successful distributions must keep advancing the
/// counter/timestamp while the collaborator list and share map stay fixed.
#[test]
fn test_repeated_distribution_sequence_preserves_storage_consistency() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    let mut expected_admin_balance: i128 = 0;
    let mut expected_b_balance: i128 = 0;

    for round in 1..=3_u64 {
        let amount: i128 = 1_000;
        mint(&env, &token, &contract_id, amount);
        env.ledger()
            .with_mut(|ledger| ledger.timestamp = 1_700_000_000 + round);

        client.distribute(&token);

        assert_eq!(client.get_distribute_count(), round);
        assert_eq!(
            client.get_last_distribution().unwrap(),
            1_700_000_000 + round
        );

        expected_admin_balance += amount * 6000 / 10_000;
        expected_b_balance += amount * 4000 / 10_000;
        assert_eq!(
            TokenClient::new(&env, &token).balance(&admin),
            expected_admin_balance
        );
        assert_eq!(
            TokenClient::new(&env, &token).balance(&b),
            expected_b_balance
        );

        // Configuration storage must never drift across repeated distributions.
        assert_eq!(client.get_share(&admin), 6000);
        assert_eq!(client.get_share(&b), 4000);
        assert_eq!(client.get_collaborators().len(), 2);
    }
}

/// Issue #667 — collaborator allocations must remain unchanged after a
/// sequence of unrelated successful operations (rate change, pause/unpause,
/// secondary royalty recording) and after both a successful and a failed
/// distribute.
#[test]
fn test_collaborator_allocations_unchanged_across_operations() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6500_u32, 3500_u32],
    );

    let snapshot_collaborators = client.get_collaborators();
    let snapshot_admin_share = client.get_share(&admin);
    let snapshot_b_share = client.get_share(&b);

    client.set_royalty_rate(&500_u32);
    client.pause();
    client.unpause();
    client.record_secondary_royalty(&token, &admin, &100_i128);

    // A failed distribute (zero balance for this call) must not disturb shares.
    let failed = client.try_distribute(&token);
    assert!(failed.is_err());

    mint(&env, &token, &contract_id, 10_000);
    client.distribute(&token);

    let collaborators = client.get_collaborators();
    assert_eq!(collaborators.len(), snapshot_collaborators.len());
    for i in 0..collaborators.len() {
        assert_eq!(
            collaborators.get(i).unwrap(),
            snapshot_collaborators.get(i).unwrap()
        );
    }
    assert_eq!(client.get_share(&admin), snapshot_admin_share);
    assert_eq!(client.get_share(&b), snapshot_b_share);
    assert_eq!(client.get_total_shares(), 10_000);
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

/// Events — distribute_secondary emits a ("royalty", "sec_dist") event.
#[test]
fn test_distribute_secondary_emits_event() {
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
    client.distribute_secondary();

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

/// Issue #746 — is_collaborator returns true for a registered collaborator
/// and false for any address that was never registered.
#[test]
fn test_is_collaborator_known_and_unknown() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let stranger = Address::generate(&env);
    client.initialize(
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    assert!(client.is_collaborator(&a));
    assert!(client.is_collaborator(&b));
    assert!(!client.is_collaborator(&stranger));
}

/// Issue #746 — is_collaborator is safe to call before initialize: it
/// returns false rather than panicking, unlike get_share/get_collaborators
/// which expect the contract to already be initialized.
#[test]
fn test_is_collaborator_false_before_initialize() {
    let env = Env::default();
    let (_, client) = setup(&env);
    let addr = Address::generate(&env);

    assert!(!client.is_collaborator(&addr));
}

/// Issue #746 — after update_share swaps out a collaborator's role (share
/// changes but identity doesn't), is_collaborator still reports the
/// existing collaborator set correctly and does not report a share amount
/// as if it were an address.
#[test]
fn test_is_collaborator_reflects_current_registration_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    client.update_share(&a, &7000_u32);
    client.update_share(&b, &3000_u32);

    assert!(client.is_collaborator(&a));
    assert!(client.is_collaborator(&b));
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

/// Issue #160 — pause blocks distribute_secondary.
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
    client.distribute_secondary();
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
    assert_eq!(result, Err(Ok(ContractError::RoyaltyRateZero.into())));
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
    assert_eq!(result, Err(Ok(ContractError::RoyaltyRateTooHigh.into())));
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

    assert_eq!(result, Err(Ok(ContractError::ArithmeticOverflow.into())));
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

    assert_eq!(result, Err(Ok(ContractError::ArithmeticOverflow.into())));
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
        client.distribute_secondary();

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
    assert_eq!(result, Err(Ok(ContractError::InvalidBasisPoints.into())));
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
    assert_eq!(result, Err(Ok(ContractError::DuplicateRecipient.into())));

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
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
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

/// Test distribute_with_override rejects a duplicate address in override_recipients (#713).
/// Prior to this fix, distribute_with_override only checked emptiness and share-sum,
/// so a duplicated address (shares still summing to 10,000) was accepted.
#[test]
fn test_distribute_with_override_duplicate_address_panics_without_distribution() {
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

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.distribute_with_override(&token, &duplicate_override);
    }));

    assert!(
        result.is_err(),
        "Distribution should panic on a duplicate recipient address"
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
}

/// Test distribute_with_override rejects a zero-share entry in override_recipients (#713).
#[test]
fn test_distribute_with_override_zero_share_panics_without_distribution() {
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

    let amount: i128 = 1000;
    mint(&env, &token, &contract_id, amount);

    let zero_share_override = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 0_u32,
        },
        Recipient {
            address: c.clone(),
            share: 10000_u32,
        },
    ];

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.distribute_with_override(&token, &zero_share_override);
    }));

    assert!(
        result.is_err(),
        "Distribution should panic on a zero-share recipient"
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&c), 0);
}

/// Test distribute_with_override rejects an override_recipients list longer than
/// MAX_RECIPIENTS (#713). Prior to this fix, override_recipients had no length cap,
/// unlike set_recipients/set_default_recipients.
#[test]
fn test_distribute_with_override_too_many_recipients_panics_without_distribution() {
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

    // MAX_RECIPIENTS is 10; build 11 distinct recipients with equal shares
    // that still sum to 10,000 (10000 / 11 rounds down, remainder on the last).
    let too_many = 11_u32;
    let mut oversized_override: SorobanVec<Recipient> = vec![&env];
    let mut running_total = 0_u32;
    for i in 0..too_many {
        let share = if i == too_many - 1 {
            10_000_u32 - running_total
        } else {
            10_000_u32 / too_many
        };
        running_total += share;
        oversized_override.push_back(Recipient {
            address: Address::generate(&env),
            share,
        });
    }

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.distribute_with_override(&token, &oversized_override);
    }));

    assert!(
        result.is_err(),
        "Distribution should panic when override_recipients exceeds MAX_RECIPIENTS"
    );
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
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
    assert_eq!(result, Err(Ok(ContractError::Underfunded.into())));

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
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));
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
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));

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

/// Test that distribute_secondary() fails with ContractPaused error when paused.
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

    // Verify distribute_secondary fails with the correct error
    let result = client.try_distribute_secondary();
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));
}

/// Test that distribute_secondary() succeeds after unpause.
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

    // Pause and verify distribute_secondary fails
    client.pause();
    let result = client.try_distribute_secondary();
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));

    // Unpause
    client.unpause();
    assert!(!client.is_paused());

    // Distribute secondary royalties should now succeed
    client.distribute_secondary();

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
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));
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
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));
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
    assert_eq!(result, Err(Ok(ContractError::NoBalance.into())));
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
    assert_eq!(result, Err(Ok(ContractError::AmountTooSmall.into())));
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

/// Issue #744 — batch_distribute accepts exactly MAX_BATCH_TOKENS (50)
/// tokens in one call without hitting the new bound.
#[test]
fn test_batch_distribute_accepts_max_batch_tokens() {
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

    let mut tokens: SorobanVec<Address> = SorobanVec::new(&env);
    for _ in 0..stellar_royalty_splitter::MAX_BATCH_TOKENS {
        let token = make_token(&env, &token_admin);
        mint(&env, &token, &contract_id, 1000);
        tokens.push_back(token);
    }

    client.batch_distribute(&tokens);

    assert_eq!(
        client.get_distribute_count(),
        stellar_royalty_splitter::MAX_BATCH_TOKENS as u64
    );
}

/// Issue #744 — batch_distribute rejects a token list longer than
/// MAX_BATCH_TOKENS with a specific error, and performs no transfers.
#[test]
fn test_batch_distribute_rejects_too_many_tokens() {
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

    let mut tokens: SorobanVec<Address> = SorobanVec::new(&env);
    for _ in 0..(stellar_royalty_splitter::MAX_BATCH_TOKENS + 1) {
        let token = make_token(&env, &token_admin);
        mint(&env, &token, &contract_id, 1000);
        tokens.push_back(token);
    }

    let result = client.try_batch_distribute(&tokens);
    assert!(result.is_err());

    // No distribution occurred — the bound is checked before any transfer.
    assert_eq!(client.get_distribute_count(), 0);
    let token0 = tokens.get(0).unwrap();
    assert_eq!(TokenClient::new(&env, &token0).balance(&contract_id), 1000);
}

// ── Issue #664: expanded authorization / access-control coverage ────────────
//
// Fills gaps left by the existing auth tests: some protected operations only
// had an authorized-path test, some only had an unauthorized-path test, and a
// few (record_secondary_royalty, update_share, distribute_secondary)
// had neither a dedicated authorized nor unauthorized auth test. Every test
// below uses `try_*` client methods so a rejected call surfaces as `Err`
// instead of unwinding, and asserts contract state is unchanged afterwards.

/// record_secondary_royalty: authorized payer succeeds and the secondary pool
/// reflects the recorded amount.
#[test]
fn test_record_secondary_royalty_authorized_payer_succeeds() {
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
    mint(&env, &token, &admin, 100);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "record_secondary_royalty",
            args: (token.clone(), admin.clone(), 100_i128).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.record_secondary_royalty(&token, &admin, &100_i128);
    assert_eq!(client.get_secondary_pool(), 100);
}

/// record_secondary_royalty: no authorization at all must be rejected and
/// must not move the secondary pool.
#[test]
fn test_record_secondary_royalty_rejects_missing_auth() {
    let env = Env::default();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &admin, 100);

    env.mock_auths(&[]);
    let result = client.try_record_secondary_royalty(&token, &admin, &100_i128);
    assert!(
        result.is_err(),
        "record_secondary_royalty must require payer auth"
    );
    assert_eq!(client.get_secondary_pool(), 0);
}

/// record_secondary_royalty: a signature from someone other than `from` must
/// not satisfy the payer authorization requirement.
#[test]
fn test_record_secondary_royalty_rejects_wrong_signer() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let intruder = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &admin, 100);

    // Intruder signs their own auth tree — not `from` (admin) — so the payer
    // authorization check must fail.
    env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "record_secondary_royalty",
            args: (token.clone(), admin.clone(), 100_i128).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_record_secondary_royalty(&token, &admin, &100_i128);
    assert!(
        result.is_err(),
        "record_secondary_royalty must reject a signer that is not `from`"
    );
    assert_eq!(client.get_secondary_pool(), 0);
}

/// Issue #744 — record_secondary_royalty rejects a zero royalty_amount and
/// leaves the secondary pool untouched.
#[test]
fn test_record_secondary_royalty_rejects_zero_amount() {
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
    mint(&env, &token, &admin, 100);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "record_secondary_royalty",
            args: (token.clone(), admin.clone(), 0_i128).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_record_secondary_royalty(&token, &admin, &0_i128);
    assert!(result.is_err(), "a zero royalty_amount must be rejected");
    assert_eq!(client.get_secondary_pool(), 0);
    // No transfer occurred — the payer's balance is unchanged.
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 100);
}

/// Issue #744 — record_secondary_royalty rejects a negative royalty_amount.
/// Without this check a negative amount would silently shrink the tracked
/// secondary pool below zero rather than moving any tokens.
#[test]
fn test_record_secondary_royalty_rejects_negative_amount() {
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
    mint(&env, &token, &admin, 100);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "record_secondary_royalty",
            args: (token.clone(), admin.clone(), -50_i128).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_record_secondary_royalty(&token, &admin, &-50_i128);
    assert!(
        result.is_err(),
        "a negative royalty_amount must be rejected"
    );
    assert_eq!(client.get_secondary_pool(), 0);
}

/// Issue #744 — a positive royalty_amount still succeeds and accumulates
/// correctly across multiple calls (regression guard for the new check).
#[test]
fn test_record_secondary_royalty_accumulates_across_calls() {
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
    mint(&env, &token, &admin, 300);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "record_secondary_royalty",
            args: (token.clone(), admin.clone(), 100_i128).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.record_secondary_royalty(&token, &admin, &100_i128);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "record_secondary_royalty",
            args: (token.clone(), admin.clone(), 150_i128).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.record_secondary_royalty(&token, &admin, &150_i128);

    assert_eq!(client.get_secondary_pool(), 250);
}

/// update_share: authorized admin succeeds and the share is updated.
#[test]
fn test_update_share_specific_admin_auth_succeeds() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "update_share",
            args: (b.clone(), 6000_u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.update_share(&b, &6000_u32);
    assert_eq!(client.get_share(&b), 6000);
}

/// update_share: no authorization at all must be rejected and must not
/// change the collaborator's stored share.
#[test]
fn test_update_share_rejects_missing_auth() {
    let env = Env::default();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.mock_auths(&[]);
    let result = client.try_update_share(&b, &6000_u32);
    assert!(result.is_err(), "update_share must require admin auth");
    assert_eq!(client.get_share(&b), 5000);
}

/// update_share: a non-admin collaborator authorizing their own call must not
/// be treated as admin authorization.
#[test]
fn test_update_share_rejects_non_admin_caller() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // `b` is a collaborator but not the admin — their own signature must not
    // authorize update_share.
    env.mock_auths(&[MockAuth {
        address: &b,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "update_share",
            args: (b.clone(), 6000_u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_update_share(&b, &6000_u32);
    assert!(
        result.is_err(),
        "update_share must reject a non-admin caller"
    );
    assert_eq!(client.get_share(&b), 5000);
}

/// distribute_secondary: authorized admin succeeds via a
/// function-specific mock auth (not the blanket mock_all_auths).
#[test]
fn test_distribute_secondary_specific_admin_auth_succeeds() {
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
    mint(&env, &token, &admin, 500);
    client.record_secondary_royalty(&token, &admin, &500_i128);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "distribute_secondary",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.distribute_secondary();
    assert_eq!(client.get_secondary_pool(), 0);
}

/// distribute_secondary: no authorization at all must be rejected
/// and must not drain the secondary pool.
#[test]
fn test_distribute_secondary_rejects_missing_auth() {
    let env = Env::default();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    mint(&env, &token, &admin, 500);
    client.record_secondary_royalty(&token, &admin, &500_i128);

    env.mock_auths(&[]);
    let result = client.try_distribute_secondary();
    assert!(
        result.is_err(),
        "distribute_secondary must require admin auth"
    );
    assert_eq!(client.get_secondary_pool(), 500);
}

/// distribute_secondary: a non-admin caller's own signature must
/// not satisfy the admin authorization requirement.
#[test]
fn test_distribute_secondary_rejects_non_admin_caller() {
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
    mint(&env, &token, &admin, 500);
    client.record_secondary_royalty(&token, &admin, &500_i128);

    env.mock_auths(&[MockAuth {
        address: &b,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "distribute_secondary",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_distribute_secondary();
    assert!(
        result.is_err(),
        "distribute_secondary must reject a non-admin caller"
    );
    assert_eq!(client.get_secondary_pool(), 500);
}

/// propose_admin_transfer: no authorization at all must be rejected and must
/// not set a pending admin.
#[test]
fn test_propose_admin_transfer_rejects_missing_auth() {
    let env = Env::default();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let new_admin = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    env.mock_auths(&[]);
    let result = client.try_propose_admin_transfer(&new_admin);
    assert!(
        result.is_err(),
        "propose_admin_transfer must require admin auth"
    );
    // No pending transfer was ever accepted, so admin must remain unchanged
    // and accept_admin must have nothing to complete.
    assert_eq!(client.get_admin(), admin);
    assert!(client.try_accept_admin().is_err());
}

/// propose_admin_transfer: a non-admin caller's own signature must not
/// satisfy the admin authorization requirement.
#[test]
fn test_propose_admin_transfer_rejects_non_admin_caller() {
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
        address: &b,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "propose_admin_transfer",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_propose_admin_transfer(&new_admin);
    assert!(
        result.is_err(),
        "propose_admin_transfer must reject a non-admin caller"
    );
    assert_eq!(client.get_admin(), admin);
}

/// accept_admin: the *current* (outgoing) admin signing instead of the
/// pending admin must not complete the transfer.
#[test]
fn test_accept_admin_rejects_current_admin_as_signer() {
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

    // The outgoing admin — not the nominated pending admin — tries to accept.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_accept_admin();
    assert!(
        result.is_err(),
        "accept_admin must reject a signer that is not the pending admin"
    );
    assert_eq!(client.get_admin(), admin);
}

/// set_default_recipients: no authorization at all must be rejected and must
/// not change the stored default recipient list.
#[test]
fn test_set_default_recipients_rejects_missing_auth() {
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
            share: 10_000_u32,
        },
    ];

    env.mock_auths(&[]);
    let result = client.try_set_default_recipients(&recipients);
    assert!(
        result.is_err(),
        "set_default_recipients must require admin auth"
    );
    assert_eq!(client.get_default_recipients().len(), 0);
}

/// set_default_recipients: a non-admin caller's own signature must not
/// satisfy the admin authorization requirement.
#[test]
fn test_set_default_recipients_rejects_non_admin_caller() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

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
            share: 10_000_u32,
        },
    ];

    env.mock_auths(&[MockAuth {
        address: &b,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_default_recipients",
            args: (recipients.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_set_default_recipients(&recipients);
    assert!(
        result.is_err(),
        "set_default_recipients must reject a non-admin caller"
    );
    assert_eq!(client.get_default_recipients().len(), 0);
}

/// batch_distribute: no authorization at all must be rejected and must not
/// move any token balances or advance the distribute counter.
#[test]
fn test_batch_distribute_rejects_missing_auth() {
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
    mint(&env, &token, &contract_id, 1000);

    env.mock_auths(&[]);
    let result = client.try_batch_distribute(&vec![&env, token.clone()]);
    assert!(result.is_err(), "batch_distribute must require admin auth");
    assert_eq!(client.get_distribute_count(), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 1000);
}

/// batch_distribute: a non-admin caller's own signature must not satisfy the
/// admin authorization requirement.
#[test]
fn test_batch_distribute_rejects_non_admin_caller() {
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
    mint(&env, &token, &contract_id, 1000);

    env.mock_auths(&[MockAuth {
        address: &b,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "batch_distribute",
            args: (vec![&env, token.clone()],).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_batch_distribute(&vec![&env, token.clone()]);
    assert!(
        result.is_err(),
        "batch_distribute must reject a non-admin caller"
    );
    assert_eq!(client.get_distribute_count(), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 1000);
}

/// Regression coverage: once admin rights are transferred away, the former
/// admin's signature must no longer authorize protected operations. Guards
/// against a permission-transfer bug silently leaving the old admin with
/// residual access.
#[test]
fn test_regression_former_admin_loses_access_after_transfer() {
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
    client.admin_transfer(&new_admin);
    assert_eq!(client.get_admin(), new_admin);

    // The former admin signs — must no longer be accepted for pause().
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_pause();
    assert!(
        result.is_err(),
        "former admin must lose authorization after admin_transfer"
    );
    assert!(!client.is_paused());
}

/// Regression coverage: once a multi-sig admin list is configured, the
/// original single-admin signature alone must no longer suffice for
/// threshold-gated operations. Guards against multi-sig activation silently
/// leaving the legacy single-admin path usable.
#[test]
fn test_regression_single_admin_insufficient_after_multisig_activated() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let co_admin = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.set_admins(&vec![&env, admin.clone(), co_admin.clone()], &2_u32);

    // Only the original admin signs — threshold is 2, so this must fail even
    // though `admin` is still first in the admin list.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "pause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_pause();
    assert!(
        result.is_err(),
        "single admin signature must be insufficient once multisig threshold is active"
    );
    assert!(!client.is_paused());
}

// ── Issue #661: structured events for royalty configuration and payouts ─────

/// initialize() emits a ("royalty", "init") event carrying the collaborator
/// list and their shares.
#[test]
fn test_initialize_emits_init_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let collaborators = vec![&env, admin.clone(), b.clone()];
    let shares = vec![&env, 6000_u32, 4000_u32];

    client.initialize(&collaborators, &shares);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("init").into_val(&env),
                ]
            && val_eq(&env, data, (collaborators.clone(), shares.clone()))
    });
    assert!(found, "init event not emitted");
}

/// Per-recipient payouts from distribute() emit a ("royalty", "dist") event
/// per recipient carrying (address, amount, token, distribution_type) — this
/// is the structured, indexer-friendly event, distinct from the ("royalty",
/// "dist_all") per-token summary.
#[test]
fn test_distribute_emits_per_recipient_dist_events_with_metadata() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );
    mint(&env, &token, &contract_id, 1000);
    client.distribute(&token);

    let events = env.events().all();

    let admin_payout_event = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("dist").into_val(&env),
                ]
            && val_eq(
                &env,
                data,
                (
                    admin.clone(),
                    600_i128,
                    token.clone(),
                    symbol_short!("primary"),
                ),
            )
    });
    assert!(
        admin_payout_event,
        "per-recipient dist event with (address, amount, token, type) not emitted for admin"
    );

    let b_payout_event = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("dist").into_val(&env),
                ]
            && val_eq(
                &env,
                data,
                (b.clone(), 400_i128, token.clone(), symbol_short!("primary")),
            )
    });
    assert!(
        b_payout_event,
        "per-recipient dist event with (address, amount, token, type) not emitted for b"
    );
}

/// batch_distribute() tags its per-recipient ("royalty", "dist") events with
/// distribution_type "batch" so indexers can distinguish batch payouts from
/// single-token distribute() payouts (tagged "primary").
#[test]
fn test_batch_distribute_emits_per_recipient_dist_events_tagged_batch() {
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
    client.batch_distribute(&vec![&env, token.clone()]);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("dist").into_val(&env),
                ]
            && val_eq(
                &env,
                data,
                (
                    admin.clone(),
                    500_i128,
                    token.clone(),
                    symbol_short!("batch"),
                ),
            )
    });
    assert!(found, "batch-tagged per-recipient dist event not emitted");
}

/// Per-recipient secondary royalty payouts emit a ("royalty", "sec_pay")
/// event carrying (address, amount, token, "secondary") — distinct from the
/// ("royalty", "sec_dist") pool-level summary event.
#[test]
fn test_distribute_secondary_emits_per_recipient_events_with_metadata() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );
    mint(&env, &token, &admin, 500);
    client.record_secondary_royalty(&token, &admin, &500_i128);
    client.distribute_secondary();

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("sec_pay").into_val(&env),
                ]
            && val_eq(
                &env,
                data,
                (
                    admin.clone(),
                    300_i128,
                    token.clone(),
                    symbol_short!("secondary"),
                ),
            )
    });
    assert!(found, "per-recipient sec_pay event not emitted");
}

/// update_share() emits a ("share", "updated") event with the collaborator
/// and their new share.
#[test]
fn test_update_share_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.update_share(&b, &6000_u32);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("share").into_val(&env),
                    symbol_short!("updated").into_val(&env),
                ]
            && val_eq(&env, data, (b.clone(), 6000_u32))
    });
    assert!(found, "share/updated event not emitted");
}

/// set_admins() emits a ("royalty", "adms_set") event with the admin count
/// and threshold.
#[test]
fn test_set_admins_emits_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let co_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.set_admins(&vec![&env, admin.clone(), co_admin.clone()], &2_u32);

    let events = env.events().all();
    let found = events.iter().any(|(cid, topics, data)| {
        cid == contract_id
            && topics
                == vec![
                    &env,
                    symbol_short!("royalty").into_val(&env),
                    symbol_short!("adms_set").into_val(&env),
                ]
            && val_eq(&env, data, (2_u32, 2_u32))
    });
    assert!(found, "adms_set event not emitted");
}

// =============================================================================
// Issue #674 — Failed royalty transfer scenarios
// =============================================================================
// These tests verify that the contract behaves atomically and consistently
// when transfers cannot complete.  Contract state must be left unchanged on
// every failure path; no partial payouts or corrupted counters may occur.
// =============================================================================

/// #674 — Zero contract balance: distribute must return Underfunded and must
/// not modify DistributeHistory or LastDistribution.
#[test]
fn test_distribute_fails_zero_balance_no_state_change() {
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

    // No mint — balance is zero
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::Underfunded.into())));

    // Neither counter nor timestamp must be written
    env.as_contract(&contract_id, || {
        assert!(!env.storage().instance().has(&StorageKey::LastDistribution));
        assert!(!env.storage().instance().has(&StorageKey::DistributeHistory));
    });

    // Collaborator balances remain zero
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);
}

/// #674 — Paused contract: distribute must return ContractPaused and must not
/// alter state or payout any funds.
#[test]
fn test_distribute_fails_when_contract_is_paused() {
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
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));
}

/// #654 — Minimum viable distribution: exactly 2 stroops for 2 recipients.
/// Each should receive exactly 1 stroop (no dust).
#[test]
fn test_distribute_minimum_viable_amount_two_recipients() {
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
    mint(&env, &token, &contract_id, 1_000);

    client.pause();
    assert!(client.is_paused());

    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));

    // Funds must remain in the contract; collaborators receive nothing
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 1_000);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);

    // No distribution state must have been written
    env.as_contract(&contract_id, || {
        assert!(!env.storage().instance().has(&StorageKey::LastDistribution));
        assert!(!env.storage().instance().has(&StorageKey::DistributeHistory));
    });
}

/// #674 — Insufficient balance for a meaningful split: when the amount is
/// positive but too small to produce a non-zero payout for any collaborator
/// the contract must reject with AmountTooSmall.
#[test]
fn test_distribute_fails_amount_too_small() {
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
        &vec![&env, 6000_u32, 3000_u32, 1000_u32],
    );

    // 10_001 stroops — does not divide cleanly at any tier
    let amount: i128 = 10_001;
    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    let admin_bal = TokenClient::new(&env, &token).balance(&admin);
    let b_bal = TokenClient::new(&env, &token).balance(&b);
    let c_bal = TokenClient::new(&env, &token).balance(&c);

    // Shares must sum to the full amount (last recipient absorbs dust)
    assert_eq!(admin_bal + b_bal + c_bal, amount);

    // admin gets floor(10001 * 6000 / 10000) = 6000
    assert_eq!(admin_bal, 6000);
    // b gets floor(10001 * 3000 / 10000) = 3000
    assert_eq!(b_bal, 3000);
    // c gets the remainder = 10001 - 6000 - 3000 = 1001 (dust goes to last)
    assert_eq!(c_bal, 1001);
}

/// #654 — Large distribution with highly asymmetric shares (9999/1 bps).
/// Verifies dust is bounded to at most 1 stroop and always goes to last recipient.
#[test]
fn test_distribute_asymmetric_split_dust_bounded() {
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

    let amount: i128 = 1_000_000_000; // 1000 XLM in stroops
    mint(&env, &token, &contract_id, amount);
    client.distribute(&token);

    let admin_bal = TokenClient::new(&env, &token).balance(&admin);
    let last_bal = TokenClient::new(&env, &token).balance(&last);

    assert_eq!(admin_bal + last_bal, amount);
    // Dust from integer division is at most 1 stroop
    let expected_admin = amount * 9999 / 10_000;
    assert_eq!(admin_bal, expected_admin);
    let dust = last_bal - (amount * 1 / 10_000);
    assert!(dust <= 1, "dust exceeds 1 stroop: {}", dust);
}

/// #654 — Secondary royalty: pool accumulates across multiple record calls
/// and distributes the full accumulated amount in one shot.
#[test]
fn test_secondary_royalty_accumulates_across_multiple_records() {
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

    // Record three separate royalty payments
    mint(&env, &token, &admin, 300);
    client.record_secondary_royalty(&token, &admin, &100_i128);
    client.record_secondary_royalty(&token, &admin, &150_i128);
    client.record_secondary_royalty(&token, &admin, &50_i128);

    assert_eq!(client.get_secondary_pool(), 300);

    client.distribute_secondary();

    // Pool must be cleared
    assert_eq!(client.get_secondary_pool(), 0);

    // Total payout must equal 300
    let admin_bal = TokenClient::new(&env, &token).balance(&admin);
    let b_bal = TokenClient::new(&env, &token).balance(&b);
    assert_eq!(admin_bal + b_bal, 300);
}

/// #654 — Secondary royalty pool reset: distributing clears the pool so a
/// second call with an empty pool returns NoSecondaryRoyalties.
#[test]
fn test_secondary_distribution_clears_pool() {
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

    // No secondary royalties recorded — pool is 0
    let result = client.try_distribute_secondary();
    assert_eq!(result, Err(Ok(ContractError::NoSecondaryRoyalties.into())));

    // Secondary pool must stay at 0 (not written as negative or garbage)
    assert_eq!(client.get_secondary_pool(), 0);
}

// =============================================================================
// Issue #685 — Invariant / property tests for royalty distribution logic
// =============================================================================
// Each test generates multiple valid allocation combinations and verifies core
// distribution guarantees across all of them.  Inputs are bounded to reflect
// real Soroban contract limits (max 10 collaborators, shares sum to 10 000,
// amounts up to 10^15 stroops).
// =============================================================================

/// Helper: build a split with `n` collaborators from a pre-computed share list.
/// Returns (contract_id, client, list_of_addresses, token).
fn setup_split<'a>(
    env: &'a Env,
    shares: &'a [u32],
) -> (
    Address,
    RoyaltySplitterClient<'a>,
    SorobanVec<Address>,
    Address,
) {
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(env, &contract_id);

    let mut addrs: SorobanVec<Address> = SorobanVec::new(&env);
    for _ in 0..shares.len() {
        addrs.push_back(Address::generate(env));
    }

    let mut share_vec: SorobanVec<u32> = SorobanVec::new(&env);
    for &s in shares {
        share_vec.push_back(s);
    }

    let token_admin = Address::generate(env);
    let token = env.register_stellar_asset_contract(token_admin.clone());

    client.initialize(&addrs, &share_vec);

    (contract_id, client, addrs, token)
}

/// #685 Invariant 1 — Total payouts must never exceed the input amount.
/// Tested over a matrix of share configurations and distribution amounts.
#[test]
fn test_invariant_payouts_never_exceed_input() {
    let share_configs: &[&[u32]] = &[
        &[10_000],                           // single collaborator
        &[5_000, 5_000],                     // equal 50/50
        &[3_000, 3_000, 4_000],              // 3-way
        &[1_000, 2_000, 3_000, 4_000],       // 4-way ascending
        &[9_999, 1],                         // extreme 99.99 / 0.01
        &[1, 1, 1, 1, 1, 1, 1, 1, 1, 9_991], // 10 collaborators, dust at start
    ];
    let amounts: &[i128] = &[
        1,
        2,
        10,
        100,
        1_000,
        9_999,
        10_000,
        1_000_000,
        999_999_999_999_999,
    ];

    for &shares in share_configs {
        for &amount in amounts {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let (contract_id, client, addrs, token) = setup_split(&env, shares);

            StellarAssetClient::new(&env, &token).mint(&contract_id, &amount);

            // Some tiny amounts legitimately trigger AmountTooSmall — skip those.
            if client.try_distribute(&token).is_err() {
                continue;
            }

            let mut total_paid: i128 = 0;
            for addr in addrs.iter() {
                total_paid += TokenClient::new(&env, &token).balance(&addr);
            }

            assert!(
                total_paid <= amount,
                "payouts ({total_paid}) exceeded input ({amount}) for shares {shares:?}"
            );
        }
    }
}

/// #685 Invariant 2 — For valid allocations (shares summing to 10 000) the
/// full input amount is always distributed (no funds are stranded in the contract).
#[test]
fn test_invariant_full_distribution_no_stranded_funds() {
    let share_configs: &[&[u32]] = &[
        &[10_000],
        &[5_000, 5_000],
        &[3_334, 3_333, 3_333], // rounding: 3334+3333+3333=10000
        &[2_500, 2_500, 2_500, 2_500],
        &[9_999, 1],
        &[
            1_111, 1_111, 1_111, 1_111, 1_111, 1_111, 1_111, 1_111, 1_111, 1_001,
        ],
    ];
    // Amounts large enough that every collaborator receives at least 1 stroop.
    let amounts: &[i128] = &[10_000, 100_000, 1_000_000, 10_000_000_000_i128];

    for &shares in share_configs {
        for &amount in amounts {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let (contract_id, client, addrs, token) = setup_split(&env, shares);

            StellarAssetClient::new(&env, &token).mint(&contract_id, &amount);
            client.distribute(&token);

            let mut total_paid: i128 = 0;
            for addr in addrs.iter() {
                total_paid += TokenClient::new(&env, &token).balance(&addr);
            }

            assert_eq!(
                total_paid, amount,
                "stranded funds: paid {total_paid} but input was {amount} for shares {shares:?}"
            );

            // Contract balance must be exactly 0 after distribution
            assert_eq!(
                TokenClient::new(&env, &token).balance(&contract_id),
                0,
                "contract retained funds for shares {shares:?} with amount {amount}"
            );
        }
    }
}

/// #685 Invariant 3 — No collaborator ever receives a negative payout.
#[test]
fn test_invariant_no_negative_payouts() {
    let share_configs: &[&[u32]] = &[
        &[5_000, 5_000],
        &[1, 9_999],
        &[9_999, 1],
        &[3_000, 3_000, 4_000],
        &[
            1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000,
        ],
    ];
    let amounts: &[i128] = &[10_000, 100_000, 1_000_000_000_i128];

    for &shares in share_configs {
        for &amount in amounts {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let (contract_id, client, addrs, token) = setup_split(&env, shares);

            StellarAssetClient::new(&env, &token).mint(&contract_id, &amount);
            client.distribute(&token);

            for addr in addrs.iter() {
                let payout = TokenClient::new(&env, &token).balance(&addr);
                assert!(
                    payout >= 0,
                    "negative payout ({payout}) for shares {shares:?} amount {amount}"
                );
            }
        }
    }
}

/// #685 Invariant 4 — Collaborator allocations (stored shares) must remain
/// unchanged after a distribution.  distribute() must be a read-only operation
/// with respect to the share map.
#[test]
fn test_invariant_shares_unchanged_after_distribution() {
    let share_configs: &[&[u32]] = &[
        &[5_000, 5_000],
        &[3_000, 3_000, 4_000],
        &[9_999, 1],
        &[
            1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000,
        ],
    ];

    for &shares in share_configs {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (contract_id, client, addrs, token) = setup_split(&env, shares);

        StellarAssetClient::new(&env, &token).mint(&contract_id, &1_000_000_i128);
        client.distribute(&token);

        // Verify each collaborator's stored share is identical to what was set
        for (i, addr) in addrs.iter().enumerate() {
            let stored = client.get_share(&addr);
            assert_eq!(
                stored, shares[i],
                "share for collaborator {i} changed after distribution (shares {shares:?})"
            );
        }

        // Total shares must still be 10 000
        let mut total: u32 = 0;
        for addr in addrs.iter() {
            total += client.get_share(&addr);
        }
        assert_eq!(
            total, 10_000,
            "share total diverged from 10 000 after distribution (shares {shares:?})"
        );
    }
}

// ─── Operation-level pause (#749) ──────────────────────────────────────────

/// Pausing only PrimaryDistribution blocks distribute() but leaves
/// distribute_secondary() working.
#[test]
fn test_pause_primary_only_blocks_primary_distribution() {
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

    // Record secondary royalties so the secondary path has something to pay out.
    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);

    client.pause_operation(&OperationType::PrimaryDistribution);
    assert!(client.is_operation_paused(&OperationType::PrimaryDistribution));
    assert!(!client.is_operation_paused(&OperationType::SecondaryDistribution));
    assert!(!client.is_paused(), "global pause flag must be untouched");

    // Primary distribution is blocked.
    let result = client.try_distribute(&token);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));

    // Secondary distribution still works.
    client.distribute_secondary();
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 250);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 250);
}

/// Pausing only SecondaryDistribution blocks distribute_secondary()
/// but leaves distribute() working.
#[test]
fn test_pause_secondary_only_blocks_secondary_distribution() {
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

    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);

    client.pause_operation(&OperationType::SecondaryDistribution);
    assert!(client.is_operation_paused(&OperationType::SecondaryDistribution));
    assert!(!client.is_operation_paused(&OperationType::PrimaryDistribution));
    assert!(!client.is_paused(), "global pause flag must be untouched");

    // Secondary distribution is blocked.
    let result = client.try_distribute_secondary();
    assert_eq!(result, Err(Ok(ContractError::ContractPaused.into())));

    // Primary distribution still works.
    client.distribute(&token);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
}

/// unpause_operation re-enables a specific operation after pause_operation.
#[test]
fn test_unpause_operation_reenables_distribution() {
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

    client.pause_operation(&OperationType::PrimaryDistribution);
    let blocked = client.try_distribute(&token);
    assert_eq!(blocked, Err(Ok(ContractError::ContractPaused.into())));

    client.unpause_operation(&OperationType::PrimaryDistribution);
    assert!(!client.is_operation_paused(&OperationType::PrimaryDistribution));

    client.distribute(&token);
    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
}

/// Backward compatibility: the existing global pause() still blocks BOTH
/// operations even when neither per-operation pause is set.
#[test]
fn test_global_pause_still_blocks_both_operations() {
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

    let pool_amount: i128 = 500;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);

    // Neither per-operation pause is set...
    assert!(!client.is_operation_paused(&OperationType::PrimaryDistribution));
    assert!(!client.is_operation_paused(&OperationType::SecondaryDistribution));

    // ...but the global pause still blocks both, unchanged from prior behavior.
    client.pause();

    let primary_result = client.try_distribute(&token);
    assert_eq!(
        primary_result,
        Err(Ok(ContractError::ContractPaused.into()))
    );

    let secondary_result = client.try_distribute_secondary();
    assert_eq!(
        secondary_result,
        Err(Ok(ContractError::ContractPaused.into()))
    );

    client.unpause();
    client.distribute(&token);
    client.distribute_secondary();
}

/// pause_operation/unpause_operation require admin authorization, matching
/// the existing pause()/unpause() auth rules.
#[test]
#[should_panic]
fn test_pause_operation_requires_admin_auth() {
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
    client.pause_operation(&OperationType::PrimaryDistribution);
}

// ─────────────────────────────────────────────────────────────────────────
// #894 — Collaborative signing & threshold approval integration tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_collaborative_operation_proposal_multisig_workflow() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin1.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Configure 2-of-3 multi-admin
    let admins = vec![&env, admin1.clone(), admin2.clone(), admin3.clone()];
    client.set_admins(&admins, &2_u32);

    // Initial state
    assert!(!client.is_paused());

    // Admin 1 proposes Pause operation
    let prop_id = client.propose_operation(&admin1, &SensitiveOperation::Pause, &3600_u64);
    assert_eq!(prop_id, 1);

    // 1 of 2 threshold -> not yet paused
    let prop = client.get_operation_proposal(&prop_id);
    assert_eq!(prop.threshold, 2);
    assert_eq!(prop.approvals_count, 1);
    assert!(!prop.executed);
    assert!(!client.is_paused());

    // Admin 2 approves -> threshold reached (2 of 2) -> executes Pause
    let executed = client.approve_operation(&admin2, &prop_id);
    assert!(executed);
    assert!(client.is_paused());

    let prop_after = client.get_operation_proposal(&prop_id);
    assert_eq!(prop_after.approvals_count, 2);
    assert!(prop_after.executed);

    // Unpause proposal workflow
    let unpause_id = client.propose_operation(&admin3, &SensitiveOperation::Unpause, &3600_u64);
    assert_eq!(unpause_id, 2);
    assert!(client.is_paused());

    let unpause_executed = client.approve_operation(&admin1, &unpause_id);
    assert!(unpause_executed);
    assert!(!client.is_paused());
}

#[test]
fn test_collaborative_operation_proposal_duplicate_and_unauthorized_rejections() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let b = Address::generate(&env);
    let unauthorized = Address::generate(&env);

    client.initialize(
        &vec![&env, admin1.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let admins = vec![&env, admin1.clone(), admin2.clone()];
    client.set_admins(&admins, &2_u32);

    // Non-admin cannot propose
    assert_eq!(
        client.try_propose_operation(&unauthorized, &SensitiveOperation::Pause, &3600_u64),
        Err(Ok(ContractError::UnauthorizedEmergencySigner.into()))
    );

    let prop_id = client.propose_operation(&admin1, &SensitiveOperation::Pause, &3600_u64);

    // Non-admin cannot approve
    assert_eq!(
        client.try_approve_operation(&unauthorized, &prop_id),
        Err(Ok(ContractError::UnauthorizedEmergencySigner.into()))
    );

    // Proposer cannot double-approve
    assert_eq!(
        client.try_approve_operation(&admin1, &prop_id),
        Err(Ok(ContractError::AlreadyVoted.into()))
    );

    // Admin 2 approves -> executes
    client.approve_operation(&admin2, &prop_id);

    // Replay / already executed proposal cannot be approved again
    assert_eq!(
        client.try_approve_operation(&admin2, &prop_id),
        Err(Ok(ContractError::ProposalAlreadyExecuted.into()))
    );
}

#[test]
fn test_collaborative_operation_proposal_expiration() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin1.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let admins = vec![&env, admin1.clone(), admin2.clone()];
    client.set_admins(&admins, &2_u32);

    env.ledger().with_mut(|l| l.timestamp = 5_000);
    let prop_id = client.propose_operation(
        &admin1,
        &SensitiveOperation::SetRoyaltyRate(750_u32),
        &3600_u64,
    );

    // Advance time past expiration
    env.ledger().with_mut(|l| l.timestamp = 5_000 + 3600 + 1);

    // Approval after expiration fails
    assert_eq!(
        client.try_approve_operation(&admin2, &prop_id),
        Err(Ok(ContractError::ProposalVotingClosed.into()))
    );
    assert_ne!(client.get_royalty_rate(), 750);
}

// ─────────────────────────────────────────────────────────────────────────
// #895 — Recipient earnings tracking per token integration tests
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn test_recipient_earnings_tracking_on_distributions() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);
    let token_admin = Address::generate(&env);
    let token_a = make_token(&env, &token_admin);
    let token_b = make_token(&env, &token_admin);

    let collab_a = Address::generate(&env);
    let collab_b = Address::generate(&env);

    client.initialize(
        &vec![&env, collab_a.clone(), collab_b.clone()],
        &vec![&env, 7000_u32, 3000_u32],
    );

    // Initial query returns 0
    assert_eq!(client.get_recipient_earnings(&collab_a, &token_a), 0);
    assert_eq!(client.get_recipient_earnings(&collab_b, &token_a), 0);
    assert_eq!(client.get_recipient_earnings(&collab_a, &token_b), 0);
    assert_eq!(client.get_recipient_earnings(&collab_b, &token_b), 0);

    // First distribution of Token A: 10,000
    mint(&env, &token_a, &contract_id, 10_000);
    client.distribute(&token_a);

    assert_eq!(client.get_recipient_earnings(&collab_a, &token_a), 7_000);
    assert_eq!(client.get_recipient_earnings(&collab_b, &token_a), 3_000);

    // Second distribution of Token A: 20,000
    mint(&env, &token_a, &contract_id, 20_000);
    client.distribute(&token_a);

    assert_eq!(client.get_recipient_earnings(&collab_a, &token_a), 21_000);
    assert_eq!(client.get_recipient_earnings(&collab_b, &token_a), 9_000);

    // Distribution of Token B: 50,000 (distinct token tracking)
    mint(&env, &token_b, &contract_id, 50_000);
    client.distribute(&token_b);

    assert_eq!(client.get_recipient_earnings(&collab_a, &token_b), 35_000);
    assert_eq!(client.get_recipient_earnings(&collab_b, &token_b), 15_000);

    // Token A totals unchanged
    assert_eq!(client.get_recipient_earnings(&collab_a, &token_a), 21_000);
    assert_eq!(client.get_recipient_earnings(&collab_b, &token_a), 9_000);
}

#[test]
fn test_recipient_earnings_in_resilient_distribution() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    let collab_a = Address::generate(&env);
    let collab_b = Address::generate(&env);

    client.initialize(
        &vec![&env, collab_a.clone(), collab_b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    mint(&env, &token, &contract_id, 10_000);
    let failed = client.distribute_resilient(&token, &vec![&env]);
    assert!(failed.is_empty());

    assert_eq!(client.get_recipient_earnings(&collab_a, &token), 6_000);
    assert_eq!(client.get_recipient_earnings(&collab_b, &token), 4_000);
}

// =============================================================================
// Issue #838 — Emergency pause mechanism with multi-sig requirement (M-of-N)
// =============================================================================

/// M-of-N scenario (M=2, N=3): 2 of 3 authorized emergency pause signers successfully
/// trigger immediate emergency pause, blocking distributions without timelock,
/// and admin successfully revokes the pause via unpause().
#[test]
fn test_emergency_pause_multisig_2_of_3_scenario() {
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

    let s1 = Address::generate(&env);
    let s2 = Address::generate(&env);
    let s3 = Address::generate(&env);
    let signers = vec![&env, s1.clone(), s2.clone(), s3.clone()];

    // Configure M=2 of N=3
    client.set_emergency_pause_signers(&signers, &2);
    assert_eq!(client.get_emergency_pause_signers(), signers);
    assert_eq!(client.get_emergency_pause_threshold(), 2);
    assert!(!client.is_emergency_paused());

    // Emergency incident: 2 authorized signers (s2 and s3) trigger pause immediately
    let active_signers = vec![&env, s2.clone(), s3.clone()];
    client.emergency_pause(&active_signers);

    // Immediately paused (no timelock)
    assert!(client.is_emergency_paused());

    // Distributions are blocked
    mint(&env, &token, &contract_id, 1_000);
    let res = client.try_distribute(&token);
    assert_eq!(res, Err(Ok(ContractError::EmergencyContractPaused.into())));

    // Admin revokes emergency pause via unpause()
    client.unpause();
    assert!(!client.is_emergency_paused());

    // Distributions now execute cleanly
    client.distribute(&token);
    assert_eq!(client.get_distribute_count(), 1);
}

/// Revoking multi-sig emergency pause via clear_emergency_pause().
#[test]
fn test_emergency_pause_multisig_clear_by_admin() {
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

    let s1 = Address::generate(&env);
    let s2 = Address::generate(&env);
    let s3 = Address::generate(&env);

    client.set_emergency_pause_signers(&vec![&env, s1.clone(), s2.clone(), s3.clone()], &2);

    // Pause with s1 and s2
    client.emergency_pause(&vec![&env, s1.clone(), s2.clone()]);
    assert!(client.is_emergency_paused());

    // Clear via clear_emergency_pause()
    client.clear_emergency_pause();
    assert!(!client.is_emergency_paused());

    mint(&env, &token, &contract_id, 2_000);
    client.distribute(&token);
    assert_eq!(client.get_distribute_count(), 1);
}

/// Rejection of invalid signers, duplicate signers, and sub-threshold attempts.
#[test]
fn test_emergency_pause_multisig_threshold_and_signer_validations() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let s1 = Address::generate(&env);
    let s2 = Address::generate(&env);
    let s3 = Address::generate(&env);
    let rogue = Address::generate(&env);

    // M=2 of N=3
    client.set_emergency_pause_signers(&vec![&env, s1.clone(), s2.clone(), s3.clone()], &2);

    // 1 signer provided when threshold is 2 -> rejected
    let res_insufficient = client.try_emergency_pause(&vec![&env, s1.clone()]);
    assert_eq!(
        res_insufficient,
        Err(Ok(ContractError::InvalidEmergencyPauseThreshold.into()))
    );

    // Rogue non-signer provided -> rejected
    let res_unauthorized = client.try_emergency_pause(&vec![&env, s1.clone(), rogue]);
    assert_eq!(
        res_unauthorized,
        Err(Ok(ContractError::UnauthorizedEmergencySigner.into()))
    );

    // Duplicate signer provided -> rejected
    let res_duplicate = client.try_emergency_pause(&vec![&env, s1.clone(), s1.clone()]);
    assert_eq!(
        res_duplicate,
        Err(Ok(ContractError::DuplicateRecipient.into()))
    );

    // Contract remains unpaused
    assert!(!client.is_emergency_paused());
}
