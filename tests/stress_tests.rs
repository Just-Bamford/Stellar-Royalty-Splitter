#![cfg(test)]

use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Map, Vec as SorobanVec,
};
use stellar_royalty_splitter::{DataKey, Recipient, RoyaltySplitterClient};

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

fn build_override_recipients(
    env: &Env,
    count: usize,
) -> (
    SorobanVec<Recipient>,
    std::vec::Vec<Address>,
    std::vec::Vec<u32>,
) {
    assert!(count >= 100);
    assert!(count <= 10_000);

    let mut recipients = SorobanVec::new(env);
    let mut addresses = std::vec::Vec::with_capacity(count);
    let mut shares = std::vec::Vec::with_capacity(count);

    let base = 10_000u32 / count as u32;
    let remainder = 10_000u32 % count as u32;

    for i in 0..count {
        let address = Address::generate(env);
        let share = base + u32::from((i as u32) < remainder);
        addresses.push(address.clone());
        shares.push(share);
        recipients.push_back(Recipient { address, share });
    }

    (recipients, addresses, shares)
}

fn seed_collaborators(env: &Env, contract_id: &Address, recipients: &SorobanVec<Recipient>) {
    let mut collaborators = SorobanVec::new(env);
    let mut share_map: Map<Address, u32> = Map::new(env);

    for i in 0..recipients.len() {
        let recipient = recipients.get(i).unwrap();
        collaborators.push_back(recipient.address.clone());
        share_map.set(recipient.address.clone(), recipient.share);
    }

    env.as_contract(contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Collaborators, &collaborators);
        env.storage()
            .persistent()
            .set(&DataKey::ShareMap, &share_map);
    });
}

fn expected_payouts(amount: i128, shares: &[u32]) -> std::vec::Vec<i128> {
    let mut payouts = std::vec::Vec::with_capacity(shares.len());
    let mut calculated: i128 = 0;

    for share in shares.iter().take(shares.len().saturating_sub(1)) {
        let payout = (amount * *share as i128) / 10_000;
        payouts.push(payout);
        calculated += payout;
    }

    if let Some(last_share) = shares.last() {
        let last_payout = amount - calculated;
        debug_assert!(*last_share > 0);
        payouts.push(last_payout);
    }

    payouts
}

fn measure_cpu<R>(env: &Env, f: impl FnOnce() -> R) -> (R, u64) {
    let mut budget = env.budget();
    budget.reset_unlimited();
    budget.reset_tracker();
    let before = budget.cpu_instruction_cost();
    let result = f();
    let after = budget.cpu_instruction_cost();
    (result, after.saturating_sub(before))
}

#[test]
fn test_override_distribution_with_100_plus_recipients() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &SorobanVec::from_array(&env, [admin.clone()]),
        &SorobanVec::from_array(&env, [10_000u32]),
    );

    let (recipients, addresses, shares) = build_override_recipients(&env, 120);
    seed_collaborators(&env, &contract_id, &recipients);
    let amount: i128 = 120_000_000;
    mint(&env, &token, &contract_id, amount);

    let (_, cpu_used) = measure_cpu(&env, || {
        client.distribute_with_override(&token, &recipients)
    });

    let payouts = expected_payouts(amount, &shares);
    let mut total_paid: i128 = 0;
    for (address, expected) in addresses.iter().zip(payouts.iter()) {
        let actual = TokenClient::new(&env, &token).balance(address);
        assert_eq!(actual, *expected, "recipient payout mismatch");
        total_paid += actual;
    }

    assert_eq!(total_paid, amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
    assert!(
        cpu_used < 1_000_000,
        "120-recipient override distribution should stay under 1M CPU instructions, got {cpu_used}"
    );
}

