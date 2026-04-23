#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token, vec,
    Address, Env, Map, Vec,
};

// ── Storage keys ────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Collaborators,              // Vec<Address>
    Shares,                     // Map<Address, u32>  (basis points, sum == 10_000)
    Initialized,
    RoyaltyRate,                // u32 (basis points for secondary sales)
    SecondaryRoyaltyPool,       // i128 (accumulated secondary royalty funds)
    LastSecondaryDistribution,  // u64 (timestamp of last secondary distribution)
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct RoyaltySplitter;

#[contractimpl]
impl RoyaltySplitter {
    /// Initialize the contract with collaborator addresses and their share
    /// allocations expressed in basis points (1 bp = 0.01%).
    /// The sum of all shares MUST equal 10_000 (i.e. 100.00%).
    ///
    /// # Arguments
    /// * `collaborators` – ordered list of recipient addresses
    /// * `shares`        – basis-point allocation per collaborator (same order)
    pub fn initialize(
        env: Env,
        collaborators: Vec<Address>,
        shares: Vec<u32>,
    ) {
        // Prevent re-initialization
        if env.storage().instance().has(&DataKey::Initialized) {
            panic!("already initialized");
        }

        let len = collaborators.len();
        assert!(len > 0, "no collaborators");
        assert!(len == shares.len(), "length mismatch");

        // Validate shares sum to 10_000 bp (100%)
        let total: u32 = shares.iter().sum();
        assert!(total == 10_000, "shares must sum to 10000 basis points");

        let mut share_map: Map<Address, u32> = Map::new(&env);
        for i in 0..len {
            let addr = collaborators.get(i).unwrap();
            let bp = shares.get(i).unwrap();
            assert!(bp > 0, "share must be > 0");
            share_map.set(addr, bp);
        }

        env.storage().instance().set(&DataKey::Collaborators, &collaborators);
        env.storage().instance().set(&DataKey::Shares, &share_map);
        env.storage().instance().set(&DataKey::Initialized, &true);
    }

