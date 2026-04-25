#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, Map, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    ShareMap,
    Collaborators,
    SecondaryRoyaltyPool,
    SecondaryPool,
    SecondaryToken,
}

#[contract]
pub struct RoyaltySplitter;

#[contractimpl]
impl RoyaltySplitter {
    /// Initialize the contract with collaborators and their basis-point shares (must sum to 10,000).
    pub fn initialize(env: Env, collaborators: Vec<Address>, shares: Vec<u32>) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if collaborators.is_empty() {
            panic!("need at least one collaborator");
        }
        if collaborators.len() != shares.len() {
            panic!("collaborators and shares length mismatch");
        }

        let total: u32 = shares.iter().sum();
        if total != 10_000 {
            panic!("shares must sum to 10000");
        }

        let mut share_map: Map<Address, u32> = Map::new(&env);
        for i in 0..collaborators.len() {
            let addr = collaborators.get(i).unwrap();
            // Bug fix #1: reject duplicate collaborator addresses
            if share_map.contains_key(addr.clone()) {
                panic!("duplicate collaborator address");
            }
            share_map.set(addr, shares.get(i).unwrap());
        }

        let admin = collaborators.get(0).unwrap();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Collaborators, &collaborators);
        env.storage().instance().set(&DataKey::ShareMap, &share_map);
    }

    pub fn set_royalty_rate(env: Env, new_rate: u32) {
        if new_rate > 10_000 {
            panic!("royalty rate cannot exceed 10000 basis points");
        }
    /// Distribute `amount` of `token` from the contract balance to all collaborators.
    pub fn distribute(env: Env, token: Address, amount: i128) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");
        admin.require_auth();

        // Bug fix #2: assert amount <= contract token balance
        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());
        if amount > balance {
            panic!("amount exceeds contract balance");
        }

        let collaborators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Collaborators)
            .expect("no collaborators");
        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::ShareMap)
            .expect("no share map");

        let n = collaborators.len();
        let mut distributed: i128 = 0;

        for i in 0..(n - 1) {
            let addr = collaborators.get(i).unwrap();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = amount * share as i128 / 10_000;
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            distributed += payout;
            env.events().publish((symbol_short!("dist"),), (addr, payout));
        }

        // Last collaborator gets the remainder to avoid rounding dust loss
        let last = collaborators.get(n - 1).unwrap();
        let remainder = amount - distributed;
        token_client.transfer(&env.current_contract_address(), &last, &remainder);
        env.events().publish((symbol_short!("dist"),), (last, remainder));
    }

    /// Record a secondary-market royalty: caller must transfer `royalty_amount` tokens
    /// to the contract before or within this call (via pre-approval + transfer_from).
    pub fn record_secondary_royalty(
        env: Env,
        token: Address,
        from: Address,
        royalty_amount: i128,
    ) {
        from.require_auth();

        // Bug fix #3: actually pull tokens into the contract so the pool is real
        let token_client = token::Client::new(&env, &token);
        token_client.transfer_from(
            &env.current_contract_address(),
            &from,
            &env.current_contract_address(),
            &royalty_amount,
        );

        let current_pool: i128 = env
            .storage()
            .instance()
            .get(&DataKey::SecondaryPool)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::SecondaryPool, &(current_pool + royalty_amount));
        env.storage()
            .instance()
            .set(&DataKey::SecondaryToken, &token);
    }

    /// Distribute the accumulated secondary royalty pool to all collaborators.
    pub fn distribute_secondary_royalties(env: Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");
        admin.require_auth();
        if total_amount <= 0 {
            panic!("amount must be positive");
        }
        let rate: u32 = env.storage().instance().get(&DataKey::RoyaltyRate).unwrap_or(0);

        let pool: i128 = env
            .storage()
            .instance()
            .get(&DataKey::SecondaryPool)
            .unwrap_or(0);
        if pool == 0 {
            panic!("no secondary royalties to distribute");
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::SecondaryToken)
            .expect("no secondary token set");

        // Bug fix #3: assert pool <= actual contract balance before distributing
        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());
        if pool > balance {
            panic!("pool exceeds contract balance");
        }

        let collaborators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Collaborators)
            .expect("no collaborators");
        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::ShareMap)
            .expect("no share map");

        let n = collaborators.len();
        let mut distributed: i128 = 0;

        for i in 0..(n - 1) {
            let addr = collaborators.get(i).unwrap();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = pool * share as i128 / 10_000;
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            distributed += payout;
        }

        let last = collaborators.get(n - 1).unwrap();
        let remainder = pool - distributed;
        token_client.transfer(&env.current_contract_address(), &last, &remainder);

        env.storage().instance().set(&DataKey::SecondaryPool, &0_i128);
    }

    pub fn record_secondary_royalty(env: Env, sale_price: i128) -> i128 {
        if sale_price <= 0 {
            panic!("sale price must be positive");
        }
        let rate: u32 = env.storage().instance().get(&DataKey::RoyaltyRate).unwrap_or(0);
        let royalty_amount = sale_price * rate as i128 / 10_000;
        let current_pool: i128 = env.storage().instance().get(&DataKey::SecondaryRoyaltyPool).unwrap_or(0);
        env.storage().instance().set(&DataKey::SecondaryRoyaltyPool, &(current_pool + royalty_amount));
        royalty_amount
    }

    pub fn get_royalty_rate(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::RoyaltyRate).unwrap_or(0)
    pub fn get_share(env: Env, collaborator: Address) -> u32 {
        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::ShareMap)
            .expect("contract not initialized");
        share_map.get(collaborator).unwrap_or(0)
    }

    pub fn get_collaborators(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Collaborators)
            .expect("contract not initialized")
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized")
    }

    pub fn get_secondary_pool(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::SecondaryPool)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        token::{Client as TokenClient, StellarAssetClient},
        vec, Address, Env, IntoVal,
    };

    fn setup(env: &Env) -> (Address, RoyaltySplitterClient) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
        let client = RoyaltySplitterClient::new(env, &contract_id);
        (contract_id, client)
    }

    fn make_token(env: &Env, admin: &Address) -> Address {
        let token_id = env.register_stellar_asset_contract(admin.clone());
        token_id
    }

    fn mint(env: &Env, token: &Address, admin: &Address, to: &Address, amount: i128) {
        StellarAssetClient::new(env, token).mint(to, &amount);
        let _ = admin;
    }

    // ── existing tests ────────────────────────────────────────────────────

    #[test]
    fn test_admin_is_stored_on_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let collaborators = vec![&env, a.clone(), b.clone()];
        let shares = vec![&env, 5000_u32, 5000_u32];
        client.initialize(&collaborators, &shares);
        assert_eq!(client.get_admin(), a);
    }

    #[test]
    fn test_distribute_splits_correctly() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let b = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        let collaborators = vec![&env, admin.clone(), b.clone()];
        let shares = vec![&env, 5000_u32, 5000_u32];
        client.initialize(&collaborators, &shares);

        // Fund the contract
        mint(&env, &token, &token_admin, &contract_id, 1000);

        client.distribute(&token, &1000_i128);

        assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
        assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
    }

    // ── Bug fix #1: duplicate collaborator ────────────────────────────────

    #[test]
    #[should_panic(expected = "duplicate collaborator address")]
    fn test_duplicate_collaborator_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup(&env);
        let a = Address::generate(&env);
        // same address twice
        let collaborators = vec![&env, a.clone(), a.clone()];
        let shares = vec![&env, 5000_u32, 5000_u32];
        client.initialize(&collaborators, &shares);
    }

    // ── Bug fix #2: over-distribution ────────────────────────────────────

    #[test]
    #[should_panic(expected = "amount exceeds contract balance")]
    fn test_distribute_panics_when_amount_exceeds_balance() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let b = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        let collaborators = vec![&env, admin.clone(), b.clone()];
        let shares = vec![&env, 5000_u32, 5000_u32];
        client.initialize(&collaborators, &shares);

        // Fund with 500 but try to distribute 1000
        mint(&env, &token, &token_admin, &contract_id, 500);
        client.distribute(&token, &1000_i128);
    }

    // ── Bug fix #3: secondary royalty pool ───────────────────────────────

    #[test]
    fn test_secondary_royalty_end_to_end() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let b = Address::generate(&env);
        let seller = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        let collaborators = vec![&env, admin.clone(), b.clone()];
        let shares = vec![&env, 5000_u32, 5000_u32];
        client.initialize(&collaborators, &shares);

        // Mint royalty tokens to seller, then record secondary royalty
        mint(&env, &token, &token_admin, &seller, 200);
        client.record_secondary_royalty(&token, &seller, &200_i128);

        // Pool should reflect real tokens
        assert_eq!(client.get_secondary_pool(), 200);
        assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 200);

        client.distribute_secondary_royalties();

        assert_eq!(TokenClient::new(&env, &token).balance(&admin), 100);
        assert_eq!(TokenClient::new(&env, &token).balance(&b), 100);
        assert_eq!(client.get_secondary_pool(), 0);
    }

    #[test]
    #[should_panic(expected = "pool exceeds contract balance")]
    fn test_distribute_secondary_panics_when_pool_exceeds_balance() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup(&env);

        let admin = Address::generate(&env);
        let b = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token = make_token(&env, &token_admin);

        let collaborators = vec![&env, admin.clone(), b.clone()];
        let shares = vec![&env, 5000_u32, 5000_u32];
        client.initialize(&collaborators, &shares);

        // Manually set pool > balance by minting to contract then draining via distribute,
        // then calling distribute_secondary_royalties with a stale pool value.
        // Simplest: mint to contract, record pool via secondary royalty, then drain balance.
        mint(&env, &token, &token_admin, &contract_id, 100);
        // Directly set pool to 500 while balance is only 100 by calling distribute first
        // to drain, leaving pool > balance scenario.
        // We simulate this by funding 100, distributing 100 (drains balance),
        // then trying to distribute_secondary_royalties with pool=100 but balance=0.
        client.distribute(&token, &100_i128); // drains balance to 0

        // Now set up a secondary pool of 100 with no backing balance
        // We can't call record_secondary_royalty (no tokens), so we test the assertion
        // by minting to contract and then distributing primary first to drain it.
        // Instead: mint fresh tokens, record secondary royalty (funds contract),
        // then drain via primary distribute, leaving pool > balance.
        mint(&env, &token, &token_admin, &contract_id, 100);
        client.record_secondary_royalty(&token, &contract_id, &100_i128);
        // pool = 100, balance = 100; now drain balance via primary distribute
        client.distribute(&token, &100_i128); // balance = 0, pool still = 100
        client.distribute_secondary_royalties(); // should panic
    }
}
