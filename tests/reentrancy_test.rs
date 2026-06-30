/// Re-entrancy and concurrent-initialization protection tests (#477)
///
/// The Soroban runtime is single-threaded and fully deterministic — true
/// concurrent execution is impossible at the protocol level. However, an
/// attacker can attempt to bypass the one-time initialization guard through
/// several vectors:
///
///   1. Calling `initialize` a second time directly (most obvious path).
///   2. Calling `commit_initialize` after the contract is already live.
///   3. Calling `reveal_initialize` after the contract is already live.
///   4. Calling `commit_initialize` twice (double-commit) to overwrite pending state.
///   5. Calling `reveal_initialize` without a prior commit (NoPendingCommit).
///   6. Manipulating storage directly between calls to bypass the guard.
///   7. Verifying that state written during the *rejected* call is not persisted.
///   8. Verifying the `init` event is emitted exactly once, not on failed attempts.
///
/// The re-entrancy guard is: `env.storage().instance().has(&StorageKey::Admin)`.
/// Every path through `apply_initialize` checks this first, so as long as the
/// storage write is atomic and the check is before the write, the contract is safe.
///
/// Note: On Windows, `#[should_panic]` auth tests behave differently due to how
/// the Soroban test environment handles mock authorizations. Tests that verify
/// unauthorized access are guarded with `#[cfg(not(target_os = "windows"))]`.
#[cfg(test)]
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events},
    vec, Address, BytesN, Env, IntoVal,
};
use stellar_royalty_splitter::{ContractError, RoyaltySplitterClient, StorageKey, VERSION};
use soroban_sdk::String as SorobanString;

fn setup(env: &Env) -> (Address, RoyaltySplitterClient) {
    let contract_id =
        env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(env, &contract_id);
    (contract_id, client)
}

// ── Scenario 1: Direct double-initialize ──────────────────────────────────

/// The most direct re-initialization attempt: calling `initialize` a second
/// time with different collaborators must be rejected with `AlreadyInitialized`.
/// The original state must remain intact.
#[test]
fn test_direct_reinitialize_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    // First call — must succeed
    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 6000_u32, 4000_u32],
    );
    assert_eq!(client.get_share(&admin), 6000);
    assert_eq!(client.get_share(&b), 4000);

    // Second call — must return AlreadyInitialized
    let attacker = Address::generate(&env);
    let result = client.try_initialize(
        &vec![&env, attacker.clone(), admin.clone()],
        &vec![&env, 9000_u32, 1000_u32],
    );
    assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));

    // Original shares must be unchanged
    assert_eq!(client.get_share(&admin), 6000);
    assert_eq!(client.get_share(&b), 4000);
}

// ── Scenario 2: Repeated re-initialize attempts all fail ──────────────────

/// Multiple sequential re-initialization attempts must all fail. This validates
/// that the guard is consistent across repeated calls, not just the first retry.
#[test]
fn test_repeated_reinitialize_all_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Three separate re-init attempts — each must fail
    for _ in 0..3 {
        let attacker = Address::generate(&env);
        let result = client.try_initialize(
            &vec![&env, attacker.clone(), admin.clone()],
            &vec![&env, 5000_u32, 5000_u32],
        );
        assert_eq!(
            result,
            Err(Ok(ContractError::AlreadyInitialized)),
            "each re-init attempt must return AlreadyInitialized"
        );
    }

    // State still intact after all rejections
    assert_eq!(client.get_share(&admin), 5000);
    assert_eq!(client.get_share(&b), 5000);
    assert_eq!(client.collaborator_count(), 2);
}

// ── Scenario 3: Storage state consistency after rejected attempt ───────────