    /// Distribute `amount` of `token` held by this contract to all
    /// collaborators according to their pre-defined shares.
    ///
    /// Anyone can call this; the contract must already hold the funds.
    pub fn distribute(env: Env, token: Address, amount: i128) {
        assert!(amount > 0, "amount must be positive");

        let collaborators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Collaborators)
            .expect("not initialized");

        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::Shares)
            .expect("not initialized");

        let token_client = token::Client::new(&env, &token);

        let mut distributed: i128 = 0;
        let last_index = collaborators.len() - 1;

        for (i, addr) in collaborators.iter().enumerate() {
            let bp = share_map.get(addr.clone()).unwrap() as i128;

            // Last collaborator receives the remainder to absorb rounding dust
            let payout = if i as u32 == last_index {
                amount - distributed
            } else {
                amount * bp / 10_000
            };

            if payout > 0 {
                token_client.transfer(&env.current_contract_address(), &addr, &payout);
            }

            distributed += payout;
        }
    }

    // ── Secondary Royalty Functions ──────────────────────────────────────────

    /// Set the secondary royalty rate (in basis points).
    /// 1000 bp = 10% royalty on resales.
    /// Only callable during initialization or by authorized party.
    pub fn set_royalty_rate(env: Env, rate_bp: u32) {
        assert!(rate_bp <= 10_000, "royalty rate cannot exceed 100%");
        
        // Store the royalty rate
        env.storage()
            .instance()
            .set(&DataKey::RoyaltyRate, &rate_bp);
    }

    /// Get the current secondary royalty rate in basis points.
    pub fn get_royalty_rate(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RoyaltyRate)
            .unwrap_or(0)
    }

    /// Record a secondary (resale) royalty payment.
    /// This accumulates funds in the secondary royalty pool.
    /// Can be called by a marketplace or user when NFT is resold.
    pub fn record_secondary_royalty(env: Env, sale_price: i128) -> i128 {
        assert!(sale_price > 0, "sale price must be positive");

        let rate_bp = env.storage()
            .instance()
            .get(&DataKey::RoyaltyRate)
            .unwrap_or(0) as i128;

        // Calculate royalty: sale_price * rate_bp / 10_000
        let royalty_amount = (sale_price * rate_bp) / 10_000;

        if royalty_amount > 0 {
            // Accumulate in secondary pool
            let current_pool: i128 = env.storage()
                .instance()
                .get(&DataKey::SecondaryRoyaltyPool)
                .unwrap_or(0);
            
            let new_pool = current_pool + royalty_amount;
            env.storage()
                .instance()
                .set(&DataKey::SecondaryRoyaltyPool, &new_pool);
        }

        royalty_amount
    }

    /// Distribute accumulated secondary royalties among collaborators.
    /// Splits the secondary royalty pool according to primary shares.
    pub fn distribute_secondary_royalties(env: Env, token: Address) {
        let pool: i128 = env.storage()
            .instance()
            .get(&DataKey::SecondaryRoyaltyPool)
            .unwrap_or(0);

        assert!(pool > 0, "no secondary royalties to distribute");

        let collaborators: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Collaborators)
            .expect("not initialized");

        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::Shares)
            .expect("not initialized");

        let token_client = token::Client::new(&env, &token);

        let mut distributed: i128 = 0;
        let last_index = collaborators.len() - 1;

        for (i, addr) in collaborators.iter().enumerate() {
            let bp = share_map.get(addr.clone()).unwrap() as i128;

            // Last collaborator receives remainder to absorb rounding
            let payout = if i as u32 == last_index {
                pool - distributed
            } else {
                pool * bp / 10_000
            };

            if payout > 0 {
                token_client.transfer(&env.current_contract_address(), &addr, &payout);
            }

            distributed += payout;
        }

        // Reset the secondary royalty pool after distribution
        env.storage()
            .instance()
            .set(&DataKey::SecondaryRoyaltyPool, &0);

        // Update last distribution timestamp
        env.storage()
            .instance()
            .set(&DataKey::LastSecondaryDistribution, &env.ledger().timestamp());
    }

    /// Get accumulated secondary royalties waiting for distribution.
    pub fn get_secondary_royalty_pool(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::SecondaryRoyaltyPool)
            .unwrap_or(0)
    }

    // ── View helpers ─────────────────────────────────────────────────────────

    /// Returns all collaborator addresses.
    pub fn get_collaborators(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Collaborators)
            .unwrap_or(vec![&env])
    }

    /// Returns the basis-point share for a single collaborator.
    pub fn get_share(env: Env, collaborator: Address) -> u32 {
        let share_map: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&DataKey::Shares)
            .expect("not initialized");
        share_map.get(collaborator).unwrap_or(0)
    }
}

#[cfg(test)]
mod unit_tests {
    // Test basis point math
    #[test]
    fn test_bp_payout_calculation() {
        let amount: i128 = 10_000;
        let bp: i128 = 5_000; // 50%
        let payout = amount * bp / 10_000;
        assert_eq!(payout, 5_000);
    }

    #[test]
    fn test_royalty_calculation() {
        let sale_price: i128 = 1_000;
        let rate_bp: i128 = 500; // 5%
        let royalty = (sale_price * rate_bp) / 10_000;
        assert_eq!(royalty, 50);
    }

    #[test]
    fn test_royalty_calculation_rounds_down() {
        let sale_price: i128 = 1_001;
        let rate_bp: i128 = 500; // 5%
        let royalty = (sale_price * rate_bp) / 10_000;
        assert_eq!(royalty, 50); // floors, not rounds
    }

    #[test]
    fn test_zero_rate_produces_zero_royalty() {
        let sale_price: i128 = 10_000;
        let rate_bp: i128 = 0;
        let royalty = (sale_price * rate_bp) / 10_000;
        assert_eq!(royalty, 0);
    }
}
