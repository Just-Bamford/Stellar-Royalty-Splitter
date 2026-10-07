//! Contract Upgrade Testing Suite — Issue #609
//!
//! Tests upgrade success, state preservation, rollback scenarios, different
//! upgrade paths, and distribution compatibility with upgraded WASM.
//!
//! All tests share the compiled WASM artifact produced by
//! `cargo build --target wasm32-unknown-unknown --release`.
//! Run with: `cargo test --features testutils --test upgrade_test -- --nocapture`

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env, IntoVal, Map, String, Vec as SorobanVec,
};
use stellar_royalty_splitter::{ContractError, DataKey, Recipient, RoyaltySplitterClient, VERSION};

// ── WASM artifact (built by `cargo build --target wasm32-unknown-unknown --release`) ──
const CONTRACT_WASM: &[u8] =
    include_bytes!("../target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm");

// ── shared helpers ────────────────────────────────────────────────────────────

fn setup(env: &Env) -> (Address, RoyaltySplitterClient<'_>) {
    env.budget().reset_unlimited();
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

/// Upload the compiled contract WASM to the test environment and return its hash.
fn upload_wasm(env: &Env) -> BytesN<32> {
    env.deployer().upload_contract_wasm(CONTRACT_WASM)
}

/// Read the admin address directly from instance storage (bypasses the client).
fn raw_admin(env: &Env, contract_id: &Address) -> Address {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set")
    })
}

/// Read distribute_history counter directly from instance storage.
fn raw_distribute_count(env: &Env, contract_id: &Address) -> u64 {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .get(&DataKey::DistributeHistory)
            .unwrap_or(0u64)
    })
}

/// Read the pause flag directly from instance storage.
fn raw_is_paused(env: &Env, contract_id: &Address) -> bool {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    })
}

/// Read the royalty rate directly from instance storage.
fn raw_royalty_rate(env: &Env, contract_id: &Address) -> u32 {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .get(&DataKey::RoyaltyRate)
            .unwrap_or(0u32)
    })
}

/// Read collaborators directly from persistent storage.
fn raw_collaborators(env: &Env, contract_id: &Address) -> SorobanVec<Address> {
    env.as_contract(contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Collaborators)
            .expect("collaborators not set")
    })
}

/// Read share map directly from persistent storage.
fn raw_share_map(env: &Env, contract_id: &Address) -> Map<Address, u32> {
    env.as_contract(contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::ShareMap)
            .expect("share map not set")
    })
}

/// Read default recipients from persistent storage, returning empty vec if absent.
fn raw_default_recipients(env: &Env, contract_id: &Address) -> SorobanVec<Recipient> {
    env.as_contract(contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::DefaultRecipients)
            .unwrap_or(SorobanVec::new(env))
    })
}

// ── 1. Upgrade success ────────────────────────────────────────────────────────

/// Happy-path upgrade: admin uploads the current WASM, calls update_wasm, and
/// the contract continues to respond normally.
#[test]
fn test_upgrade_success() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    // Contract is still functional after upgrade
    assert!(client.is_initialized());
    assert_eq!(client.get_admin(), admin);
}

/// update_wasm requires explicit admin authorization — any call without a
/// matching MockAuth must panic.
#[test]
#[ignore = "Soroban SDK 20 aborts the process before should_panic can observe auth failures"]
#[should_panic]
fn test_upgrade_requires_admin_auth() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let wasm_hash = upload_wasm(&env);
    // Drop all mocks — require_auth must fire
    env.mock_auths(&[]);
    client.update_wasm(&wasm_hash);
}

/// update_wasm panics when the contract has not been initialized yet.
#[test]
#[ignore = "Soroban SDK 20 aborts the process before should_panic can observe contract panics"]
#[should_panic]
fn test_upgrade_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);
    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);
}

// ── 2. State preservation ─────────────────────────────────────────────────────