/// After a rejected re-initialization, the contract's storage state must be
/// identical to what it was immediately after the first successful initialize.
/// No partial writes from the rejected call must persist.
#[test]
fn test_storage_state_consistent_after_rejected_reinit() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    // Initialize with 3 collaborators
    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 5000_u32, 3000_u32, 2000_u32],
    );

    // Attempt re-init with completely different collaborators and shares
    let attacker = Address::generate(&env);
    let d = Address::generate(&env);
    let _ = client.try_initialize(
        &vec![&env, attacker.clone(), d.clone()],
        &vec![&env, 9900_u32, 100_u32],
    );

    // Verify all original storage entries are unchanged
    assert_eq!(client.get_share(&admin), 5000, "admin share must be unchanged");
    assert_eq!(client.get_share(&b), 3000, "b share must be unchanged");
    assert_eq!(client.get_share(&c), 2000, "c share must be unchanged");
    assert_eq!(client.collaborator_count(), 3, "collaborator count must be unchanged");

    // Verify attacker/d were NOT written to storage
    env.as_contract(&contract_id, || {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("admin must still be stored");
        assert_eq!(stored_admin, admin, "admin must not have been replaced");
    });

    // Verify version was not overwritten
    assert_eq!(
        client.get_version(),
        SorobanString::from_str(&env, VERSION),
        "contract version must be unchanged"
    );
}

// ── Scenario 4: commit_initialize blocked after contract is live ──────────

/// Once `initialize` succeeds, `commit_initialize` must also be rejected.
/// This prevents an attacker from overwriting the pending commit slot while
/// the contract is already initialized.
#[test]
fn test_commit_initialize_blocked_after_init() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Fake commit hashes
    let hash = BytesN::from_array(&env, &[0u8; 32]);
    let nonce = BytesN::from_array(&env, &[1u8; 32]);

    let result = client.try_commit_initialize(&admin, &hash, &hash, &nonce);
    assert_eq!(
        result,
        Err(Ok(ContractError::AlreadyInitialized)),
        "commit_initialize must be blocked when contract is already initialized"
    );
}

// ── Scenario 5: reveal_initialize blocked after contract is live ──────────

/// Once `initialize` succeeds, `reveal_initialize` must also fail.
#[test]
fn test_reveal_initialize_blocked_after_init() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let salt = BytesN::from_array(&env, &[2u8; 32]);

    let result = client.try_reveal_initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
        &salt,
    );
    assert_eq!(
        result,
        Err(Ok(ContractError::AlreadyInitialized)),
        "reveal_initialize must be blocked when contract is already initialized"
    );
}

// ── Scenario 6: double commit_initialize blocked ──────────────────────────

/// Calling `commit_initialize` twice (before any reveal or direct init) must
/// fail with `CommitmentExists` on the second call. This prevents overwriting
/// a pending commit to substitute different collaborators.
#[test]
fn test_double_commit_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let committer = Address::generate(&env);
    let hash_a = BytesN::from_array(&env, &[0u8; 32]);
    let hash_b = BytesN::from_array(&env, &[1u8; 32]);
    let nonce = BytesN::from_array(&env, &[2u8; 32]);

    // First commit — must succeed
    client.commit_initialize(&committer, &hash_a, &hash_b, &nonce);

    // Second commit — must fail with CommitmentExists
    let result = client.try_commit_initialize(&committer, &hash_a, &hash_b, &nonce);
    assert_eq!(
        result,
        Err(Ok(ContractError::CommitmentExists)),
        "second commit_initialize must return CommitmentExists"
    );
}

// ── Scenario 7: reveal without commit rejected ────────────────────────────

/// Calling `reveal_initialize` without a prior `commit_initialize` must fail
/// with `NoPendingCommit`. This prevents a reveal-only attack path.
#[test]
fn test_reveal_without_commit_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let salt = BytesN::from_array(&env, &[0u8; 32]);

    let result = client.try_reveal_initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
        &salt,
    );
    assert_eq!(
        result,
        Err(Ok(ContractError::NoPendingCommit)),
        "reveal_initialize without prior commit must return NoPendingCommit"
    );
}

// ── Scenario 8: init event emitted exactly once ───────────────────────────

/// The `("royalty", "init")` event must be emitted exactly once — on the
/// successful initialize call — and never on rejected re-initialization attempts.
#[test]
fn test_init_event_emitted_exactly_once() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Three rejected re-init attempts
    for _ in 0..3 {
        let attacker = Address::generate(&env);
        let _ = client.try_initialize(
            &vec![&env, attacker.clone(), admin.clone()],
            &vec![&env, 5000_u32, 5000_u32],
        );
    }

    let all_events = env.events().all();
    let init_events: std::vec::Vec<_> = all_events
        .iter()
        .filter(|(cid, topics, _)| {
            *cid == contract_id
                && *topics
                    == vec![
                        &env,
                        symbol_short!("royalty").into_val(&env),
                        symbol_short!("init").into_val(&env),
                    ]
        })
        .collect();

    assert_eq!(
        init_events.len(),
        1,
        "init event must be emitted exactly once; found {}",
        init_events.len()
    );
}

