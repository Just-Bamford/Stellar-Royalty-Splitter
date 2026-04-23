#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, vec, Address, Env, IntoVal,
};
use stellar_royalty_splitter::RoyaltySplitterClient;

// Helper: mint `amount` of the test token to `to`
fn mint(env: &Env, token_admin: &token::StellarAssetClient, to: &Address, amount: i128) {
    token_admin.mint(to, &amount);
}

#[test]
fn test_three_way_split() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy a test token
    let token_admin_addr = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin_addr.clone());
    let token_admin = token::StellarAssetClient::new(&env, &token_id);
    let token_client = token::Client::new(&env, &token_id);

    // Three collaborators
    let artist = Address::generate(&env);
    let musician = Address::generate(&env);
    let animator = Address::generate(&env);

    // Deploy the splitter contract
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);

    // Initialize: 50% / 30% / 20%  (in basis points)
    splitter.initialize(
        &vec![&env, artist.clone(), musician.clone(), animator.clone()],
        &vec![&env, 5_000u32, 3_000u32, 2_000u32],
    );

    // Fund the contract with 1_000 tokens
    mint(&env, &token_admin, &contract_id, 1_000);

    // Distribute
    splitter.distribute(&token_id, &1_000);

    // Verify balances
    assert_eq!(token_client.balance(&artist), 500);
    assert_eq!(token_client.balance(&musician), 300);
    assert_eq!(token_client.balance(&animator), 200);
}

#[test]
fn test_secondary_royalty_rate_setting() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);

    // Initialize collaborators first
    let artist = Address::generate(&env);
    let musician = Address::generate(&env);
    splitter.initialize(
        &vec![&env, artist.clone(), musician.clone()],
        &vec![&env, 6_000u32, 4_000u32],
    );

    // Set royalty rate to 10% (1000 bp)
    splitter.set_royalty_rate(&1_000u32);

    // Verify rate was set
    assert_eq!(splitter.get_royalty_rate(), 1_000u32);
}

#[test]
fn test_record_secondary_royalty() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy test token
    let token_admin_addr = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin_addr.clone());

    // Setup splitter
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);

    let artist = Address::generate(&env);
    let musician = Address::generate(&env);
    splitter.initialize(
        &vec![&env, artist.clone(), musician.clone()],
        &vec![&env, 6_000u32, 4_000u32],
    );

    // Set 10% secondary royalty rate
    splitter.set_royalty_rate(&1_000u32);

    // Record a secondary sale: 1000 stroops * 10% = 100 stroops royalty
    let royalty = splitter.record_secondary_royalty(&1_000i128);
    assert_eq!(royalty, 100i128);

    // Verify pool increased
    let pool = splitter.get_secondary_royalty_pool();
    assert_eq!(pool, 100i128);
}

#[test]
fn test_secondary_royalty_accumulation() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy test token
    let token_admin_addr = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin_addr.clone());
    let token_admin = token::StellarAssetClient::new(&env, &token_id);

    // Setup splitter
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);

    let artist = Address::generate(&env);
    let musician = Address::generate(&env);
    splitter.initialize(
        &vec![&env, artist.clone(), musician.clone()],
        &vec![&env, 6_000u32, 4_000u32],
    );

    // Set 5% secondary royalty rate
    splitter.set_royalty_rate(&500u32);

    // Record multiple secondary sales
    let r1 = splitter.record_secondary_royalty(&1_000i128);
    let r2 = splitter.record_secondary_royalty(&2_000i128);
    let r3 = splitter.record_secondary_royalty(&3_000i128);

    // Verify accumulated pool
    let expected_total = r1 + r2 + r3;
    assert_eq!(splitter.get_secondary_royalty_pool(), expected_total);
    assert_eq!(expected_total, 300i128); // 1000 * 0.05 + 2000 * 0.05 + 3000 * 0.05 = 300
}

