#![no_std]
pub mod auth;
mod storage;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    Map, String, Vec,
};

#[contracttype]
#[derive(Clone)]
pub struct Recipient {
    pub address: Address,
    pub share: u32,
}

/// One entry in the royalty rate change history (#323).
#[contracttype]
#[derive(Clone)]
pub struct RoyaltyRateChange {
    pub old_rate: u32,
    pub new_rate: u32,
    pub timestamp: u64,
    pub caller: Address,
}

/// Typed storage keys.
///
/// Instance storage keys: small, frequently accessed values (Admin, Paused, etc.).
/// Persistent storage keys: large or infrequently accessed values (Collaborators,
/// ShareMap, DefaultRecipients) — stored separately to avoid bloating the instance
/// entry and unnecessarily increasing ledger fees.
#[contracttype]
#[derive(Clone)]
pub enum StorageKey {
    // Instance storage
    Admin,
    SecondaryPool,
    SecondaryToken,
    ContractVersion,
    RoyaltyRate,
    LastDistribution,
    LastSecondaryDistribution,
    Paused,
    DistributeHistory,
    PendingAdmin,
    AdminList,
    AdminThreshold,
    // Persistent storage
    Collaborators,
    ShareMap,
    DefaultRecipients,
    RoyaltyRateHistory,
}

/// Maximum number of rate-change entries kept in history.
/// Older entries are dropped when the cap is reached.
pub const RATE_HISTORY_CAP: u32 = 20;

/// Backward-compatible alias for integration tests and external references.
pub type DataKey = StorageKey;

pub use storage::MIN_TTL;

/// On-chain contract version in [semantic versioning](https://semver.org/) format
/// (`MAJOR.MINOR.PATCH`, e.g. `"0.1.0"`).
///
/// Written to `StorageKey::ContractVersion` during `initialize` and exposed via
/// `get_version()`. Deploying upgraded WASM creates a new contract instance;
/// existing instances retain their stored version so integrators can detect
/// capability differences off-chain. No automatic state migration is performed
/// between versions — read `get_version()` before invoking version-specific
/// entrypoints and plan migrations explicitly when redeploying.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    Underfunded = 1,
    AlreadyInitialized,
    EmptyCollaborators,
    TooManyRecipients,
    LengthMismatch,
    InvalidShareTotal,
    ZeroShare,
    DuplicateRecipient,
    InvalidBasisPoints,
    NotInitialized,
    NoCollaborators,
    NoShareMap,
    ArithmeticOverflow,
    RoyaltyRateZero,
    RoyaltyRateTooHigh,
    ContractPaused,
    AmountNotPositive,
    InsufficientBalance,
    EmptyRecipients,
    AmountTooSmall,
    PoolExceedsBalance,
    NoSecondaryRoyalties,
    NoSecondaryToken,
    CollaboratorNotFound,
    InvalidUpdatedShareTotal,
    SalePriceNotPositive,
}

#[contract]
pub struct RoyaltySplitter;

#[contractimpl]
impl RoyaltySplitter {
    fn fail(env: &Env, error: ContractError) -> ! {
        soroban_sdk::panic_with_error!(env, error);
    }