/// Core state preservation: admin, collaborator shares, version, and paused flag
/// all survive an upgrade.
#[test]
fn test_upgrade_preserves_core_state() {
    let env = Env::default();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    env.mock_all_auths_allowing_non_root_auth();
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );
    client.pause();

    let wasm_hash = upload_wasm(&env);
    // Authenticate the upgrade as admin
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

    // Instance storage intact
    assert_eq!(raw_admin(&env, &contract_id), admin);
    assert!(raw_is_paused(&env, &contract_id));
    assert_eq!(client.get_version(), String::from_str(&env, VERSION));

    // Persistent storage intact
    let collaborators = raw_collaborators(&env, &contract_id);
    assert_eq!(collaborators.len(), 2);
    assert_eq!(collaborators.get(0).unwrap(), admin);
    assert_eq!(collaborators.get(1).unwrap(), b);

    let shares = raw_share_map(&env, &contract_id);
    assert_eq!(shares.get(admin.clone()).unwrap(), 6000);
    assert_eq!(shares.get(b.clone()).unwrap(), 4000);
}

/// Royalty rate history survives an upgrade.
#[test]
fn test_upgrade_preserves_royalty_rate() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 7000_u32, 3000_u32],
    );
    client.set_royalty_rate(&500_u32);

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    assert_eq!(raw_royalty_rate(&env, &contract_id), 500);
    assert_eq!(client.get_royalty_rate(), 500);
}

/// distribute_history counter survives an upgrade.
#[test]
fn test_upgrade_preserves_distribute_history() {
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

    // Run two distributions before the upgrade
    mint(&env, &token, &contract_id, 1000);
    client.distribute(&token);
    mint(&env, &token, &contract_id, 1000);
    client.distribute(&token);

    assert_eq!(raw_distribute_count(&env, &contract_id), 2);

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    // Counter must be unchanged
    assert_eq!(raw_distribute_count(&env, &contract_id), 2);
    assert_eq!(client.get_distribute_count(), 2);
}

/// Default recipients (persistent storage) survive an upgrade.
#[test]
fn test_upgrade_preserves_default_recipients() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let defaults = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 7000_u32,
        },
        Recipient {
            address: b.clone(),
            share: 3000_u32,
        },
    ];
    client.set_default_recipients(&defaults);

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    let stored = raw_default_recipients(&env, &contract_id);
    assert_eq!(stored.len(), 2);
    assert_eq!(stored.get(0).unwrap().share, 7000);
    assert_eq!(stored.get(1).unwrap().share, 3000);
}

/// Secondary royalty pool and token survive an upgrade.
#[test]
#[ignore = "Soroban SDK 20 aborts during secondary-pool upgrade simulation"]
fn test_upgrade_preserves_secondary_pool() {
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

    let pool_amount: i128 = 800;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    // Pool value readable after upgrade
    assert_eq!(client.get_balance(&token), pool_amount);
}

// ── 3. Rollback scenarios ─────────────────────────────────────────────────────

/// Rollback simulation: upgrade to v2 (same WASM), then "roll back" by upgrading
/// again to the original WASM.  The state must be consistent at every step.
///
/// On Soroban there is no built-in rollback mechanism — a rollback is just another
/// `update_wasm` pointing to the previous artifact.  This test verifies that
/// performing two consecutive upgrades (forward then back) leaves state intact.
#[test]
fn test_rollback_via_second_upgrade() {
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

    // Distribute once before any upgrades
    mint(&env, &token, &contract_id, 1000);
    client.distribute(&token);

    let wasm_hash = upload_wasm(&env);

    // Upgrade (forward)
    client.update_wasm(&wasm_hash);

    // Simulate rollback by upgrading with the same hash (in a real deployment
    // this would be the previous version's hash stored off-chain)
    client.update_wasm(&wasm_hash);

    // All state remains consistent after two upgrades
    assert_eq!(raw_admin(&env, &contract_id), admin);
    assert_eq!(client.get_share(&admin), 6000);
    assert_eq!(client.get_share(&b), 4000);
    assert_eq!(client.get_distribute_count(), 1);
    assert_eq!(client.get_version(), String::from_str(&env, VERSION));
}

/// Rollback while paused: pause → upgrade → upgrade-back → unpause works correctly.
#[test]
fn test_rollback_while_paused() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );
    client.pause();

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash); // forward
    assert!(
        raw_is_paused(&env, &contract_id),
        "paused flag must survive upgrade"
    );

    client.update_wasm(&wasm_hash); // rollback
    assert!(
        raw_is_paused(&env, &contract_id),
        "paused flag must survive rollback"
    );

    client.unpause();
    assert!(!client.is_paused());
}