#[test]
fn test_secondary_royalty_distribution() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy test token
    let token_admin_addr = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin_addr.clone());
    let token_admin = token::StellarAssetClient::new(&env, &token_id);
    let token_client = token::Client::new(&env, &token_id);

    // Setup splitter
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);

    let artist = Address::generate(&env);
    let musician = Address::generate(&env);
    splitter.initialize(
        &vec![&env, artist.clone(), musician.clone()],
        &vec![&env, 6_000u32, 4_000u32],
    );

    // Set 10% secondary royalty
    splitter.set_royalty_rate(&1_000u32);

    // Record secondary sales that accumulate 1000 in the pool
    splitter.record_secondary_royalty(&5_000i128);
    splitter.record_secondary_royalty(&5_000i128);
    // Pool should be 1000 (10% of 10000)

    // Fund contract with the pool amount
    mint(&env, &token_admin, &contract_id, 1_000);

    // Distribute secondary royalties
    splitter.distribute_secondary_royalties(&token_id);

    // Verify distribution: 60% to artist, 40% to musician
    assert_eq!(token_client.balance(&artist), 600);
    assert_eq!(token_client.balance(&musician), 400);

    // Pool should be reset
    assert_eq!(splitter.get_secondary_royalty_pool(), 0i128);
}

#[test]
fn test_rounding_dust_goes_to_last_collaborator() {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin_addr = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin_addr.clone());
    let token_admin = token::StellarAssetClient::new(&env, &token_id);
    let token_client = token::Client::new(&env, &token_id);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);

    // 33.33% / 33.33% / 33.34%  — intentionally uneven
    splitter.initialize(
        &vec![&env, a.clone(), b.clone(), c.clone()],
        &vec![&env, 3_333u32, 3_333u32, 3_334u32],
    );

    mint(&env, &token_admin, &contract_id, 100);
    splitter.distribute(&token_id, &100);

    // a and b each get 33, c absorbs the remaining 34
    assert_eq!(token_client.balance(&a), 33);
    assert_eq!(token_client.balance(&b), 33);
    assert_eq!(token_client.balance(&c), 34);
}

#[test]
#[should_panic(expected = "shares must sum to 10000 basis points")]
fn test_invalid_shares_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);

    // 60% + 60% = 120% — should panic
    splitter.initialize(
        &vec![&env, a, b],
        &vec![&env, 6_000u32, 6_000u32],
    );
}

#[test]
#[should_panic(expected = "already initialized")]
fn test_double_initialization_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);

    splitter.initialize(
        &vec![&env, a.clone(), b.clone()],
        &vec![&env, 5_000u32, 5_000u32],
    );

    // Second call must panic
    splitter.initialize(
        &vec![&env, a, b],
        &vec![&env, 5_000u32, 5_000u32],
    );
}

#[test]
#[should_panic(expected = "royalty rate cannot exceed 100%")]
fn test_royalty_rate_above_max_rejected() {
    // Verifies that setting a royalty rate above 10000 bp (100%) panics
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    splitter.initialize(&vec![&env, a, b], &vec![&env, 5_000u32, 5_000u32]);
    splitter.set_royalty_rate(&10_001u32); // should panic
}

#[test]
#[should_panic(expected = "sale price must be positive")]
fn test_record_secondary_royalty_zero_price_rejected() {
    // Verifies that recording a secondary royalty with a zero sale price panics
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    splitter.initialize(&vec![&env, a, b], &vec![&env, 5_000u32, 5_000u32]);
    splitter.set_royalty_rate(&500u32);
    splitter.record_secondary_royalty(&0i128); // should panic
}

#[test]
#[should_panic(expected = "no secondary royalties to distribute")]
fn test_distribute_empty_pool_rejected() {
    // Verifies that distributing when the secondary royalty pool is empty panics
    let env = Env::default();
    env.mock_all_auths();
    let token_admin_addr = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract(token_admin_addr);
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let splitter = RoyaltySplitterClient::new(&env, &contract_id);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    splitter.initialize(&vec![&env, a, b], &vec![&env, 5_000u32, 5_000u32]);
    splitter.distribute_secondary_royalties(&token_id); // pool is empty, should panic
}
