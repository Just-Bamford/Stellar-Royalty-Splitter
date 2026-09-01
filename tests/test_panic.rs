use soroban_sdk::{testutils::Address as _, Address, Env};
#[test]
fn test_panic() {
    let env = Env::default();
    let addr = Address::generate(&env);
    addr.require_auth();
}
