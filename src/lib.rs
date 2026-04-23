#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Env, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    RoyaltyRate,
    Collaborators,
}

#[contract]
pub struct RoyaltySplitter;

#[contractimpl]
impl RoyaltySplitter {
    pub fn initialize(env: Env, collaborators: Vec<Address>, royalty_rate: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if collaborators.is_empty() {
            panic!("need at least one collaborator");
        }
        let admin: Address = collaborators.get(0).unwrap();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Collaborators, &collaborators);
        env.storage().instance().set(&DataKey::RoyaltyRate, &royalty_rate);
    }

    pub fn set_royalty_rate(env: Env, new_rate: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");
        admin.require_auth();
        env.storage().instance().set(&DataKey::RoyaltyRate, &new_rate);
    }

    pub fn distribute(env: Env, total_amount: i128) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");
        admin.require_auth();
        let rate: u32 = env.storage().instance().get(&DataKey::RoyaltyRate).unwrap_or(0);
        let collaborators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Collaborators)
            .expect("no collaborators");
        let n = collaborators.len() as i128;
        if n == 0 { return; }
        let royalty_pool = total_amount * rate as i128 / 10_000;
        let share = royalty_pool / n;
        for collaborator in collaborators.iter() {
            env.events().publish((symbol_short!("dist"),), (collaborator, share));
        }
    }

    pub fn get_royalty_rate(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::RoyaltyRate).unwrap_or(0)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).expect("contract not initialized")
    }

    pub fn get_collaborators(env: Env) -> Vec<Address> {
        env.storage().instance().get(&DataKey::Collaborators).expect("contract not initialized")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, Address, Env, IntoVal};

    fn make_addresses(env: &Env, n: usize) -> soroban_sdk::Vec<Address> {
        let mut v = vec![env];
        for _ in 0..n { v.push_back(Address::generate(env)); }
        v
    }

    #[test]
    fn test_admin_is_stored_on_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(&env, &contract_id);
        let collaborators = make_addresses(&env, 3);
        let expected_admin = collaborators.get(0).unwrap();
        client.initialize(&collaborators, &500);
        assert_eq!(client.get_admin(), expected_admin);
    }

    #[test]
    fn test_admin_can_set_royalty_rate() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(&env, &contract_id);
        let collaborators = make_addresses(&env, 2);
        client.initialize(&collaborators, &100);
        client.set_royalty_rate(&750);
        assert_eq!(client.get_royalty_rate(), 750);
    }

   

    #[test]
    fn test_admin_can_distribute() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(&env, &contract_id);
        let collaborators = make_addresses(&env, 3);
        client.initialize(&collaborators, &1000);
        client.distribute(&10_000_i128);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_non_admin_cannot_set_royalty_rate() {
        let env = Env::default();
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(&env, &contract_id);
        let collaborators = make_addresses(&env, 2);
        env.mock_all_auths();
        client.initialize(&collaborators, &100);
        env.set_auths(&[]);
        let result = client.try_set_royalty_rate(&999);
        assert!(result.is_err());
    }
}