#[test]
fn test_repeated_large_batches_same_contract() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &SorobanVec::from_array(&env, [admin.clone()]),
        &SorobanVec::from_array(&env, [10_000u32]),
    );

    let (recipients, addresses, shares) = build_override_recipients(&env, 100);
    seed_collaborators(&env, &contract_id, &recipients);
    let payouts = expected_payouts(500_000_000, &shares);
    let mut running_balances = std::vec::Vec::with_capacity(addresses.len());
    running_balances.resize(addresses.len(), 0i128);

    for cycle in 0..5 {
        mint(&env, &token, &contract_id, 500_000_000);
        let (_, cpu_used) = measure_cpu(&env, || {
            client.distribute_with_override(&token, &recipients)
        });

        let mut total_paid: i128 = 0;
        for (index, (address, expected)) in addresses.iter().zip(payouts.iter()).enumerate() {
            let actual = TokenClient::new(&env, &token).balance(address);
            let delta = actual - running_balances[index];
            assert_eq!(delta, *expected, "cycle {cycle} payout mismatch");
            running_balances[index] = actual;
            total_paid += delta;
        }

        assert_eq!(total_paid, 500_000_000, "cycle {cycle} total mismatch");
        assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
        assert!(
            cpu_used < 1_000_000,
            "100-recipient repeated distribution should stay under 1M CPU instructions, got {cpu_used}"
        );
    }
}

#[test]
fn test_large_amount_distribution_with_100_recipients() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &SorobanVec::from_array(&env, [admin.clone()]),
        &SorobanVec::from_array(&env, [10_000u32]),
    );

    let (recipients, addresses, shares) = build_override_recipients(&env, 100);
    seed_collaborators(&env, &contract_id, &recipients);
    let amount: i128 = 1_000_000_000_000_000;
    mint(&env, &token, &contract_id, amount);

    let (_, cpu_used) = measure_cpu(&env, || {
        client.distribute_with_override(&token, &recipients)
    });

    let payouts = expected_payouts(amount, &shares);
    let mut total_paid: i128 = 0;
    for (address, expected) in addresses.iter().zip(payouts.iter()) {
        let actual = TokenClient::new(&env, &token).balance(address);
        assert_eq!(actual, *expected, "large-amount payout mismatch");
        total_paid += actual;
    }

    assert_eq!(total_paid, amount);
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
    assert!(
        cpu_used < 1_000_000,
        "large-amount distribution should stay under 1M CPU instructions, got {cpu_used}"
    );
}

#[test]
fn test_large_batch_scale_is_reasonable() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &SorobanVec::from_array(&env, [admin.clone()]),
        &SorobanVec::from_array(&env, [10_000u32]),
    );

    let (small_recipients, _, _) = build_override_recipients(&env, 100);
    let (large_recipients, _, _) = build_override_recipients(&env, 120);
    seed_collaborators(&env, &contract_id, &small_recipients);

    mint(&env, &token, &contract_id, 10_000_000);
    let (_, small_cpu) = measure_cpu(&env, || {
        client.distribute_with_override(&token, &small_recipients)
    });

    seed_collaborators(&env, &contract_id, &large_recipients);
    mint(&env, &token, &contract_id, 10_000_000);
    let (_, large_cpu) = measure_cpu(&env, || {
        client.distribute_with_override(&token, &large_recipients)
    });

    assert!(large_cpu > small_cpu, "larger batches should cost more CPU");
    assert!(
        large_cpu < 1_000_000,
        "120-recipient batch should stay under 1M CPU instructions, got {large_cpu}"
    );
}

#[test]
fn test_repeated_batches_do_not_leave_residual_balance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &SorobanVec::from_array(&env, [admin.clone()]),
        &SorobanVec::from_array(&env, [10_000u32]),
    );

    let (recipients, _, shares) = build_override_recipients(&env, 150);
    seed_collaborators(&env, &contract_id, &recipients);
    let payouts = expected_payouts(75_000_000, &shares);

    for _ in 0..3 {
        mint(&env, &token, &contract_id, 75_000_000);
        client.distribute_with_override(&token, &recipients);
        assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);
    }

    let mut total_paid: i128 = 0;
    for expected in payouts {
        total_paid += expected;
    }
    assert_eq!(total_paid, 75_000_000);
}
