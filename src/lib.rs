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
}

#[contract]
pub struct RoyaltySplitter;

#[contractimpl]
impl RoyaltySplitter {

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

        if collaborators.len() != shares.len() {
            panic!("collaborators and shares length mismatch");
        }

        let total: u32 = shares.iter().sum();

        if total != 10_000 {
            panic!("shares must sum to 10000");
        }

        let mut share_map: Map<Address, u32> =
            Map::new(&env);

        for i in 0..collaborators.len() {

            let addr = collaborators.get(i).unwrap();
            let share = shares.get(i).unwrap();

            if share == 0 {
                panic!("share cannot be zero");
            }

            if share_map.contains_key(addr.clone()) {
                panic!("duplicate collaborator address");
            }

            share_map.set(
                addr,
                share,
            );
        }

        let admin =
            collaborators.get(0).unwrap();

        env.storage()
            .instance()
            .set(&DataKey::Admin, &admin);

        env.storage()
            .instance()
            .set(
                &DataKey::Collaborators,
                &collaborators,
            );

        env.storage()
            .instance()
            .set(
                &DataKey::ShareMap,
                &share_map,
            );

        let version =
            String::from_str(
                &env,
                env!("CARGO_PKG_VERSION"),
            );

        env.storage()
            .instance()
            .set(
                &DataKey::ContractVersion,
                &version,
            );
    }

    pub fn set_royalty_rate(
        env: Env,
        new_rate: u32,
    ) {

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");

        admin.require_auth();

        if new_rate > 10_000 {
            panic!("royalty rate cannot exceed 10000 basis points");
        }

        env.storage()
            .instance()
            .set(
                &DataKey::RoyaltyRate,
                &new_rate,
            );
    }

    pub fn distribute(
        env: Env,
        token: Address,
        amount: i128,
    ) {

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized");

        admin.require_auth();
        
        if Self::get_total_shares(env.clone()) != 10_000 {
            panic!("total shares must sum to 10000");
        }

        let token_client =
            token::Client::new(&env, &token);

        let balance =
            token_client.balance(
                &env.current_contract_address(),
            );

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

        let mut payouts:
            Vec<(Address, i128)> =
            Vec::new(&env);

        let mut total_calculated: i128 = 0;

        for i in 0..(n - 1) {

            let addr =
                collaborators.get(i).unwrap();

            let share =
                share_map
                    .get(addr.clone())
                    .unwrap_or(0);

            let payout =
                amount * share as i128 / 10_000;

            payouts.push_back((addr, payout));

            total_calculated += payout;
        }

        let last =
            collaborators.get(n - 1).unwrap();

        payouts.push_back((
            last,
            amount - total_calculated,
        ));

        for (addr, payout) in payouts.iter() {

            token_client.transfer(
                &env.current_contract_address(),
                &addr,
                &payout,
            );

            env.events().publish(
                (symbol_short!("dist"),),
                (addr, payout),
            );
        }
    }

    pub fn record_secondary_royalty(
        env: Env,
        token: Address,
        from: Address,
        royalty_amount: i128,
    ) {

        from.require_auth();

        let token_client =
            token::Client::new(&env, &token);

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
            .set(
                &DataKey::SecondaryPool,
                &(current_pool + royalty_amount),
            );

        env.storage()
            .instance()
            .set(
                &DataKey::SecondaryToken,
                &token,
            );
    }

    pub fn distribute_secondary_royalties(
        env: Env,
    ) {

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

        let token_client =
            token::Client::new(&env, &token);

        let balance =
            token_client.balance(
                &env.current_contract_address(),
            );

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

        let mut payouts:
            Vec<(Address, i128)> =
            Vec::new(&env);

        let mut total_calculated: i128 = 0;

        for i in 0..(n - 1) {

            let addr =
                collaborators.get(i).unwrap();

            let share =
                share_map
                    .get(addr.clone())
                    .unwrap_or(0);

            let payout =
                pool * share as i128 / 10_000;

            payouts.push_back((addr, payout));

            total_calculated += payout;
        }

        let last =
            collaborators.get(n - 1).unwrap();

        payouts.push_back((
            last,
            pool - total_calculated,
        ));

        for (addr, payout) in payouts.iter() {

            token_client.transfer(
                &env.current_contract_address(),
                &addr,
                &payout,
            );

            env.events().publish(
                (symbol_short!("sec_dist"),),
                (addr, payout),
            );
        }

        env.storage()
            .instance()
            .set(
                &DataKey::SecondaryPool,
                &0_i128,
            );
    }

    pub fn record_secondary_sale(
        env: Env,
        sale_price: i128,
    ) -> i128 {

        if sale_price <= 0 {
            panic!("sale price must be positive");
        }

        let rate: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RoyaltyRate)
            .unwrap_or(0);

        let royalty_amount =
            sale_price * rate as i128 / 10_000;

        royalty_amount
    }

    pub fn get_royalty_rate(
        env: Env,
    ) -> u32 {

        env.storage()
            .instance()
            .get(&DataKey::RoyaltyRate)
            .unwrap_or(0)
    }

    pub fn version(
        env: Env,
    ) -> String {

        env.storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .expect("contract not initialized")
    }

    pub fn get_share(
        env: Env,
        collaborator: Address,
    ) -> u32 {

        let share_map: Map<Address, u32> =
            env.storage()
                .instance()
                .get(&DataKey::ShareMap)
                .expect("contract not initialized");

        share_map
            .get(collaborator)
            .unwrap_or(0)
    }

    pub fn get_collaborators(
        env: Env,
    ) -> Vec<Address> {

        env.storage()
            .instance()
            .get(&DataKey::Collaborators)
            .expect("contract not initialized")
    }

    pub fn get_admin(
        env: Env,
    ) -> Address {

        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("contract not initialized")
    }

    pub fn get_secondary_pool(
        env: Env,
    ) -> i128 {

        env.storage()
            .instance()
            .get(&DataKey::SecondaryPool)
            .unwrap_or(0)
    }

    pub fn get_total_shares(env: Env) -> u32 {
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