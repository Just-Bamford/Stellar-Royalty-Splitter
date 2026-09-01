#![cfg(test)]
use soroban_sdk::{testutils::Address as _, vec, Address, Env, Vec};
use stellar_royalty_splitter::{RoyaltySplitter, RoyaltySplitterClient};

#[test]
fn print_type() {
    let env = Env::default();
    let contract_id = env.register_contract(None, stellar_royalty_splitter::RoyaltySplitter);
    let client = RoyaltySplitterClient::new(&env, &contract_id);
    let result = client.try_initialize(&vec![&env, Address::generate(&env)], &vec![&env, 10000]);
    println!("TYPE IS: {}", std::any::type_name_of_val(&result));
    panic!("look at the output");
}