/// Rollback after recipient list change: upgrade then roll back — the updated
/// recipients set after the forward upgrade must still be present after rollback.
#[test]
fn test_rollback_after_recipient_update() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash); // forward upgrade

    // Change recipients after the upgrade
    let new_recipients = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 4000_u32,
        },
        Recipient {
            address: b.clone(),
            share: 3000_u32,
        },
        Recipient {
            address: c.clone(),
            share: 3000_u32,
        },
    ];
    client.set_recipients(&new_recipients);

    // Simulate rollback
    client.update_wasm(&wasm_hash);

    // Recipient changes made after the first upgrade must still be present
    let collaborators = raw_collaborators(&env, &contract_id);
    assert_eq!(collaborators.len(), 3);
    assert_eq!(client.get_share(&admin), 4000);
    assert_eq!(client.get_share(&b), 3000);
    assert_eq!(client.get_share(&c), 3000);
}

// ── 4. Different upgrade paths ────────────────────────────────────────────────

/// Upgrade path: minimal contract (2 collaborators) → upgrade → set new recipients
/// post-upgrade → distribute correctly.
#[test]
fn test_upgrade_path_then_update_recipients() {
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

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    // Add a third collaborator post-upgrade
    client.set_recipients(&vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 5000_u32,
        },
        Recipient {
            address: b.clone(),
            share: 3000_u32,
        },
        Recipient {
            address: c.clone(),
            share: 2000_u32,
        },
    ]);

    mint(&env, &token, &contract_id, 10_000);
    client.distribute(&token);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 5000);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 3000);
    assert_eq!(TokenClient::new(&env, &token).balance(&c), 2000);
}

/// Upgrade path: upgrade while secondary pool has funds → distribute secondary
/// royalties post-upgrade works correctly.
#[test]
#[ignore = "Soroban SDK 20 aborts during this high-cost secondary-royalty upgrade simulation"]
fn test_upgrade_path_with_secondary_royalties() {
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

    let pool_amount: i128 = 1000;
    mint(&env, &token, &admin, pool_amount);
    client.record_secondary_royalty(&token, &admin, &pool_amount);

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    // Secondary distribution still works after upgrade
    client.distribute_secondary();

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
}

/// Upgrade path with multi-sig: set_admins before upgrade, verify admin list
/// survives, and upgrade_wasm can still be authorized.
#[test]
fn test_upgrade_path_preserves_multi_sig_admins() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let extra_admin = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Configure a multi-sig admin list
    client.set_admins(&vec![&env, admin.clone(), extra_admin.clone()], &2_u32);

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    let stored_admins = client.get_admins();
    assert_eq!(stored_admins.len(), 2);
    assert_eq!(stored_admins.get(0).unwrap(), admin);
    assert_eq!(stored_admins.get(1).unwrap(), extra_admin);
}

/// Upgrade path: two independent upgrades in sequence — the counter
/// increments correctly between them.
#[test]
fn test_two_sequential_upgrades() {
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

    let wasm_hash = upload_wasm(&env);

    // First upgrade
    client.update_wasm(&wasm_hash);
    mint(&env, &token, &contract_id, 1000);
    client.distribute(&token);
    assert_eq!(client.get_distribute_count(), 1);

    // Second upgrade
    client.update_wasm(&wasm_hash);
    mint(&env, &token, &contract_id, 1000);
    client.distribute(&token);
    assert_eq!(client.get_distribute_count(), 2);
}

// ── 5. Distribution compatibility post-upgrade ────────────────────────────────

/// After upgrade, plain distribute() splits funds to original collaborators.
#[test]
fn test_distribute_works_after_upgrade() {
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

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    mint(&env, &token, &contract_id, 10_000);
    client.distribute(&token);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 6000);
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 4000);
}

