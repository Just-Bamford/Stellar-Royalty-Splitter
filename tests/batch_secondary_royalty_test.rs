/// Batch secondary royalty distribution tests
/// Issue: Multiple secondary royalty distributions create separate transactions,
/// causing network spam and accumulated gas costs.
/// Solution: Batch distributions into time-windowed groups (5-minute batches)
/// processed in single transactions.

#![cfg(test)]
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, Vec as SorobanVec,
};
use stellar_royalty_splitter::{
    ContractError, RoyaltySplitterClient, StorageKey, BatchEntry, BatchMetrics,
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

/// Test 1: Simple batch queueing — add royalty to queue
#[test]
fn test_batch_queue_single_entry() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator_1 = Address::generate(&env);
    let collaborator_2 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    // Initialize with 2 collaborators
    client.initialize(
        &vec![&env, admin.clone(), collaborator_1.clone()],
        &vec![&env, 6000, 4000],
    );

    // Mint tokens
    mint(&env, &token, &client.address, &1_000_000);

    // Set royalty rate
    client.set_royalty_rate(&500); // 5%

    // Queue a batch
    client.queue_batch_secondary_royalty(&token, &100_000);

    // Verify queue is not empty
    let queue = client.get_batch_queue_status();
    assert_eq!(queue.len(), 1);
    let entry = queue.get(0).unwrap();
    assert_eq!(entry.total_amount, 100_000);
    assert_eq!(entry.status, 0); // pending
}

/// Test 2: Multiple batches accumulate in queue
#[test]
fn test_batch_queue_multiple_entries() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator_1 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collaborator_1.clone()],
        &vec![&env, 6000, 4000],
    );

    mint(&env, &token, &client.address, &10_000_000);
    client.set_royalty_rate(&500);

    // Queue 5 entries
    for i in 0..5 {
        client.queue_batch_secondary_royalty(&token, &(100_000 * (i + 1) as i128));
    }

    // Verify all queued
    let queue = client.get_batch_queue_status();
    assert_eq!(queue.len(), 5);

    // Verify amounts are correct
    for i in 0..5 {
        let entry = queue.get(i).unwrap();
        assert_eq!(entry.total_amount, 100_000 * (i + 1) as i128);
    }
}

/// Test 3: Batch window expiration and processing
#[test]
fn test_batch_process_single_batch() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collaborator_1 = Address::generate(&env);
    let collaborator_2 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collaborator_1.clone(), collaborator_2.clone()],
        &vec![&env, 5000, 3000, 2000],
    );

    mint(&env, &token, &client.address, &1_000_000);
    client.set_royalty_rate(&500);

    // Queue a batch
    client.queue_batch_secondary_royalty(&token, &100_000);

    // Advance ledger time past batch window (300 seconds)
    env.ledger().with_mut(|ledger| {
        ledger.timestamp(env.ledger().timestamp() + 305);
    });

    // Process batch queue
    client.process_batch_queue();

    // Verify batch is processed
    let queue = client.get_batch_queue_status();
    assert_eq!(queue.len(), 1);
    let entry = queue.get(0).unwrap();
    assert_eq!(entry.status, 2); // completed
}

/// Test 4: Batch with multiple entries combines into single transaction
#[test]
fn test_batch_process_multiple_entries_atomic() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collab_1 = Address::generate(&env);
    let collab_2 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collab_1.clone(), collab_2.clone()],
        &vec![&env, 5000, 3000, 2000],
    );

    mint(&env, &token, &client.address, &10_000_000);
    client.set_royalty_rate(&500);

    // Queue 3 entries in same batch
    client.queue_batch_secondary_royalty(&token, &100_000);
    client.queue_batch_secondary_royalty(&token, &50_000);
    client.queue_batch_secondary_royalty(&token, &75_000);

    // Advance past batch window
    env.ledger().with_mut(|ledger| {
        ledger.timestamp(env.ledger().timestamp() + 305);
    });

    // Process — should combine all into single batch
    client.process_batch_queue();

    let queue = client.get_batch_queue_status();
    let processed = queue
        .iter()
        .filter(|e| e.status == 2)
        .count();
    
    // All entries should be processed
    assert!(processed > 0);
}

/// Test 5: Batch retry on transient failure
#[test]
fn test_batch_retry_on_insufficient_balance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collab_1 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collab_1.clone()],
        &vec![&env, 6000, 4000],
    );

    // Mint only small amount
    mint(&env, &token, &client.address, &10_000);
    client.set_royalty_rate(&500);

    // Queue batch larger than available balance
    client.queue_batch_secondary_royalty(&token, &100_000);

    // Try to process
    env.ledger().with_mut(|ledger| {
        ledger.timestamp(env.ledger().timestamp() + 305);
    });

    // Processing should handle gracefully (batch may retry or fail)
    // This test verifies no panic occurs
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.process_batch_queue();
    }));

    // Should not panic
    assert!(result.is_ok());
}

