#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token, Address, Env, Map, Vec, String,
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
    ContractVersion,
    RoyaltyRate,
    LastDistribution,
    LastSecondaryDistribution,
    Paused,
}

const MIN_TTL: u32 = 17_280;
const MAX_TTL: u32 = 34_560;

#[contract]
pub struct RoyaltySplitter;

#[contractimpl]
impl RoyaltySplitter {

    /// Initialize the contract with collaborators and their revenue shares.
    ///
    /// # Arguments
    /// * `collaborators` - List of wallet addresses that will receive payouts
    /// * `shares` - Corresponding basis-point allocations (must sum to 10,000)
    ///
    /// # Panics
    /// * If already initialized
    /// * If shares don't sum to exactly 10,000 basis points (100%)
    /// * If any share is zero or if there are duplicate addresses
    pub fn initialize(
        env: Env,
        collaborators: Vec<Address>,
        shares: Vec<u32>,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }

        if collaborators.is_empty() {
            panic!("need at least one collaborator");
        }

        // The first collaborator is the admin and must sign the init tx,
        // preventing any third party from front-running initialization.
        collaborators.get(0).unwrap().require_auth();

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
            let share = shares.get(i).unwrap();

            if share == 0 {
                panic!("share cannot be zero");
            }

            if share_map.contains_key(addr.clone()) {
                panic!("duplicate collaborator address");
            }

