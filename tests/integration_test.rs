#![cfg(test)]
use soroban_sdk::{testutils::Address as _, vec, Address, Env};
use stellar_royalty_splitter::RoyaltySplitterClient;

fn make_addresses(env: &Env, n: usize) -> soroban_sdk::Vec<Address> {
    let mut v = vec![env];
    for _ in 0..n {
        v.push_back(Address::generate(env));
    }
    v
}

#[test]
#[should_panic(expected = "not initialized")]
fn test_distribute_before_initialize_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(&env, &contract_id);
    client.distribute(&10_000_i128);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn test_distribute_zero_amount_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(&env, &contract_id);
    let collaborators = make_addresses(&env, 2);
    client.initialize(&collaborators, &100);
    client.distribute(&0_i128);
}

#[test]
#[should_panic(expected = "sale price must be positive")]
fn test_record_royalty_zero_price_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(&env, &contract_id);
    let collaborators = make_addresses(&env, 2);
    client.initialize(&collaborators, &100);
    client.record_secondary_royalty(&0_i128);
}

#[test]
#[should_panic(expected = "royalty rate cannot exceed 10000 basis points")]
fn test_royalty_rate_exceeds_max_panics() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(&env, &contract_id);
    let collaborators = make_addresses(&env, 2);
    client.initialize(&collaborators, &100);
    client.set_royalty_rate(&10_001);
}