// ── Scenario 9: admin storage set only once ──────────────────────────────

/// Even if a re-init call slips past an edge case in validation, the guard
/// must ensure `StorageKey::Admin` is set only once. Check directly from
/// storage that the original admin address persists after multiple failed
/// re-init attempts.
#[test]
fn test_admin_storage_set_only_once() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let original_admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, original_admin.clone(), b.clone()],
        &vec![&env, 7000_u32, 3000_u32],
    );

    // Attempt 5 re-inits with different would-be admins
    for _ in 0..5 {
        let new_admin = Address::generate(&env);
        let _ = client.try_initialize(
            &vec![&env, new_admin.clone(), b.clone()],
            &vec![&env, 5000_u32, 5000_u32],
        );
    }

    env.as_contract(&contract_id, || {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("admin must be stored");
        assert_eq!(
            stored_admin, original_admin,
            "admin must remain the original address after all rejected re-init attempts"
        );
    });
}

// ── Scenario 10: collaborator list not overwritten ────────────────────────

/// The collaborators persistent storage entry must not be overwritten by any
/// rejected re-init call. Validates the guard protects persistent storage too.
#[test]
fn test_collaborator_list_not_overwritten_by_rejected_reinit() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 4000_u32, 3000_u32, 3000_u32],
    );

    // Attempt re-init with only 2 collaborators
    let attacker = Address::generate(&env);
    let _ = client.try_initialize(
        &vec![&env, attacker.clone(), admin.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Collaborator list must still have 3 entries
    let collaborators = client.get_collaborators();
    assert_eq!(collaborators.len(), 3, "collaborator count must not change");
    assert_eq!(collaborators.get(0).unwrap(), admin);
    assert_eq!(collaborators.get(1).unwrap(), b);
    assert_eq!(collaborators.get(2).unwrap(), c);

    // Persistent storage accessed directly
    env.as_contract(&contract_id, || {
        use soroban_sdk::Vec as SorobanVec;
        let stored: SorobanVec<Address> = env
            .storage()
            .persistent()
            .get(&StorageKey::Collaborators)
            .expect("collaborators must be in persistent storage");
        assert_eq!(stored.len(), 3);
    });
}

// ── Scenario 11: version not overwritten ──────────────────────────────────

/// `StorageKey::ContractVersion` is written during initialize. A rejected
/// re-init must not overwrite it with a different version string.
#[test]
fn test_contract_version_not_overwritten() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    let version_after_init = client.get_version();

    // Rejected re-init
    let attacker = Address::generate(&env);
    let _ = client.try_initialize(
        &vec![&env, attacker.clone(), admin.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    assert_eq!(
        client.get_version(),
        version_after_init,
        "contract version must not change after rejected re-init"
    );
}

// ── Scenario 12: re-init with invalid shares rejected before guard (defense-in-depth) ──

/// A re-init attempt carrying invalid shares (don't sum to 10,000) must still
/// return `AlreadyInitialized`, not `InvalidShareTotal`. The guard fires first.
#[test]
fn test_guard_fires_before_share_validation() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(
        &vec![&env, admin.clone(), b.clone()],
        &vec![&env, 5000_u32, 5000_u32],
    );

    // Attempt re-init with shares that don't sum to 10,000
    let attacker = Address::generate(&env);
    let result = client.try_initialize(
        &vec![&env, attacker.clone(), admin.clone()],
        &vec![&env, 1000_u32, 1000_u32], // only 2000, not 10000
    );

    // Must be AlreadyInitialized, not InvalidShareTotal
    assert_eq!(
        result,
        Err(Ok(ContractError::AlreadyInitialized)),
        "AlreadyInitialized guard must fire before share validation"
    );
}