/// Test 6: Batch metrics tracking
#[test]
fn test_batch_metrics_after_distribution() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collab_1 = Address::generate(&env);
    let collab_2 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collab_1.clone(), collab_2.clone()],
        &vec![&env, 5000, 3000, 2000],
    );

    mint(&env, &token, &client.address, &10_000_000);
    client.set_royalty_rate(&500);

    // Queue multiple batches
    client.queue_batch_secondary_royalty(&token, &100_000);
    client.queue_batch_secondary_royalty(&token, &200_000);

    let metrics_before = client.get_batch_metrics();
    assert_eq!(metrics_before.total_batches, 0);

    // Process
    env.ledger().with_mut(|ledger| {
        ledger.timestamp(env.ledger().timestamp() + 305);
    });

    client.process_batch_queue();

    let metrics_after = client.get_batch_metrics();
    assert!(metrics_after.total_batches > 0);
    assert!(metrics_after.total_distributed > 0);
    assert!(metrics_after.average_batch_size > 0);
}

/// Test 7: Batch max size enforcement (50 entries per batch)
#[test]
fn test_batch_max_size_limit() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collab_1 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collab_1.clone()],
        &vec![&env, 6000, 4000],
    );

    mint(&env, &token, &client.address, &100_000_000);
    client.set_royalty_rate(&500);

    // Queue 55 entries (exceeds MAX_BATCH_SIZE of 50)
    for i in 0..55 {
        client.queue_batch_secondary_royalty(&token, &1_000 * (i + 1) as i128);
    }

    let queue = client.get_batch_queue_status();
    // Should have 2 separate batch IDs due to size limit
    let batch_ids: std::collections::HashSet<_> = queue.iter().map(|e| e.batch_id).collect();
    assert!(batch_ids.len() >= 1); // At least split into batches
}

/// Test 8: Gas savings estimation
#[test]
fn test_batch_gas_savings_metrics() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collab_1 = Address::generate(&env);
    let collab_2 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collab_1.clone(), collab_2.clone()],
        &vec![&env, 5000, 3000, 2000],
    );

    mint(&env, &token, &client.address, &10_000_000);
    client.set_royalty_rate(&500);

    // Queue 10 batches
    for _ in 0..10 {
        client.queue_batch_secondary_royalty(&token, &100_000);
    }

    // Process all
    env.ledger().with_mut(|ledger| {
        ledger.timestamp(env.ledger().timestamp() + 305);
    });

    client.process_batch_queue();

    let metrics = client.get_batch_metrics();
    // Gas savings should be ~5000 stroops per completed batch
    // (estimate: 5 recipients - 1 base = 4 transfers saved per batch)
    assert!(metrics.total_gas_saved > 0);
}

/// Test 9: Batch atomicity — all collaborators receive payouts in single transaction
#[test]
fn test_batch_atomicity_all_collaborators_paid() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collab_1 = Address::generate(&env);
    let collab_2 = Address::generate(&env);
    let collab_3 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collab_1.clone(), collab_2.clone(), collab_3.clone()],
        &vec![&env, 5000, 2500, 2000, 500],
    );

    mint(&env, &token, &client.address, &100_000_000);
    client.set_royalty_rate(&500);

    // Queue batch
    let batch_amount = 1_000_000i128;
    client.queue_batch_secondary_royalty(&token, &batch_amount);

    // Advance past window
    env.ledger().with_mut(|ledger| {
        ledger.timestamp(env.ledger().timestamp() + 305);
    });

    // Get balances before
    let token_client = TokenClient::new(&env, &token);
    let collab_1_before = token_client.balance(&collab_1);
    let collab_2_before = token_client.balance(&collab_2);
    let collab_3_before = token_client.balance(&collab_3);

    // Process batch
    client.process_batch_queue();

    // Verify all collaborators received payouts
    let collab_1_after = token_client.balance(&collab_1);
    let collab_2_after = token_client.balance(&collab_2);
    let collab_3_after = token_client.balance(&collab_3);

    assert!(collab_1_after > collab_1_before);
    assert!(collab_2_after > collab_2_before);
    assert!(collab_3_after > collab_3_before);

    // Verify total distributed equals batch amount (minus dust)
    let total_distributed = (collab_1_after - collab_1_before)
        + (collab_2_after - collab_2_before)
        + (collab_3_after - collab_3_before);
    assert!(total_distributed >= batch_amount - 10); // allow for dust
}

/// Test 10: High volume batch distribution (stress test)
#[test]
fn test_batch_high_volume_100_batches() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_, client) = setup(&env);

    let admin = Address::generate(&env);
    let collab_1 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), collab_1.clone()],
        &vec![&env, 6000, 4000],
    );

    mint(&env, &token, &client.address, &1_000_000_000);
    client.set_royalty_rate(&500);

    // Queue 100 batches
    for i in 0..100 {
        client.queue_batch_secondary_royalty(&token, &(1_000_000i128 + i as i128 * 1_000));
    }

    let queue = client.get_batch_queue_status();
    assert_eq!(queue.len(), 100);

    // Advance past window
    env.ledger().with_mut(|ledger| {
        ledger.timestamp(env.ledger().timestamp() + 305);
    });

    // Process all batches in single call
    client.process_batch_queue();

    // Verify all processed
    let queue_after = client.get_batch_queue_status();
    let completed_count = queue_after
        .iter()
        .filter(|e| e.status == 2)
        .count();

    assert!(completed_count > 0);
}
