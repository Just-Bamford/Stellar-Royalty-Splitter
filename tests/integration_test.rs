#![cfg(test)]
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env,
};
use stellar_royalty_splitter::RoyaltySplitterClient;

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
    client.distribute(&token, &10_000_i128);
}

#[test]
#[should_panic(expected = "amount exceeds contract balance")]
fn test_distribute_zero_balance_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);
    client.initialize(&vec![&env, a, b], &vec![&env, 5000_u32, 5000_u32]);
    // contract balance is 0, any positive amount must panic
    client.distribute(&token, &1_i128);
}

/// Issue #92 — pre-loop balance guard prevents partial distribution.
/// 3 collaborators, contract funded with only 300 of the requested 1000.
/// Without the guard the first two transfers would succeed; with it the whole
/// call is rejected before any transfer executes.
#[test]
#[should_panic(expected = "amount exceeds contract balance")]
fn test_no_partial_distribution_on_insufficient_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let admin = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(
        &vec![&env, admin.clone(), b.clone(), c.clone()],
        &vec![&env, 5000_u32, 3000_u32, 2000_u32],
    );

    // Fund only 300 but request 1000 — guard must fire before any transfer.
    mint(&env, &token, &contract_id, 300);
    client.distribute(&token, &1000_i128);
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

#[test]
fn test_single_collaborator_receives_all() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let a = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, a.clone()], &vec![&env, 10000_u32]);

    let amount = 1_000_000_i128;
    mint(&env, &token, &contract_id, amount);

    client.distribute(&token, &amount);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&a), amount);
}

#[test]
fn test_large_amount_distribution() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token = make_token(&env, &token_admin);

    client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

    // Use a large amount. intermediate (amount * share) must fit in i128.
    // i128::MAX is ~1.7e38. 1.7e38 / 10000 is ~1.7e34.
    let amount = i128::MAX / 10_000;
    mint(&env, &token, &contract_id, amount);

    client.distribute(&token, &amount);

    let token_client = TokenClient::new(&env, &token);
    let a_balance = token_client.balance(&a);
    let b_balance = token_client.balance(&b);

    assert_eq!(a_balance + b_balance, amount);
}

#[test]
#[should_panic(expected = "share cannot be zero")]
fn test_zero_share_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = setup(&env);

    let a = Address::generate(&env);
    let b = Address::generate(&env);

    client.initialize(&vec![&env, a, b], &vec![&env, 10000_u32, 0_u32]);
}



