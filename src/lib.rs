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

    /// Distribute `amount` of `token` from the contract balance to all collaborators.
    pub fn distribute(env: Env, token: Address, amount: i128) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");
        admin.require_auth();

        let token_client = token::Client::new(&env, &token);

        // Assert full balance is available before any transfers begin.
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

        // Pre-calculate all payouts before executing any transfers.
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;
        for i in 0..(n - 1) {
            let addr = collaborators.get(i).unwrap();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = amount * share as i128 / 10_000;
            payouts.push_back((addr, payout));
            total_calculated += payout;
        }
        // Last collaborator gets the remainder to avoid rounding dust loss.
        let last = collaborators.get(n - 1).unwrap();
        payouts.push_back((last, amount - total_calculated));

        // All validation passed — execute transfers.
        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events().publish((symbol_short!("dist"),), (addr, payout));
        }
    }

    /// Record a secondary-market royalty: caller must pre-approve the contract to
    /// pull `royalty_amount` tokens via transfer_from.
    pub fn record_secondary_royalty(
        env: Env,
        token: Address,
        from: Address,
        royalty_amount: i128,
    ) {
        from.require_auth();

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

        let token_client = token::Client::new(&env, &token);

        // Assert full pool is available before any transfers begin.
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

        // Pre-calculate all payouts before executing any transfers.
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;
        for i in 0..(n - 1) {
            let addr = collaborators.get(i).unwrap();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = pool * share as i128 / 10_000;
            payouts.push_back((addr, payout));
            total_calculated += payout;
        }
        let last = collaborators.get(n - 1).unwrap();
        payouts.push_back((last, pool - total_calculated));

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
        }

        env.storage().instance().set(&DataKey::SecondaryPool, &0_i128);
    }

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
        token::{Client as TokenClient, StellarAssetClient},
        vec, Address, Env,
    };

    fn setup(env: &Env) -> (Address, RoyaltySplitterClient) {
        let contract_id = env.register_contract(None, RoyaltySplitter);
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
    fn test_admin_is_stored_on_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        client.initialize(&vec![&env, a.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
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

        client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
        mint(&env, &token, &contract_id, 1000);
        client.distribute(&token, &1000_i128);

        assert_eq!(TokenClient::new(&env, &token).balance(&admin), 500);
        assert_eq!(TokenClient::new(&env, &token).balance(&b), 500);
    }

    #[test]
    #[should_panic(expected = "duplicate collaborator address")]
    fn test_duplicate_collaborator_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (_, client) = setup(&env);
        let a = Address::generate(&env);
        client.initialize(&vec![&env, a.clone(), a.clone()], &vec![&env, 5000_u32, 5000_u32]);
    }

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

        client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);
        mint(&env, &token, &contract_id, 500);
        client.distribute(&token, &1000_i128);
    }

    /// Issue #92 — balance validated before loop; no partial distribution possible.
    /// With 3 collaborators, if the contract only holds enough for the first payout,
    /// the balance check must fire before any transfer occurs.
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

        // 3-way split: 50 / 30 / 20
        client.initialize(
            &vec![&env, admin.clone(), b.clone(), c.clone()],
            &vec![&env, 5000_u32, 3000_u32, 2000_u32],
        );

        // Fund only 300 but request distribution of 1000.
        // Without the pre-loop balance check, the first transfer (500) would succeed,
        // the second (300) would succeed, and the third (200) would fail — leaving a
        // partial state. The guard must reject the whole call upfront.
        mint(&env, &token, &contract_id, 300);
        client.distribute(&token, &1000_i128);

        // Verify no collaborator received anything (guard fired before any transfer).
        assert_eq!(TokenClient::new(&env, &token).balance(&admin), 0);
        assert_eq!(TokenClient::new(&env, &token).balance(&b), 0);
        assert_eq!(TokenClient::new(&env, &token).balance(&c), 0);
    }

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

        client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

        mint(&env, &token, &seller, 200);
        client.record_secondary_royalty(&token, &seller, &200_i128);

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

        client.initialize(&vec![&env, admin.clone(), b.clone()], &vec![&env, 5000_u32, 5000_u32]);

        // Fund contract, record secondary royalty (pool = 100, balance = 100),
        // then drain balance via primary distribute — pool > balance.
        mint(&env, &token, &contract_id, 100);
        client.record_secondary_royalty(&token, &contract_id, &100_i128);
        client.distribute(&token, &100_i128); // balance → 0, pool still = 100
        client.distribute_secondary_royalties(); // should panic
    }
}
