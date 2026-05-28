#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token, Address, Env, Map, Vec, String,
};

#[contracttype]
#[derive(Clone)]
pub struct Recipient {
    pub address: Address,
    pub share: u32,
}

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
    /// Can only be called once. The first address in `collaborators` becomes
    /// the admin and must authorize this transaction.
    ///
    /// # Arguments
    /// * `collaborators` - Ordered list of wallet addresses that will receive payouts.
    ///   The first address is designated as admin. Maximum of 10 recipients allowed.
    /// * `shares` - Basis-point allocations corresponding to each collaborator
    ///   (1 bp = 0.01%). Must sum to exactly 10,000 (100%).
    ///
    /// # Authorization
    /// Requires signature from `collaborators[0]` (the admin).
    ///
    /// # Panics
    /// * `"already initialized"` — contract has already been set up
    /// * `"need at least one collaborator"` — empty collaborator list
    /// * `"too many recipients: maximum 10 allowed"` — more than 10 recipients
    /// * `"collaborators and shares length mismatch"` — vec lengths differ
    /// * `"shares must sum to 10000"` — allocations don't total 100%
    /// * `"share cannot be zero"` — any individual share is 0
    /// * `"duplicate collaborator address"` — same address appears more than once
    pub fn initialize(
        env: Env,
        collaborators: Vec<Address>,
        shares: Vec<u32>,
    ) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }

        if collaborators.is_empty() {
            panic!("need at least one collaborator");
        }

        if collaborators.len() > 10 {
            panic!("too many recipients: maximum 10 allowed");
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

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("init")),
            (collaborators, shares),
        );
    }

    /// Set the secondary royalty rate for resales.
    ///
    /// # Arguments
    /// * `new_rate` - Royalty rate in basis points (0–10,000). 0 disables royalties;
    ///   10,000 means 100% of the sale price goes to the royalty pool.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"royalty rate cannot exceed 10000 basis points"` — `new_rate > 10_000`
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

    /// Pause the contract — halts `distribute` and `distribute_secondary_royalties`.
    ///
    /// While paused, any call to `distribute` or `distribute_secondary_royalties`
    /// will panic with `"contract is paused"`. Read-only functions are unaffected.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
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

    /// Transfer admin rights to a new address.
    ///
    /// # Arguments
    /// * `new_admin` - Address that will become the contract admin.
    ///
    /// # Authorization
    /// Requires signature from the current admin.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn admin_transfer(env: Env, new_admin: Address) {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");

        admin.require_auth();

        let previous_admin = admin.clone();
        env.storage().instance().set(&DataKey::Admin, &new_admin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("admin_xfr")),
            (previous_admin, new_admin),
        );
    }

    /// Unpause the contract — re-enables `distribute` and `distribute_secondary_royalties`.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
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

    /// Returns `true` if the contract is currently paused, `false` otherwise.
    /// Defaults to `false` before `pause` is ever called.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Returns `true` if `initialize` has been called, `false` otherwise.
    ///
    /// Safe to call at any time — does not require initialization.
    /// Extends TTL on every call so the storage entry stays live.
    pub fn is_initialized(env: Env) -> bool {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage().instance().has(&DataKey::Admin)
    }

    /// Returns the contract's current on-chain balance of `token`.
    ///
    /// # Arguments
    /// * `token` - The token contract address to query.
    pub fn get_balance(env: Env, token: Address) -> i128 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    /// Alias for `get_balance`. Returns the contract's on-chain balance of `token`.
    ///
    /// # Arguments
    /// * `token` - The token contract address to query.
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
    ///
    /// # Panics
    /// * `"recipients list cannot be empty"` — no collaborators are configured
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

        let collaborators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Collaborators)
            .expect("no collaborators");

        if collaborators.is_empty() {
            panic!("recipients list cannot be empty");
        }

        if Self::get_total_shares(env.clone()) != 10_000 {
            panic!("total shares must sum to 10000");
        }

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            panic!("no balance to distribute");
        }

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
            let payout = (amount as u128 * share as u128 / 10_000) as i128;
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

    /// Record a secondary royalty payment transferred from a resale.
    ///
    /// Pulls `royalty_amount` of `token` from `from` into the contract's
    /// secondary pool via `transfer_from`. The caller must have pre-approved
    /// the contract as a spender for at least `royalty_amount`.
    ///
    /// # Arguments
    /// * `token` - Token used for the royalty payment.
    /// * `from` - Address paying the royalty (typically the marketplace or buyer).
    /// * `royalty_amount` - Amount in token's smallest unit (e.g., stroops for XLM).
    ///
    /// # Authorization
    /// Requires signature from `from`.
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
    /// Splits the entire secondary pool proportionally by basis-point shares.
    /// Resets the pool to zero after distribution. The last collaborator absorbs
    /// any integer-division dust (bounded by `n - 1` stroops).
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"contract is paused"` — contract is currently paused
    /// * `"no secondary royalties to distribute"` — pool is empty
    /// * `"no secondary token set"` — no royalty has ever been recorded
    /// * `"pool exceeds contract balance"` — pool accounting is inconsistent
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
            let payout = (pool as u128 * share as u128 / 10_000) as i128;
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

    /// Calculate and return the royalty amount for a given secondary sale price.
    ///
    /// This is a pure read function — it does not transfer tokens or modify state.
    /// Use it to preview the royalty before calling `record_secondary_royalty`.
    ///
    /// # Arguments
    /// * `sale_price` - The resale price in token's smallest unit (must be > 0).
    ///
    /// # Returns
    /// `sale_price * royalty_rate / 10_000`. Returns 0 if no rate has been set.
    ///
    /// # Panics
    /// * `"sale price must be positive"` — `sale_price <= 0`
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

        (sale_price as u128 * rate as u128 / 10_000) as i128
    }

    /// Returns the current secondary royalty rate in basis points (0–10,000).
    /// Returns 0 if `set_royalty_rate` has never been called.
    pub fn get_royalty_rate(env: Env) -> u32 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage().instance().get(&DataKey::RoyaltyRate).unwrap_or(0)
    }

    /// Returns all recipients as an ordered list of (address, share) pairs.
    ///
    /// Each entry contains the collaborator's address and their basis-point share.
    /// Preserves the insertion order from `initialize`. Returns an empty vec if
    /// called before initialization.
    pub fn get_recipients(env: Env) -> Vec<Recipient> {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);

        let collaborators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Collaborators)
            .unwrap_or(Vec::new(&env));

        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::ShareMap)
            .unwrap_or(Map::new(&env));

        let mut recipients: Vec<Recipient> = Vec::new(&env);
        for addr in collaborators.iter() {
            let share = share_map.get(addr.clone()).unwrap_or(0);
            recipients.push_back(Recipient { address: addr, share });
        }
        recipients
    }

    /// Returns the contract's semantic version string (set from `CARGO_PKG_VERSION`
    /// at initialization time).
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn version(env: Env) -> String {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        env.storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .expect("contract not initialized")
    }

    /// Returns the basis-point share for a registered collaborator.
    ///
    /// # Arguments
    /// * `collaborator` - Address to look up.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"collaborator not found"` — address is not a registered collaborator
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
    ///
    /// Safe to call before initialization — returns `false` rather than panicking.
    ///
    /// # Arguments
    /// * `addr` - Address to check.
    pub fn is_collaborator(env: Env, addr: Address) -> bool {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::ShareMap)
            .unwrap_or(Map::new(&env));

        share_map.contains_key(addr)
    }

    /// Returns the number of registered collaborators.
    /// Returns 0 if called before initialization.
    pub fn collaborator_count(env: Env) -> u32 {
        env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
        let collaborators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Collaborators)
            .unwrap_or(Vec::new(&env));
        collaborators.len()
    }

    /// Returns the ordered list of all registered collaborator addresses.
    /// Returns an empty vec if called before initialization.
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

    /// Returns the current size of the secondary royalty pool (undistributed amount).
    /// Returns 0 if no royalties have been recorded yet.
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

    /// Returns the sum of all collaborator basis-point shares.
    ///
    /// Under normal operation this always returns 10,000. Useful for
    /// pre-flight validation before calling `distribute`.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
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