    fn require_admin_address(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&StorageKey::Admin)
            .unwrap_or_else(|| Self::fail(env, ContractError::NotInitialized))
    }

    fn require_collaborators(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&StorageKey::Collaborators)
            .unwrap_or_else(|| Self::fail(env, ContractError::NoCollaborators))
    }

    fn require_share_map(env: &Env) -> Map<Address, u32> {
        env.storage()
            .instance()
            .get(&StorageKey::ShareMap)
            .unwrap_or_else(|| Self::fail(env, ContractError::NoShareMap))
    }

    fn checked_add_share_total(env: &Env, total: u32, share: u32) -> u32 {
        total
            .checked_add(share)
            .unwrap_or_else(|| Self::fail(env, ContractError::ArithmeticOverflow))
    }

    fn checked_bps_amount(env: &Env, amount: i128, bps: u32) -> i128 {
        if amount < 0 {
            Self::fail(env, ContractError::ArithmeticOverflow);
        }

        let numerator = (amount as u128)
            .checked_mul(bps as u128)
            .unwrap_or_else(|| Self::fail(env, ContractError::ArithmeticOverflow));
        let result = numerator / 10_000;
        if result > i128::MAX as u128 {
            Self::fail(env, ContractError::ArithmeticOverflow);
        }
        result as i128
    }

    /// Initialize the contract with collaborators and their revenue shares.
    ///
    /// Can only be called once. The first address in `collaborators` becomes
    /// the admin and must authorize this transaction.
    ///
    /// # Arguments
    /// * `collaborators` - Recipient wallet addresses; first is admin (max 10).
    /// * `shares` - Basis-point allocations per collaborator (must sum to 10,000).
    ///
    /// # Authorization
    /// Requires signature from `collaborators[0]` (the admin).
    ///
    /// # Panics
    /// On invalid collaborators/shares, duplicate addresses, or re-initialization.
    pub fn initialize(env: Env, collaborators: Vec<Address>, shares: Vec<u32>) {
        storage::extend_instance_ttl(&env);

        if env.storage().instance().has(&StorageKey::Admin) {
            Self::fail(&env, ContractError::AlreadyInitialized);
        }

        if collaborators.is_empty() {
            Self::fail(&env, ContractError::EmptyCollaborators);
        }

        if collaborators.len() > 10 {
            Self::fail(&env, ContractError::TooManyRecipients);
        }

        // The first collaborator is the admin and must sign the init tx,
        // preventing any third party from front-running initialization.
        auth::require_admin(
            &env,
            &collaborators.get(0).unwrap(),
            auth::msg::INITIALIZE_ADMIN,
        );

        if collaborators.len() != shares.len() {
            Self::fail(&env, ContractError::LengthMismatch);
        }

        let mut total: u32 = 0;
        for share in shares.iter() {
            total = Self::checked_add_share_total(&env, total, share);
        }

        if total != 10_000 {
            Self::fail(&env, ContractError::InvalidShareTotal);
        }

        let mut share_map: Map<Address, u32> = Map::new(&env);

        for i in 0..collaborators.len() {
            let addr = collaborators.get(i).unwrap();
            let share = shares.get(i).unwrap();

            if share == 0 {
                Self::fail(&env, ContractError::ZeroShare);
            }

            if share_map.contains_key(addr.clone()) {
                Self::fail(&env, ContractError::DuplicateRecipient);
            }

            share_map.set(addr, share);
        }

        let admin = collaborators.get(0).unwrap();

        storage::instance_set(&env, &StorageKey::Admin, &admin);
        // Collaborators and ShareMap go to persistent storage (#322)
        storage::persistent_set(&env, &StorageKey::Collaborators, &collaborators);
        storage::persistent_set(&env, &StorageKey::ShareMap, &share_map);

        let version = String::from_str(&env, VERSION);
        storage::instance_set(&env, &StorageKey::ContractVersion, &version);

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
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_ROYALTY_RATE_ADMIN);

        if new_rate == 0 {
            Self::fail(&env, ContractError::RoyaltyRateZero);
        }

        if new_rate > 10_000 {
            Self::fail(&env, ContractError::RoyaltyRateTooHigh);
        }

        // Read old rate before overwriting — 0 means never set.
        let old_rate: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0);

        storage::instance_set(&env, &StorageKey::RoyaltyRate, &new_rate);

        // Append to capped history in persistent storage (#323).
        // Gas note: one persistent read + write per call; capped at RATE_HISTORY_CAP
        // entries (~20 × ~80 bytes) so storage growth is bounded.
        let caller: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");

        let mut history: Vec<RoyaltyRateChange> =
            storage::persistent_get::<Vec<RoyaltyRateChange>>(&env, &StorageKey::RoyaltyRateHistory)
                .unwrap_or(Vec::new(&env));

        if history.len() >= RATE_HISTORY_CAP {
            // Drop the oldest entry to keep the vec at the cap.
            let mut trimmed: Vec<RoyaltyRateChange> = Vec::new(&env);
            for i in 1..history.len() {
                trimmed.push_back(history.get(i).unwrap());
            }
            history = trimmed;
        }

        history.push_back(RoyaltyRateChange {
            old_rate,
            new_rate,
            timestamp: env.ledger().timestamp(),
            caller,
        });

        storage::persistent_set(&env, &StorageKey::RoyaltyRateHistory, &history);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rate_set")),
            new_rate,
        );
    }

    /// Returns the on-chain history of royalty rate changes, oldest first.
    ///
    /// Each entry contains the old rate, new rate, block timestamp, and the
    /// admin address that made the change. Capped at [`RATE_HISTORY_CAP`]
    /// entries — once full, the oldest entry is dropped on each new change.
    ///
    /// Returns an empty vec if `set_royalty_rate` has never been called.
    pub fn get_royalty_rate_history(env: Env) -> Vec<RoyaltyRateChange> {
        storage::extend_instance_ttl(&env);
        storage::persistent_get::<Vec<RoyaltyRateChange>>(&env, &StorageKey::RoyaltyRateHistory)
            .unwrap_or(Vec::new(&env))
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
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PAUSE_ADMIN);
        storage::instance_set(&env, &StorageKey::Paused, &true);
    }

    /// Transfer admin rights to a new address (single-admin mode only).
    ///
    /// Immediate single-step transfer — the new admin does NOT need to confirm.
    /// Disabled when multi-sig is active; use `propose_admin_transfer` instead.
    ///
    /// # Arguments
    /// * `new_admin` - Address that will become the contract admin.
    ///
    /// # Authorization
    /// Requires signature from the current admin.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"use propose_admin_transfer when multi-sig is active"` — if AdminList is set
    pub fn admin_transfer(env: Env, new_admin: Address) {
        storage::extend_instance_ttl(&env);

        // Block single-step transfer when multi-sig is configured (#321 + #320 safety)
        if env.storage().instance().has(&StorageKey::AdminList) {
            panic!("use propose_admin_transfer when multi-sig is active");
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");

        auth::require_admin(&env, &admin, auth::msg::ADMIN_TRANSFER_ADMIN);

        let previous_admin = admin.clone();
        storage::instance_set(&env, &StorageKey::Admin, &new_admin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("admin_xfr")),
            (previous_admin, new_admin),
        );
    }

    /// Propose a new admin — first step of the two-step admin transfer (#320).
    ///
    /// Stores `new_admin` as pending; the transfer is not complete until
    /// `accept_admin` is called by `new_admin`.
    ///
    /// # Authorization
    /// Requires current admin (or multi-sig threshold) signature.
    pub fn propose_admin_transfer(env: Env, new_admin: Address) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PROPOSE_ADMIN_ADMIN);
        storage::instance_set(&env, &StorageKey::PendingAdmin, &new_admin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adm_prop")),
            new_admin,
        );
    }

    /// Accept a pending admin transfer — second step of the two-step flow (#320).
    ///
    /// Completes the transfer initiated by `propose_admin_transfer`. Only the
    /// address nominated in `propose_admin_transfer` can call this.
    ///
    /// # Authorization
    /// Requires signature from the *pending* admin (not the current admin).
    ///
    /// # Panics
    /// * `"no pending admin transfer"` — called without a prior `propose_admin_transfer`
    pub fn accept_admin(env: Env) {
        storage::extend_instance_ttl(&env);

        let pending: Address = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdmin)
            .expect("no pending admin transfer");

        // Only the pending (new) admin signs acceptance — not the current admin(s).
        let context = String::from_str(&env, auth::msg::ACCEPT_ADMIN_PENDING);
        env.events().publish((symbol_short!("auth_req"),), context);
        pending.require_auth();

        let previous_admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");

        storage::instance_set(&env, &StorageKey::Admin, &pending);
        env.storage().instance().remove(&StorageKey::PendingAdmin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adm_acc")),
            (previous_admin, pending),
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
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UNPAUSE_ADMIN);
        storage::instance_set(&env, &StorageKey::Paused, &false);
    }

    /// Replace the contract's executable WASM while preserving instance storage.
    ///
    /// The Wasm blob identified by `wasm_hash` must already be uploaded to the
    /// ledger. The upgrade takes effect after the current transaction completes;
    /// existing storage entries are unchanged.
    ///
    /// # Arguments
    /// * `wasm_hash` - SHA-256 hash of the uploaded replacement Wasm.
    ///
    /// # Authorization
    /// Requires admin signature.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn update_wasm(env: Env, wasm_hash: BytesN<32>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UPDATE_WASM_ADMIN);

        env.deployer().update_current_contract_wasm(wasm_hash);
    }

    /// Returns `true` if the contract is currently paused, `false` otherwise.
    /// Defaults to `false` before `pause` is ever called.
    pub fn is_paused(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::Paused)
            .unwrap_or(false)
    }

    /// Returns `true` if `initialize` has been called, `false` otherwise.
    ///
    /// Safe to call at any time — does not require initialization.
    /// Extends TTL on every call so the storage entry stays live.
    pub fn is_initialized(env: Env) -> bool {
        storage::extend_instance_ttl(&env);
        env.storage().instance().has(&StorageKey::Admin)
    }

    /// Returns the current contract admin address.
    ///
    /// Read-only view for integrators and frontends.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn get_admin(env: Env) -> Address {
        storage::extend_instance_ttl(&env);
        Self::require_admin_address(&env)
    }

    /// Returns the contract's current on-chain balance of `token`.
    ///
    /// # Arguments
    /// * `token` - The token contract address to query.
    pub fn get_balance(env: Env, token: Address) -> i128 {
        storage::extend_instance_ttl(&env);
        token::Client::new(&env, &token).balance(&env.current_contract_address())
    }

    /// Set the default recipient list for royalty distributions.
    ///
    /// This provides a fallback recipient list that can be used when no override
    /// list is supplied to distribute(). Useful for standard royalty splits that
    /// don't change frequently.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn set_default_recipients(env: Env, recipients: Vec<Recipient>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_DEFAULT_RECIPIENTS_ADMIN);
        Self::validate_default_recipient_basis_points(&env, &recipients);
        Self::validate_recipient_list(&env, &recipients);

        // DefaultRecipients uses persistent storage (#322)
        storage::persistent_set(&env, &StorageKey::DefaultRecipients, &recipients);

        env.events().publish(
            (symbol_short!("default"), symbol_short!("rcpt_set")),
            recipients.len(),
        );
    }

    /// Update the primary collaborator recipient list stored in persistent storage.
    ///
    /// Replaces `StorageKey::Collaborators` and `StorageKey::ShareMap` so the
    /// updated list survives ledger TTL and is returned by `get_recipients()`.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn set_recipients(env: Env, recipients: Vec<Recipient>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_RECIPIENTS_ADMIN);
        Self::validate_recipient_list(&env, &recipients);

        let mut collaborators: Vec<Address> = Vec::new(&env);
        let mut share_map: Map<Address, u32> = Map::new(&env);

        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            collaborators.push_back(recipient.address.clone());
            share_map.set(recipient.address.clone(), recipient.share);
        }

        // Collaborators and ShareMap use persistent storage (#322)
        storage::persistent_set(&env, &StorageKey::Collaborators, &collaborators);
        storage::persistent_set(&env, &StorageKey::ShareMap, &share_map);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("recip_set")),
            recipients.len(),
        );
    }

    /// Admin-only recovery of stuck token balances held by the contract.
    ///
    /// Transfers `amount` of `token` from the contract to the admin address.
    /// Use when funds remain after a partial distribution failure.
    ///
    /// # Authorization
    /// Requires admin signature.
    pub fn withdraw(env: Env, token: Address, amount: i128) {
        storage::extend_instance_ttl(&env);

        let admin = Self::require_admin_address(&env);

        Self::check_admin_auth(&env, auth::msg::WITHDRAW_ADMIN);

        if amount <= 0 {
            Self::fail(&env, ContractError::AmountNotPositive);
        }

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());
        if amount > balance {
            Self::fail(&env, ContractError::InsufficientBalance);
        }

        token_client.transfer(&env.current_contract_address(), &admin, &amount);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("withdraw")),
            (token, amount),
        );
    }

    /// Get the default recipient list.
    ///
    /// Returns the configured default recipient list, or an empty vec if none has been set.
    /// Safe to call before initialization or when no defaults are configured.
    pub fn get_default_recipients(env: Env) -> Vec<Recipient> {
        storage::extend_instance_ttl(&env);
        // DefaultRecipients uses persistent storage (#322)
        storage::persistent_get::<Vec<Recipient>>(&env, &StorageKey::DefaultRecipients)
            .unwrap_or(Vec::new(&env))
    }

    /// Distribute the full contract balance of `token` to recipients with override support.
    ///
    /// # Arguments
    /// * `token` - The token address to distribute (e.g., XLM or other Stellar asset)
    /// * `override_recipients` - Optional override recipient list. If provided, uses this
    ///   list instead of default recipients. If None/empty, falls back to default recipients
    ///   if configured, otherwise uses the original collaborator list.
    ///
    /// # Distribution Logic
    /// Each recipient receives: (total_amount * their_share) / 10,000
    /// The last recipient receives any remaining dust from integer division rounding.
    ///
    /// # Authorization
    /// Requires admin signature
    ///
    /// # Panics
    /// * `"recipients list cannot be empty"` — no recipients are configured
    /// * `ContractError::Underfunded` — contract has zero balance of the token
    /// * `"contract is paused"` — contract is currently paused
    pub fn distribute_with_override(env: Env, token: Address, override_recipients: Vec<Recipient>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_OVERRIDE_ADMIN);

        if env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::Paused)
            .unwrap_or(false)
        {
            Self::fail(&env, ContractError::ContractPaused);
        }

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            soroban_sdk::panic_with_error!(&env, ContractError::Underfunded);
        }

        // Determine which recipient list to use
        let recipients_to_use: Vec<Recipient> = if !override_recipients.is_empty() {
            // Use override recipients if provided
            override_recipients
        } else {
            // Try to use default recipients (persistent storage), fall back to collaborators
            let defaults: Vec<Recipient> =
                storage::persistent_get::<Vec<Recipient>>(&env, &StorageKey::DefaultRecipients)
                    .unwrap_or(Vec::new(&env));

            if !defaults.is_empty() {
                defaults
            } else {
                // Fall back to original collaborator list (persistent storage)
                let collaborators: Vec<Address> =
                    storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                        .expect("no collaborators");

                let share_map: Map<Address, u32> =
                    storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                        .expect("no share map");

                let mut recipients: Vec<Recipient> = Vec::new(&env);
                for addr in collaborators.iter() {
                    let share = share_map.get(addr.clone()).unwrap_or(0);
                    recipients.push_back(Recipient {
                        address: addr,
                        share,
                    });
                }
                recipients
            }
        };

        if recipients_to_use.is_empty() {
            Self::fail(&env, ContractError::EmptyRecipients);
        }

        // Validate shares sum to 10,000
        let mut total_shares: u32 = 0;
        for i in 0..recipients_to_use.len() {
            total_shares = Self::checked_add_share_total(
                &env,
                total_shares,
                recipients_to_use.get(i).unwrap().share,
            );
        }
        if total_shares != 10_000 {
            Self::fail(&env, ContractError::InvalidShareTotal);
        }

        let n = recipients_to_use.len();

        // Guard: each recipient must receive at least 1 stroop to avoid silent dust no-ops (#263).
        if amount < n as i128 {
            Self::fail(&env, ContractError::AmountTooSmall);
        }
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;

        // Calculate payouts for all recipients except the last one
        for i in 0..(n - 1) {
            let recipient = recipients_to_use.get(i).unwrap();
            let payout = Self::checked_bps_amount(&env, amount, recipient.share);
            payouts.push_back((recipient.address.clone(), payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
        }

        // Last recipient receives the remainder to avoid dust loss.
        // Dust is bounded by (n - 1) stroops in the worst case.
        let last = recipients_to_use.get(n - 1).unwrap();
        payouts.push_back((
            last.address.clone(),
            amount
                .checked_sub(total_calculated)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow)),
        ));

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events()
                .publish((symbol_short!("dist"),), (addr, payout));
        }

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("dist_all")),
            (token, amount),
        );

        storage::instance_set(
            &env,
            &StorageKey::LastDistribution,
            &env.ledger().timestamp(),
        );

        // Increment distribute history counter with overflow safety
        let current_count: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .unwrap_or(0);

        // Use saturating add to prevent overflow - will cap at u64::MAX
        let new_count = current_count.saturating_add(1);
        storage::instance_set(&env, &StorageKey::DistributeHistory, &new_count);
    }

    /// Get the total number of successful royalty distributions.
    ///
    /// Returns a monotonically increasing counter that increments on every
    /// successful distribute() or distribute_with_override() call. Never decrements.
    /// Uses saturating arithmetic to prevent overflow (caps at u64::MAX).
    ///
    /// Safe to call at any time — returns 0 if no distributions have occurred.
    pub fn get_distribute_count(env: Env) -> u64 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .unwrap_or(0)
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
    /// * `ContractError::Underfunded` — contract has zero balance of the token
    /// * `"contract is paused"` — contract is currently paused
    pub fn distribute(env: Env, token: Address) {
        // Call the enhanced version with empty override for backward compatibility
        Self::distribute_with_override(env.clone(), token, Vec::new(&env));
    }

    /// Distribute royalties for multiple tokens in a single transaction.
    ///
    /// Executes multiple independent distributions atomically, reducing total
    /// ledger fees for high-frequency royalty scenarios. Each token distribution
    /// is processed independently using the same logic as `distribute()`.
    ///
    /// # Arguments
    /// * `tokens` - List of token addresses to distribute (e.g., XLM, USDC, etc.)
    ///
    /// # Distribution Logic
    /// For each token:
    /// - Uses the default recipient list (or collaborators if no defaults set)
    /// - Each recipient receives: (token_balance * their_share) / 10,000
    /// - The last recipient receives any remaining dust from integer division
    /// - Emits individual distribution events for each token
    ///
    /// # Authorization
    /// Requires admin signature (checked once for the entire batch)
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"contract is paused"` — contract is currently paused
    /// * `"recipients list cannot be empty"` — no recipients are configured
    /// * `"no balance to distribute"` — any token has zero balance
    /// * `"amount too small"` — any token balance is less than recipient count
    ///
    /// # Gas Considerations
    /// Processing N tokens in one call is more efficient than N separate calls,
    /// but be mindful of transaction complexity limits. Each distribution performs
    /// token transfers equal to the number of recipients.
    pub fn batch_distribute(env: Env, tokens: Vec<Address>) {
        storage::extend_instance_ttl(&env);

        // Check admin auth once for the entire batch
        Self::check_admin_auth(&env, auth::msg::BATCH_DISTRIBUTE_ADMIN);

        // Check paused state once for the entire batch
        if env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::Paused)
            .unwrap_or(false)
        {
            Self::fail(&env, ContractError::ContractPaused);
        }

        // Get recipient list once (reused for all distributions)
        let recipients_to_use: Vec<Recipient> = {
            let defaults: Vec<Recipient> =
                storage::persistent_get::<Vec<Recipient>>(&env, &StorageKey::DefaultRecipients)
                    .unwrap_or(Vec::new(&env));

            if !defaults.is_empty() {
                defaults
            } else {
                // Fall back to original collaborator list (persistent storage)
                let collaborators: Vec<Address> =
                    storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                        .expect("no collaborators");

                let share_map: Map<Address, u32> =
                    storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                        .expect("no share map");

                let mut recipients: Vec<Recipient> = Vec::new(&env);
                for addr in collaborators.iter() {
                    let share = share_map.get(addr.clone()).unwrap_or(0);
                    recipients.push_back(Recipient {
                        address: addr,
                        share,
                    });
                }
                recipients
            }
        };

        if recipients_to_use.is_empty() {
            Self::fail(&env, ContractError::EmptyRecipients);
        }

        // Validate shares sum to 10,000 (once for all distributions)
        let mut total_shares: u32 = 0;
        for i in 0..recipients_to_use.len() {
            total_shares = Self::checked_add_share_total(
                &env,
                total_shares,
                recipients_to_use.get(i).unwrap().share,
            );
        }
        if total_shares != 10_000 {
            Self::fail(&env, ContractError::InvalidShareTotal);
        }

        let n = recipients_to_use.len();

        // Process each token distribution
        for token in tokens.iter() {
            let token_client = token::Client::new(&env, &token);
            let amount = token_client.balance(&env.current_contract_address());

            if amount == 0 {
                Self::fail(&env, ContractError::NoBalance);
            }

            // Guard: each recipient must receive at least 1 stroop
            if amount < n as i128 {
                Self::fail(&env, ContractError::AmountTooSmall);
            }

            let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
            let mut total_calculated: i128 = 0;

            // Calculate payouts for all recipients except the last one
            for i in 0..(n - 1) {
                let recipient = recipients_to_use.get(i).unwrap();
                let payout = Self::checked_bps_amount(&env, amount, recipient.share);
                payouts.push_back((recipient.address.clone(), payout));
                total_calculated = total_calculated
                    .checked_add(payout)
                    .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
            }

            // Last recipient receives the remainder to avoid dust loss
            let last = recipients_to_use.get(n - 1).unwrap();
            payouts.push_back((
                last.address.clone(),
                amount
                    .checked_sub(total_calculated)
                    .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow)),
            ));

            // Execute transfers for this token
            for (addr, payout) in payouts.iter() {
                token_client.transfer(&env.current_contract_address(), &addr, &payout);
                env.events()
                    .publish((symbol_short!("dist"),), (addr, payout));
            }

            // Emit distribution event for this token
            env.events().publish(
                (symbol_short!("royalty"), symbol_short!("dist_all")),
                (token.clone(), amount),
            );
        }

        // Update distribution timestamp and counter once for the batch
        storage::instance_set(
            &env,
            &StorageKey::LastDistribution,
            &env.ledger().timestamp(),
        );

        let current_count: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::DistributeHistory)
            .unwrap_or(0);

        // Increment by the number of tokens distributed
        let new_count = current_count.saturating_add(tokens.len() as u64);
        storage::instance_set(&env, &StorageKey::DistributeHistory, &new_count);

        // Emit batch completion event
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("batch")),
            tokens.len(),
        );
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
    pub fn record_secondary_royalty(env: Env, token: Address, from: Address, royalty_amount: i128) {
        storage::extend_instance_ttl(&env);
        auth::require_payer(&env, &from, auth::msg::RECORD_SECONDARY_PAYER);

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
            .get(&StorageKey::SecondaryPool)
            .unwrap_or(0);

        storage::instance_set(
            &env,
            &StorageKey::SecondaryPool,
            &(current_pool + royalty_amount),
        );

        storage::instance_set(&env, &StorageKey::SecondaryToken, &token);
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
    /// * `"total shares must sum to 10000"` — share map does not total 100%
    /// * `"pool exceeds contract balance"` — pool accounting is inconsistent
    pub fn distribute_secondary_royalties(env: Env) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_SECONDARY_ADMIN);

        if env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::Paused)
            .unwrap_or(false)
        {
            Self::fail(&env, ContractError::ContractPaused);
        }

        if Self::get_total_shares(env.clone()) != 10_000 {
            Self::fail(&env, ContractError::InvalidShareTotal);
        }

        let pool: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::SecondaryPool)
            .unwrap_or(0);

        if pool == 0 {
            Self::fail(&env, ContractError::NoSecondaryRoyalties);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&StorageKey::SecondaryToken)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoSecondaryToken));

        let token_client = token::Client::new(&env, &token);
        let balance = token_client.balance(&env.current_contract_address());

        if pool > balance {
            Self::fail(&env, ContractError::PoolExceedsBalance);
        }

        // Collaborators and ShareMap from persistent storage (#322)
        let collaborators: Vec<Address> =
            storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                .expect("no collaborators");

        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("no share map");

        let n = collaborators.len();
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;

        for i in 0..(n - 1) {
            let addr = collaborators.get(i).unwrap();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = Self::checked_bps_amount(&env, pool, share);
            payouts.push_back((addr, payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
        }

        // Last collaborator receives the remainder. Dust bounded by (n - 1) stroops.
        let last = collaborators.get(n - 1).unwrap();
        payouts.push_back((
            last,
            pool.checked_sub(total_calculated)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow)),
        ));

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events()
                .publish((symbol_short!("sec_dist"),), (addr, payout));
        }

        storage::instance_set(&env, &StorageKey::SecondaryPool, &0_i128);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("sec_dist")),
            (token, pool),
        );

        storage::instance_set(
            &env,
            &StorageKey::LastSecondaryDistribution,
            &env.ledger().timestamp(),
        );
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
        storage::extend_instance_ttl(&env);

        if sale_price <= 0 {
            Self::fail(&env, ContractError::SalePriceNotPositive);
        }

        let rate: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0);

        Self::checked_bps_amount(&env, sale_price, rate)
    }

    /// Returns the current secondary royalty rate in basis points (0–10,000).
    /// Returns 0 if `set_royalty_rate` has never been called.
    pub fn get_royalty_rate(env: Env) -> u32 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0)
    }

    /// Returns all recipients as an ordered list of (address, share) pairs.
    ///
    /// Each entry contains the collaborator's address and their basis-point share.
    /// Preserves the insertion order from `initialize`. Returns an empty vec if
    /// called before initialization.
    pub fn get_recipients(env: Env) -> Vec<Recipient> {
        storage::extend_instance_ttl(&env);

        // Collaborators and ShareMap from persistent storage (#322)
        let collaborators: Vec<Address> =
            storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                .unwrap_or(Vec::new(&env));

        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .unwrap_or(Map::new(&env));

        let mut recipients: Vec<Recipient> = Vec::new(&env);
        for addr in collaborators.iter() {
            let share = share_map.get(addr.clone()).unwrap_or(0);
            recipients.push_back(Recipient {
                address: addr,
                share,
            });
        }
        recipients
    }

    /// Returns the contract's semantic version string (set from [`VERSION`] at
    /// initialization time).
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn get_version(env: Env) -> String {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::ContractVersion)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NotInitialized))
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
        storage::extend_instance_ttl(&env);
        // ShareMap from persistent storage (#322)
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("contract not initialized");

        share_map
            .get(collaborator)
            .unwrap_or_else(|| Self::fail(&env, ContractError::CollaboratorNotFound))
    }

    /// Update a collaborator's share allocation.
    ///
    /// # Authorization
    /// Requires admin signature
    pub fn update_share(env: Env, collaborator: Address, new_share: u32) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UPDATE_SHARE_ADMIN);

        // ShareMap from persistent storage (#322)
        let mut share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("contract not initialized");

        if !share_map.contains_key(collaborator.clone()) {
            Self::fail(&env, ContractError::CollaboratorNotFound);
        }

        let old_share = share_map.get(collaborator.clone()).unwrap();
        let current_total = Self::get_total_shares(env.clone());
        let new_total = current_total
            .checked_sub(old_share)
            .and_then(|remaining| remaining.checked_add(new_share))
            .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));

        if new_total != 10_000 {
            Self::fail(&env, ContractError::InvalidUpdatedShareTotal);
        }

        if new_share == 0 {
            Self::fail(&env, ContractError::ZeroShare);
        }

        share_map.set(collaborator.clone(), new_share);
        storage::persistent_set(&env, &StorageKey::ShareMap, &share_map);

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
        storage::extend_instance_ttl(&env);
        // ShareMap from persistent storage (#322)
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .unwrap_or(Map::new(&env));

        share_map.contains_key(addr)
    }

    /// Returns the number of registered collaborators.
    /// Returns 0 if called before initialization.
    pub fn collaborator_count(env: Env) -> u32 {
        storage::extend_instance_ttl(&env);
        // Collaborators from persistent storage (#322)
        let collaborators: Vec<Address> =
            storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                .unwrap_or(Vec::new(&env));
        collaborators.len()
    }

    /// Returns the ordered list of all registered collaborator addresses.
    /// Returns an empty vec if called before initialization.
    pub fn get_collaborators(env: Env) -> Vec<Address> {
        storage::extend_instance_ttl(&env);
        // Collaborators from persistent storage (#322)
        storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
            .unwrap_or(Vec::new(&env))
    }

    /// Returns the full share map (Address → basis points) in a single call.
    pub fn get_all_shares(env: Env) -> Map<Address, u32> {
        storage::extend_instance_ttl(&env);
        // ShareMap from persistent storage (#322)
        storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
            .unwrap_or(Map::new(&env))
    }

    /// Returns the current size of the secondary royalty pool (undistributed amount).
    /// Returns 0 if no royalties have been recorded yet.
    pub fn get_secondary_pool(env: Env) -> i128 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::SecondaryPool)
            .unwrap_or(0)
    }

    /// Returns the timestamp of the last primary distribution, or None if never distributed.
    pub fn get_last_distribution(env: Env) -> Option<u64> {
        storage::extend_instance_ttl(&env);
        env.storage().instance().get(&StorageKey::LastDistribution)
    }

    /// Returns the timestamp of the last secondary distribution, or None if never distributed.
    pub fn get_last_secondary_distribution(env: Env) -> Option<u64> {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::LastSecondaryDistribution)
    }

    /// Returns the sum of all collaborator basis-point shares.
    ///
    /// Under normal operation this always returns 10,000. Useful for
    /// pre-flight validation before calling `distribute`.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn get_total_shares(env: Env) -> u32 {
        storage::extend_instance_ttl(&env);
        // ShareMap from persistent storage (#322)
        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("contract not initialized");

        let mut total = 0;
        for item in share_map.iter() {
            total = Self::checked_add_share_total(&env, total, item.1);
        }
        total
    }

    /// Configure a multi-sig admin list and signing threshold (#321).
    ///
    /// Once set, all sensitive functions require the first `threshold` addresses
    /// in `admins` to authorize each call. The single-step `admin_transfer` is
    /// disabled when this is active — use `propose_admin_transfer` instead.
    ///
    /// # Arguments
    /// * `admins` - Ordered list of admin addresses (max 10).
    /// * `threshold` - Number of admins that must sign (1 ≤ threshold ≤ admins.len()).
    ///
    /// # Authorization
    /// Requires current admin (or multi-sig threshold) signature.
    pub fn set_admins(env: Env, admins: Vec<Address>, threshold: u32) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::SET_ADMINS_ADMIN);

        if admins.is_empty() {
            panic!("admin list cannot be empty");
        }
        if threshold < 1 {
            panic!("threshold must be at least 1");
        }
        if threshold > admins.len() as u32 {
            panic!("threshold cannot exceed admin count");
        }

        // Check for duplicate addresses
        let mut seen: Vec<Address> = Vec::new(&env);
        for i in 0..admins.len() {
            let addr = admins.get(i).unwrap();
            for j in 0..seen.len() {
                if seen.get(j).unwrap() == addr {
                    panic!("duplicate admin address");
                }
            }
            seen.push_back(addr);
        }

        storage::instance_set(&env, &StorageKey::AdminList, &admins);
        storage::instance_set(&env, &StorageKey::AdminThreshold, &threshold);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adms_set")),
            (admins.len(), threshold),
        );
    }

    /// Returns the configured multi-sig admin list, or an empty vec if not set.
    pub fn get_admins(env: Env) -> Vec<Address> {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::AdminList)
            .unwrap_or(Vec::new(&env))
    }

    fn validate_recipient_list(env: &Env, recipients: &Vec<Recipient>) {
        if recipients.is_empty() {
            Self::fail(env, ContractError::EmptyRecipients);
        }

        if recipients.len() > 10 {
            Self::fail(env, ContractError::TooManyRecipients);
        }

        let mut total_shares: u32 = 0;
        let mut address_set: Vec<Address> = Vec::new(env);

        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();

            if recipient.share == 0 {
                Self::fail(env, ContractError::ZeroShare);
            }

            for j in 0..address_set.len() {
                if address_set.get(j).unwrap() == recipient.address {
                    Self::fail(env, ContractError::DuplicateRecipient);
                }
            }
            address_set.push_back(recipient.address.clone());

            total_shares = Self::checked_add_share_total(env, total_shares, recipient.share);
        }

        if total_shares != 10_000 {
            Self::fail(env, ContractError::InvalidShareTotal);
        }
    }

    fn validate_default_recipient_basis_points(env: &Env, recipients: &Vec<Recipient>) {
        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            if recipient.share > 10_000 {
                Self::fail(env, ContractError::InvalidBasisPoints);
            }
        }
    }

    /// Auth helper: requires current admin(s) to authorize.
    ///
    /// If `AdminList` is configured (multi-sig active), requires the first
    /// `AdminThreshold` addresses in the list to call `require_auth()`.
    /// Otherwise falls back to the single `Admin` address.
    fn check_admin_auth(env: &Env, message: &str) {
        let admin_list: Option<Vec<Address>> =
            env.storage().instance().get(&StorageKey::AdminList);
        if let Some(admins) = admin_list {
            if !admins.is_empty() {
                let threshold: u32 = env
                    .storage()
                    .instance()
                    .get(&StorageKey::AdminThreshold)
                    .unwrap_or(1);
                let context = String::from_str(env, message);
                env.events().publish((symbol_short!("auth_req"),), context);
                for i in 0..threshold {
                    admins.get(i).unwrap().require_auth();
                }
                return;
            }
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");
        auth::require_admin(env, &admin, message);
    }
}