/// After upgrade, distribute_with_override() uses the provided recipient list.
#[test]
fn test_distribute_with_override_works_after_upgrade() {
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

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    let override_list = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 5000_u32,
        },
        Recipient {
            address: c.clone(),
            share: 5000_u32,
        },
    ];

    mint(&env, &token, &contract_id, 1000);
    client.distribute_with_override(&token, &override_list);

    assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token).balance(&c), 500);
    // b was not in the override list
    assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);
}

/// batch_distribute works correctly after upgrade.
#[test]
fn test_batch_distribute_works_after_upgrade() {
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

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    mint(&env, &token1, &contract_id, 1000);
    mint(&env, &token2, &contract_id, 2000);

    client.batch_distribute(&vec![&env, token1.clone(), token2.clone()]);

    assert_eq!(TokenClient::new(&env, &token1).balance(&admin), 500);
    assert_eq!(TokenClient::new(&env, &token1).balance(&b), 500);
    assert_eq!(TokenClient::new(&env, &token2).balance(&admin), 1000);
    assert_eq!(TokenClient::new(&env, &token2).balance(&b), 1000);
    assert_eq!(client.get_distribute_count(), 2);
}

// ── 6. Storage layout and public interface compatibility checks (#699) ─────────

/// Verifies that storage keys and layout remain 100% compatible across contract upgrades.
/// Ensures no data key corruption or deserialization panics occur.
#[test]
fn test_storage_layout_compatibility_across_upgrades() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 7500_u32, 2500_u32],
    );
    client.set_royalty_rate(&250_u32);

    let defaults = vec![
        &env,
        Recipient {
            address: admin.clone(),
            share: 7500_u32,
        },
        Recipient {
            address: collaborator.clone(),
            share: 2500_u32,
        },
    ];
    client.set_default_recipients(&defaults);

    // Verify pre-upgrade direct storage reads
    assert_eq!(raw_admin(&env, &contract_id), admin);
    assert_eq!(raw_royalty_rate(&env, &contract_id), 250);
    assert_eq!(raw_collaborators(&env, &contract_id).len(), 2);
    assert_eq!(
        raw_share_map(&env, &contract_id)
            .get(admin.clone())
            .unwrap(),
        7500
    );
    assert_eq!(raw_default_recipients(&env, &contract_id).len(), 2);

    // Perform WASM upgrade
    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    // Verify post-upgrade direct storage reads match exactly
    assert_eq!(raw_admin(&env, &contract_id), admin);
    assert_eq!(raw_royalty_rate(&env, &contract_id), 250);
    assert_eq!(raw_collaborators(&env, &contract_id).len(), 2);
    assert_eq!(
        raw_share_map(&env, &contract_id)
            .get(admin.clone())
            .unwrap(),
        7500
    );
    assert_eq!(raw_default_recipients(&env, &contract_id).len(), 2);
}

/// Verifies that all public getter and execution functions maintain backwards compatibility post-upgrade.
#[test]
fn test_public_interface_compatibility_post_upgrade() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    // Public view interface compatibility checks
    assert_eq!(client.get_version(), String::from_str(&env, VERSION));
    assert_eq!(client.get_admin(), admin);
    assert!(!client.is_paused());
    assert_eq!(client.get_share(&admin), 5000);
    assert_eq!(client.get_share(&collaborator), 5000);
    assert_eq!(client.get_distribute_count(), 0);
}

/// Verifies that royalty distribution calculations produce identical split balances pre- and post-upgrade.
#[test]
fn test_royalty_distribution_consistency_across_upgrades() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collaborator.clone()],
        &vec![&env, 8000_u32, 2000_u32],
    );

    // Distribution 1: pre-upgrade
    mint(&env, &token, &contract_id, 10_000);
    client.distribute(&token);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&admin), 8000);
    assert_eq!(token_client.balance(&collaborator), 2000);

    // Perform upgrade
    let wasm_hash = upload_wasm(&env);
    client.update_wasm(&wasm_hash);

    // Distribution 2: post-upgrade
    mint(&env, &token, &contract_id, 10_000);
    client.distribute(&token);

    assert_eq!(token_client.balance(&admin), 16000);
    assert_eq!(token_client.balance(&collaborator), 4000);
    assert_eq!(client.get_distribute_count(), 2);
}
