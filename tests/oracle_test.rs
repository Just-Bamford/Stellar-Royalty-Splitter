#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger},
    vec, Address, Bytes, Env,
};
use stellar_royalty_splitter::{
    OracleAsset, OraclePriceData, RoyaltySplitter, RoyaltySplitterClient,
};

#[contract]
struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn decimals(_env: Env) -> u32 {
        2
    }

    pub fn lastprice(env: Env, _asset: OracleAsset) -> Option<OraclePriceData> {
        let price: Option<i128> = env.storage().instance().get(&symbol_short!("price"));
        price.map(|price| OraclePriceData {
            price,
            timestamp: env
                .storage()
                .instance()
                .get(&symbol_short!("time"))
                .unwrap_or(0),
        })
    }

    pub fn set_price(env: Env, price: i128, timestamp: u64) {
        env.storage()
            .instance()
            .set(&symbol_short!("price"), &Some(price));
        env.storage()
            .instance()
            .set(&symbol_short!("time"), &timestamp);
    }
}

fn setup(env: &Env) -> (RoyaltySplitterClient<'_>, Address) {
    let contract_id = env.register_contract(None, RoyaltySplitter);
    let client = RoyaltySplitterClient::new(env, &contract_id);
    let oracle_id = env.register_contract(None, MockOracle);
    (client, oracle_id)
}

fn initialize(env: &Env, client: &RoyaltySplitterClient<'_>, admin: &Address) {
    client.initialize(&vec![env, admin.clone()], &vec![env, 10_000_u32]);
}

fn asset(env: &Env) -> OracleAsset {
    OracleAsset::Other(soroban_sdk::Symbol::new(env, "ROYALTY"))
}

#[test]
fn successful_fetch_updates_rate_and_records_configuration() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
    let (client, oracle_id) = setup(&env);
    let admin = Address::generate(&env);
    initialize(&env, &client, &admin);
    MockOracleClient::new(&env, &oracle_id).set_price(&87_500, &1_000);

    client.set_royalty_oracle(&oracle_id, &asset(&env), &60, &300);
    assert_eq!(client.fetch_royalty_rate_from_oracle(), 875);
    assert_eq!(client.update_royalty_rate_from_oracle(), 875);
    assert_eq!(client.get_royalty_rate(), 875);
    assert_eq!(client.get_royalty_oracle().unwrap().update_frequency, 60);
}

#[test]
fn oracle_failure_preserves_manual_rate() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
    let (client, oracle_id) = setup(&env);
    let admin = Address::generate(&env);
    initialize(&env, &client, &admin);
    client.set_royalty_rate(&500);
    client.set_royalty_oracle(&oracle_id, &asset(&env), &60, &300);

    assert!(client.try_update_royalty_rate_from_oracle().is_err());
    assert_eq!(client.get_royalty_rate(), 500);
}

#[test]
fn stale_quote_and_update_frequency_are_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
    let (client, oracle_id) = setup(&env);
    let admin = Address::generate(&env);
    initialize(&env, &client, &admin);
    client.set_royalty_rate(&600);
    let oracle = MockOracleClient::new(&env, &oracle_id);
    oracle.set_price(&90_000, &1);
    client.set_royalty_oracle(&oracle_id, &asset(&env), &60, &300);
    assert!(client.try_update_royalty_rate_from_oracle().is_err());

    oracle.set_price(&70_000, &1_000);
    assert_eq!(client.update_royalty_rate_from_oracle(), 700);
    assert!(client.try_update_royalty_rate_from_oracle().is_err());
}

#[test]
fn oracle_configuration_and_v2_functions_survive_upgrade() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
    let (client, oracle_id) = setup(&env);
    let admin = Address::generate(&env);
    initialize(&env, &client, &admin);
    let oracle = MockOracleClient::new(&env, &oracle_id);
    oracle.set_price(&80_000, &1_000);
    client.set_royalty_oracle(&oracle_id, &asset(&env), &60, &300);
    client.update_royalty_rate_from_oracle();
    let config_before = client.get_royalty_oracle();

    env.budget().reset_unlimited();
    let wasm_bytes = Bytes::from_slice(
        &env,
        include_bytes!("../target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm"),
    );
    let wasm = env.deployer().upload_contract_wasm(wasm_bytes);
    client.update_wasm(&wasm);

    assert_eq!(client.get_royalty_oracle(), config_before);
    assert_eq!(client.get_royalty_rate(), 800);
    assert_eq!(client.get_admin(), admin);
    assert!(client.is_initialized());
    env.ledger().with_mut(|ledger| ledger.timestamp = 1_060);
    oracle.set_price(&90_000, &1_060);
    assert_eq!(client.update_royalty_rate_from_oracle(), 900);
    assert_eq!(client.get_royalty_rate(), 900);
}