            share_map.set(addr, share);
        }

        let admin = collaborators.get(0).unwrap();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Collaborators, &collaborators);
        env.storage().instance().set(&DataKey::ShareMap, &share_map);

        let version = String::from_str(&env, env!("CARGO_PKG_VERSION"));
        env.storage().instance().set(&DataKey::ContractVersion, &version);
    }

    /// Set the secondary royalty rate for resales.
    ///
    /// # Arguments
    /// * `new_rate` - Royalty rate in basis points (e.g., 500 = 5%)
    ///
    /// # Authorization
    /// Requires admin signature
    pub fn set_royalty_rate(env: Env, new_rate: u32) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");

        admin.require_auth();

        if new_rate > 10_000 {
            panic!("royalty rate cannot exceed 10000 basis points");
        }

        env.storage().instance().set(&DataKey::RoyaltyRate, &new_rate);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rate_set")),
            new_rate,
        );
    }

    /// Pause the contract — halts distribute and distribute_secondary_royalties.
    /// Requires admin authorization.
    pub fn pause(env: Env) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");

        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
    }

    /// Unpause the contract — re-enables distribute and distribute_secondary_royalties.
    /// Requires admin authorization.
    pub fn unpause(env: Env) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");

        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    /// Returns true if the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Returns true if the contract has been initialized.
    pub fn is_initialized(env: Env) -> bool {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage().instance().has(&DataKey::Admin)
    }

    /// Returns the contract's current balance of `token`.
    pub fn get_balance(env: Env, token: Address) -> i128 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    /// Returns the contract's balance of a specific token.
    pub fn get_token_balance(env: Env, token: Address) -> i128 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    /// Distribute the full contract balance of `token` to all collaborators.
    ///
    /// # Arguments
    /// * `token` - The token address to distribute (e.g., XLM or other Stellar asset)
    ///
    /// # Distribution Logic
    /// Each collaborator receives: (total_amount * their_share) / 10,000
    /// The last collaborator receives any remaining dust from integer division rounding.
    ///
    /// # Authorization
    /// Requires admin signature
    pub fn distribute(env: Env, token: Address) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");

        admin.require_auth();

        if env.storage().instance().get::<DataKey, bool>(&DataKey::Paused).unwrap_or(false) {
            panic!("contract is paused");
        }

        if Self::get_total_shares(env.clone()) != 10_000 {
            panic!("total shares must sum to 10000");
        }

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            panic!("no balance to distribute");
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
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;

        // Calculate payouts for all collaborators except the last one
        for i in 0..(n - 1) {
            let addr = collaborators.get(i).unwrap();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = amount * share as i128 / 10_000;
            payouts.push_back((addr, payout));
            total_calculated += payout;
        }

        // Last collaborator receives the remainder to avoid dust loss.
        // Dust is bounded by (n - 1) stroops in the worst case.
        let last = collaborators.get(n - 1).unwrap();
        payouts.push_back((last, amount - total_calculated));

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events().publish((symbol_short!("dist"),), (addr, payout));
        }

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("dist_all")),
            (token, amount),
        );

        env.storage()
            .instance()
            .set(&DataKey::LastDistribution, &env.ledger().timestamp());
    }

    /// Record a secondary royalty payment from a resale.
    ///
    /// # Authorization
    /// Requires signature from the `from` address
    pub fn record_secondary_royalty(
        env: Env,
        token: Address,
        from: Address,
        royalty_amount: i128,
    ) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
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

        env.storage().instance().set(&DataKey::SecondaryToken, &token);
    }

    /// Distribute all accumulated secondary royalties to collaborators.
    ///
    /// # Authorization
    /// Requires admin signature
    pub fn distribute_secondary_royalties(env: Env) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");

        admin.require_auth();

        if env.storage().instance().get::<DataKey, bool>(&DataKey::Paused).unwrap_or(false) {
            panic!("contract is paused");
        }

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
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;

        for i in 0..(n - 1) {
            let addr = collaborators.get(i).unwrap();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = pool * share as i128 / 10_000;
            payouts.push_back((addr, payout));
            total_calculated += payout;
        }

        // Last collaborator receives the remainder. Dust bounded by (n - 1) stroops.
        let last = collaborators.get(n - 1).unwrap();
        payouts.push_back((last, pool - total_calculated));

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events().publish((symbol_short!("sec_dist"),), (addr, payout));
        }

        env.storage().instance().set(&DataKey::SecondaryPool, &0_i128);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("sec_dist")),
            (token, pool),
        );

        env.storage()
            .instance()
            .set(&DataKey::LastSecondaryDistribution, &env.ledger().timestamp());
    }

    /// Calculate the royalty amount for a secondary sale.
    pub fn record_secondary_sale(env: Env, sale_price: i128) -> i128 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        if sale_price <= 0 {
            panic!("sale price must be positive");
        }

        let rate: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RoyaltyRate)
            .unwrap_or(0);

        sale_price * rate as i128 / 10_000
    }

    pub fn get_royalty_rate(env: Env) -> u32 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage().instance().get(&DataKey::RoyaltyRate).unwrap_or(0)
    }

    pub fn version(env: Env) -> String {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .expect("contract not initialized")
    }

    pub fn get_share(env: Env, collaborator: Address) -> u32 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::ShareMap)
            .expect("contract not initialized");

        share_map.get(collaborator).expect("collaborator not found")
    }

    /// Update a collaborator's share allocation.
    ///
    /// # Authorization
    /// Requires admin signature
    pub fn update_share(env: Env, collaborator: Address, new_share: u32) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");

        admin.require_auth();

        let mut share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::ShareMap)
            .expect("contract not initialized");

        if !share_map.contains_key(collaborator.clone()) {
            panic!("collaborator not found");
        }

        let old_share = share_map.get(collaborator.clone()).unwrap();
        let current_total = Self::get_total_shares(env.clone());
        let new_total = current_total - old_share + new_share;

        if new_total != 10_000 {
            panic!("shares must sum to 10000 after update");
        }

        if new_share == 0 {
            panic!("share cannot be zero");
        }

        share_map.set(collaborator.clone(), new_share);
        env.storage().instance().set(&DataKey::ShareMap, &share_map);

        env.events().publish(
            (symbol_short!("share"), symbol_short!("updated")),
            (collaborator, new_share),
        );
    }

    /// Returns true if the given address is a registered collaborator.
    pub fn is_collaborator(env: Env, addr: Address) -> bool {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::ShareMap)
            .unwrap_or(Map::new(&env));

        share_map.contains_key(addr)
    }

    pub fn collaborator_count(env: Env) -> u32 {
        let collaborators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Collaborators)
            .unwrap_or(Vec::new(&env));
        collaborators.len()
    }

    pub fn get_collaborators(env: Env) -> Vec<Address> {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage()
            .instance()
            .get(&DataKey::Collaborators)
            .unwrap_or(Vec::new(&env))
    }

    /// Returns the full share map (Address → basis points) in a single call.
    pub fn get_all_shares(env: Env) -> Map<Address, u32> {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage()
            .instance()
            .get(&DataKey::ShareMap)
            .unwrap_or(Map::new(&env))
    }

    pub fn get_secondary_pool(env: Env) -> i128 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage().instance().get(&DataKey::SecondaryPool).unwrap_or(0)
    }

    /// Returns the timestamp of the last primary distribution, or None if never distributed.
    pub fn get_last_distribution(env: Env) -> Option<u64> {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage().instance().get(&DataKey::LastDistribution)
    }

    /// Returns the timestamp of the last secondary distribution, or None if never distributed.
    pub fn get_last_secondary_distribution(env: Env) -> Option<u64> {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage().instance().get(&DataKey::LastSecondaryDistribution)
    }

    /// Calculate the sum of all collaborator shares.
    pub fn get_total_shares(env: Env) -> u32 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::ShareMap)
            .expect("contract not initialized");

        let mut total = 0;
        for item in share_map.iter() {
            total += item.1;
        }
        total
    }
}
