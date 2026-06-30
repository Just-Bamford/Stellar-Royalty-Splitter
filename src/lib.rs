#![no_std]
pub mod auth;
mod storage;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, Map, String, Vec,
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

/// Distribution record with dust tracking (#398).
#[contracttype]
#[derive(Clone)]
pub struct DistributionRecord {
    pub total_amount: i128,
    pub dust: i128,
    pub timestamp: u64,
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
    SecondaryDust,
    ContractVersion,
    RoyaltyRate,
    LastDistribution,
    LastSecondaryDistribution,
    Paused,
    DistributeHistory,
    PendingAdmin,
    PendingAdminTimestamp,
    AdminList,
    AdminThreshold,
    InitCH,
    InitSH,
    InitCS,
    InitCM,
    InitNC,
    PauseTimestamp,
    PauseSource,
    PauseEmergency,
    // Persistent storage
    Collaborators,
    ShareMap,
    DefaultRecipients,
    RoyaltyRateHistory,
    DistributionHistory,
}

/// Maximum number of rate-change entries kept in history.
/// Older entries are dropped when the cap is reached.
pub const RATE_HISTORY_CAP: u32 = 20;

/// Maximum dust allowed to accumulate before forcing distribution (#398).
/// Dust is bounded by 1 basis point (0.01%) of any distribution to prevent
/// excessive accumulation from many small transactions.
pub const MAX_DUST: i128 = 100; // 100 stroops = 1 basis point of 10,000
/// Emergency pause duration in seconds (48 hours).
/// Collaborator-initiated pauses auto-expire after this duration.
pub const EMERGENCY_PAUSE_DURATION: u64 = 48 * 60 * 60;

/// Issue #402: Admin transfer time-lock duration in seconds (48 hours).
/// Proposed admin transfers must wait this duration before acceptance.
pub const ADMIN_TRANSFER_TIMELOCK_DURATION: u64 = 48 * 60 * 60;

/// Backward-compatible alias for integration tests and external references.
pub type DataKey = StorageKey;

pub use storage::MIN_TTL;

pub const REVEAL_DELAY_LEDGERS: u32 = 1;

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
pub const EVENT_VERSION: u32 = 1;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    Underfunded = 1,
    AlreadyInitialized = 2,
    EmptyCollaborators = 3,
    TooManyRecipients = 4,
    LengthMismatch = 5,
    InvalidShareTotal = 6,
    ZeroShare = 7,
    DuplicateRecipient = 8,
    InvalidBasisPoints = 9,
    NotInitialized = 10,
    NoCollaborators = 11,
    NoShareMap = 12,
    ArithmeticOverflow = 13,
    RoyaltyRateZero = 14,
    RoyaltyRateTooHigh = 15,
    ContractPaused = 16,
    AmountNotPositive = 17,
    InsufficientBalance = 18,
    EmptyRecipients = 19,
    AmountTooSmall = 20,
    PoolExceedsBalance = 21,
    NoSecondaryRoyalties = 22,
    NoSecondaryToken = 23,
    CollaboratorNotFound = 24,
    InvalidUpdatedShareTotal = 25,
    SalePriceNotPositive = 26,
    DustExceedsLimit = 27,
    NoPendingCommit = 32,
    InvalidReveal = 28,
    RevealTooEarly = 29,
    CommitmentExists = 30,
    AdminTransferTimelockNotExpired = 31,
    InvalidBatchSize = 33,
}

#[contract]
pub struct RoyaltySplitter;

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
        storage::persistent_get(env, &StorageKey::Collaborators)
            .unwrap_or_else(|| Self::fail(env, ContractError::NoCollaborators))
    }

    fn require_share_map(env: &Env) -> Map<Address, u32> {
        storage::persistent_get(env, &StorageKey::ShareMap)
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

    fn zero_address(env: &Env) -> Address {
        Address::from_string(
            env,
            &String::from_str(env, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        )
        .unwrap()
    }

    fn clear_pause_state(env: &Env) {
        env.storage().instance().set(&StorageKey::Paused, &false);
        env.storage().instance().remove(&StorageKey::PauseTimestamp);
        env.storage().instance().remove(&StorageKey::PauseSource);
        env.storage().instance().remove(&StorageKey::PauseEmergency);
    }

    fn is_emergency_pause_expired(env: &Env) -> bool {
        let paused = env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::Paused)
            .unwrap_or(false);
        if !paused {
            return false;
        }

        let is_emergency = env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::PauseEmergency)
            .unwrap_or(false);
        if !is_emergency {
            return false;
        }

        let timestamp = env
            .storage()
            .instance()
            .get::<StorageKey, u64>(&StorageKey::PauseTimestamp)
            .unwrap_or(0);
        env.ledger().timestamp().saturating_sub(timestamp) >= EMERGENCY_PAUSE_DURATION
    }

    fn auto_unpause_if_expired(env: &Env) -> bool {
        if !Self::is_emergency_pause_expired(env) {
            return false;
        }

        Self::clear_pause_state(env);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("unpause")),
            env.ledger().timestamp(),
        );
        true
    }

    fn ensure_not_paused(env: &Env) {
        if Self::auto_unpause_if_expired(env) {
            return;
        }

        if env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::Paused)
            .unwrap_or(false)
        {
            Self::fail(env, ContractError::ContractPaused);
        }
    }

    fn require_collaborator_auth(env: &Env, collaborator: &Address, message: &str) {
        let collaborators = Self::require_collaborators(env);
        let mut is_collaborator = false;

        for addr in collaborators.iter() {
            if &addr == collaborator {
                is_collaborator = true;
                break;
            }
        }

        if !is_collaborator {
            Self::fail(env, ContractError::CollaboratorNotFound);
        }

        let context = String::from_str(env, message);
        env.events().publish((symbol_short!("auth_req"),), context);
        collaborator.require_auth();
    }
}

impl RoyaltySplitter {
    fn check_admin_auth(env: &Env, message: &str) {
        let admin_list: Option<Vec<Address>> = env.storage().instance().get(&StorageKey::AdminList);
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

    fn validate_override_recipients(env: &Env, recipients: &Vec<Recipient>) {
        let collaborators = Self::require_collaborators(env);

        if recipients.is_empty() {
            Self::fail(env, ContractError::EmptyRecipients);
        }

        let mut total_shares: u32 = 0;
        let mut seen: Vec<Address> = Vec::new(env);

        for i in 0..recipients.len() {
            let recipient = recipients.get(i).unwrap();
            if recipient.share == 0 {
                Self::fail(env, ContractError::ZeroShare);
            }

            for j in 0..seen.len() {
                if seen.get(j).unwrap() == recipient.address {
                    Self::fail(env, ContractError::DuplicateRecipient);
                }
            }
            seen.push_back(recipient.address.clone());

            let mut is_initialized_collaborator = false;

            for j in 0..collaborators.len() {
                if collaborators.get(j).unwrap() == recipient.address {
                    is_initialized_collaborator = true;
                    break;
                }
            }

            if !is_initialized_collaborator {
                Self::fail(env, ContractError::CollaboratorNotFound);
            }

            total_shares = Self::checked_add_share_total(env, total_shares, recipient.share);
        }

        if total_shares != 10_000 {
            Self::fail(env, ContractError::InvalidShareTotal);
        }
    }

    fn emit_override_audit_event(env: &Env, token: &Address, recipient_count: u32, amount: i128) {
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("ovr_dist")),
            (
                EVENT_VERSION,
                env.ledger().sequence(),
                token.clone(),
                amount,
                recipient_count,
            ),
        );
    }

    fn get_recipients_for_batch(env: &Env) -> Vec<Recipient> {
        let defaults: Vec<Recipient> =
            storage::persistent_get::<Vec<Recipient>>(env, &StorageKey::DefaultRecipients)
                .unwrap_or(Vec::new(env));

        if !defaults.is_empty() {
            defaults
        } else {
            // Fall back to original collaborator list (persistent storage)
            let collaborators: Vec<Address> =
                storage::persistent_get::<Vec<Address>>(env, &StorageKey::Collaborators)
                    .expect("no collaborators");

            let share_map: Map<Address, u32> =
                storage::persistent_get::<Map<Address, u32>>(env, &StorageKey::ShareMap)
                    .expect("no share map");

            let mut recipients: Vec<Recipient> = Vec::new(env);
            for addr in collaborators.iter() {
                let share = share_map.get(addr.clone()).unwrap_or(0);
                recipients.push_back(Recipient {
                    address: addr,
                    share,
                });
            }
            recipients
        }
    }

    fn validate_batch_recipients(env: &Env, recipients: &Vec<Recipient>) {
        if recipients.is_empty() {
            Self::fail(env, ContractError::EmptyRecipients);
        }

        let mut total_shares: u32 = 0;
        for i in 0..recipients.len() {
            total_shares =
                Self::checked_add_share_total(env, total_shares, recipients.get(i).unwrap().share);
        }
        if total_shares != 10_000 {
            Self::fail(env, ContractError::InvalidShareTotal);
        }
    }

    fn process_batch_token_distribution(env: &Env, token: Address, recipients: &Vec<Recipient>) {
        let token_client = token::Client::new(env, &token);
        let amount = token_client.balance(&env.current_contract_address());

        if amount == 0 {
            Self::fail(env, ContractError::Underfunded);
        }

        let n = recipients.len();
        if amount < n as i128 {
            Self::fail(env, ContractError::AmountTooSmall);
        }

        let mut payouts: Vec<(Address, i128)> = Vec::new(env);
        let mut total_calculated: i128 = 0;

        for i in 0..(n - 1) {
            let recipient = recipients.get(i).unwrap();
            let payout = Self::checked_bps_amount(env, amount, recipient.share);
            payouts.push_back((recipient.address.clone(), payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .unwrap_or_else(|| Self::fail(env, ContractError::ArithmeticOverflow));
        }

        let last = recipients.get(n - 1).unwrap();
        payouts.push_back((
            last.address.clone(),
            amount
                .checked_sub(total_calculated)
                .unwrap_or_else(|| Self::fail(env, ContractError::ArithmeticOverflow)),
        ));

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events().publish(
                (symbol_short!("dist"),),
                (EVENT_VERSION, env.ledger().sequence(), addr, payout),
            );
        }

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("dist_all")),
            (
                EVENT_VERSION,
                env.ledger().sequence(),
                token.clone(),
                amount,
            ),
        );
    }
}

#[contractimpl]
impl RoyaltySplitter {
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
        Self::apply_initialize(&env, collaborators, shares, auth::msg::INITIALIZE_ADMIN);
    }

    pub fn commit_initialize(
        env: Env,
        committer: Address,
        collaborators_hash: BytesN<32>,
        shares_hash: BytesN<32>,
        nonce: BytesN<32>,
    ) {
        storage::extend_instance_ttl(&env);
        if env.storage().instance().has(&StorageKey::Admin) {
            Self::fail(&env, ContractError::AlreadyInitialized);
        }
        if env.storage().instance().has(&StorageKey::InitCH) {
            Self::fail(&env, ContractError::CommitmentExists);
        }
        auth::require_admin(&env, &committer, auth::msg::COMMIT_INITIALIZE_ADMIN);
        let ledger = env.ledger().sequence();
        storage::instance_set(&env, &StorageKey::InitCH, &collaborators_hash);
        storage::instance_set(&env, &StorageKey::InitSH, &shares_hash);
        storage::instance_set(&env, &StorageKey::InitCS, &ledger);
        storage::instance_set(&env, &StorageKey::InitCM, &committer);
        storage::instance_set(&env, &StorageKey::InitNC, &nonce);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("commt")),
            committer,
        );
    }

    pub fn reveal_initialize(
        env: Env,
        collaborators: Vec<Address>,
        shares: Vec<u32>,
        salt: BytesN<32>,
    ) {
        storage::extend_instance_ttl(&env);
        if env.storage().instance().has(&StorageKey::Admin) {
            Self::fail(&env, ContractError::AlreadyInitialized);
        }
        let stored_collab_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&StorageKey::InitCH)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoPendingCommit));
        let stored_shares_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&StorageKey::InitSH)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoPendingCommit));
        let commit_ledger: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::InitCS)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoPendingCommit));
        let committer: Address = env
            .storage()
            .instance()
            .get(&StorageKey::InitCM)
            .unwrap_or_else(|| Self::fail(&env, ContractError::NoPendingCommit));
        if env.ledger().sequence() < commit_ledger + REVEAL_DELAY_LEDGERS {
            Self::fail(&env, ContractError::RevealTooEarly);
        }
        if Self::hash_collaborators(&env, &collaborators, &salt) != stored_collab_hash
            || Self::hash_shares(&env, &shares, &salt) != stored_shares_hash
        {
            Self::clear_init_commit(&env);
            Self::fail(&env, ContractError::InvalidReveal);
        }
        auth::require_admin(&env, &committer, auth::msg::REVEAL_INITIALIZE_ADMIN);
        if collaborators.get(0).unwrap() != committer {
            Self::clear_init_commit(&env);
            Self::fail(&env, ContractError::InvalidReveal);
        }
        Self::clear_init_commit(&env);
        Self::apply_initialize(
            &env,
            collaborators,
            shares,
            auth::msg::REVEAL_INITIALIZE_ADMIN,
        );
    }

    fn clear_init_commit(env: &Env) {
        env.storage().instance().remove(&StorageKey::InitCH);
        env.storage().instance().remove(&StorageKey::InitSH);
        env.storage().instance().remove(&StorageKey::InitCS);
        env.storage().instance().remove(&StorageKey::InitCM);
        env.storage().instance().remove(&StorageKey::InitNC);
    }

    fn hash_collaborators(
        env: &Env,
        collaborators: &Vec<Address>,
        salt: &BytesN<32>,
    ) -> BytesN<32> {
        let mut bytes = Bytes::new(env);
        bytes.append(salt.as_ref());
        for addr in collaborators.iter() {
            let addr_str = addr.to_string();
            let addr_len = addr_str.len() as usize;

            let mut buf = [0u8; 56];
            addr_str.copy_into_slice(&mut buf[..addr_len]);

            bytes.extend_from_slice(&buf[..addr_len]);
        }
        env.crypto().sha256(&bytes)
    }

    fn hash_shares(env: &Env, shares: &Vec<u32>, salt: &BytesN<32>) -> BytesN<32> {
        let mut bytes = Bytes::new(env);
        bytes.append(salt.as_ref());
        for i in 0..shares.len() {
            let share = shares.get(i).unwrap();
            bytes.extend_from_slice(&share.to_be_bytes());
        }
        env.crypto().sha256(&bytes)
    }

    fn apply_initialize(env: &Env, collaborators: Vec<Address>, shares: Vec<u32>, auth_msg: &str) {
        if env.storage().instance().has(&StorageKey::Admin) {
            Self::fail(env, ContractError::AlreadyInitialized);
        }
        if collaborators.is_empty() {
            Self::fail(env, ContractError::EmptyCollaborators);
        }
        if collaborators.len() > 10 {
            Self::fail(env, ContractError::TooManyRecipients);
        }
        auth::require_admin(env, &collaborators.get(0).unwrap(), auth_msg);
        if collaborators.len() != shares.len() {
            Self::fail(env, ContractError::LengthMismatch);
        }
        let mut total: u32 = 0;
        for share in shares.iter() {
            total = Self::checked_add_share_total(env, total, share);
        }
        if total != 10_000 {
            Self::fail(env, ContractError::InvalidShareTotal);
        }
        let mut share_map: Map<Address, u32> = Map::new(env);
        for i in 0..collaborators.len() {
            let addr = collaborators.get(i).unwrap();
            let share = shares.get(i).unwrap();
            if share == 0 {
                Self::fail(env, ContractError::ZeroShare);
            }
            if share_map.contains_key(addr.clone()) {
                Self::fail(env, ContractError::DuplicateRecipient);
            }
            share_map.set(addr, share);
        }
        let admin = collaborators.get(0).unwrap();
        storage::instance_set(env, &StorageKey::Admin, &admin);
        storage::persistent_set(env, &StorageKey::Collaborators, &collaborators);
        storage::persistent_set(env, &StorageKey::ShareMap, &share_map);
        let version = String::from_str(env, VERSION);
        storage::instance_set(env, &StorageKey::ContractVersion, &version);
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("init")),
            (
                EVENT_VERSION,
                env.ledger().sequence(),
                collaborators,
                shares,
            ),
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

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("rate_set")),
            (EVENT_VERSION, env.ledger().sequence(), new_rate),
        );

        // Append to capped history in persistent storage (#323).
        // Gas note: one persistent read + write per call; capped at RATE_HISTORY_CAP
        // entries (~20 × ~80 bytes) so storage growth is bounded.
        let caller: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .expect("contract not initialized");

        let mut history: Vec<RoyaltyRateChange> =
            storage::persistent_get::<Vec<RoyaltyRateChange>>(
                &env,
                &StorageKey::RoyaltyRateHistory,
            )
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

        storage::instance_set(&env, &StorageKey::RoyaltyRateHistory, &history);
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
        storage::instance_set(&env, &StorageKey::PauseTimestamp, &env.ledger().timestamp());
        storage::instance_set(&env, &StorageKey::PauseEmergency, &false);

        let admin = Self::require_admin_address(&env);
        storage::instance_set(&env, &StorageKey::PauseSource, &admin);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("pause")),
            (admin, env.ledger().timestamp()),
        );
    }

    /// Emergency pause by any collaborator.
    ///
    /// Allows any configured collaborator to stop all distributions immediately.
    /// The pause automatically expires after 48 hours. Manual unpause before the
    /// expiry still uses the configured admin multi-sig threshold.
    ///
    /// # Authorization
    /// Requires signature from a collaborator address supplied by the caller.
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    /// * `"contract is already paused"` — pause is already active
    pub fn pause_emergency(env: Env, collaborator: Address) {
        storage::extend_instance_ttl(&env);

        Self::ensure_not_paused(&env);

        Self::require_collaborator_auth(&env, &collaborator, auth::msg::PAUSE_EMERGENCY);

        storage::instance_set(&env, &StorageKey::Paused, &true);
        storage::instance_set(&env, &StorageKey::PauseTimestamp, &env.ledger().timestamp());
        storage::instance_set(&env, &StorageKey::PauseSource, &collaborator);
        storage::instance_set(&env, &StorageKey::PauseEmergency, &true);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("c_pause")),
            (caller, env.ledger().timestamp()),
        );
    }

    /// Backward-compatible alias for the collaborator emergency pause entrypoint.
    pub fn pause_collaborator_distributions(env: Env, collaborator: Address) {
        Self::pause_emergency(env, collaborator);
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

        // #399: Emit structured event for backend cache invalidation
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("admin_xfr")),
            (
                EVENT_VERSION,
                env.ledger().sequence(),
                previous_admin,
                new_admin,
            ),
        );
    }

    /// Propose a new admin — first step of the two-step admin transfer (#320).
    ///
    /// Issue #402: Stores `new_admin` as pending with a 48-hour time-lock.
    /// The transfer is not complete until `accept_admin` is called by `new_admin`
    /// after the time-lock expires.
    ///
    /// # Authorization
    /// Requires current admin (or multi-sig threshold) signature.
    pub fn propose_admin_transfer(env: Env, new_admin: Address) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PROPOSE_ADMIN_ADMIN);

        let timestamp = env.ledger().timestamp();
        storage::instance_set(&env, &StorageKey::PendingAdmin, &new_admin);
        storage::instance_set(&env, &StorageKey::PendingAdminTimestamp, &timestamp);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adm_prop")),
            (EVENT_VERSION, env.ledger().sequence(), new_admin),
        );
    }

    /// Accept a pending admin transfer — second step of the two-step flow (#320).
    ///
    /// Issue #402: Verifies 48-hour time-lock has expired before completing transfer.
    /// Completes the transfer initiated by `propose_admin_transfer`. Only the
    /// address nominated in `propose_admin_transfer` can call this.
    ///
    /// # Authorization
    /// Requires signature from the *pending* admin (not the current admin).
    ///
    /// # Panics
    /// * `"no pending admin transfer"` — called without a prior `propose_admin_transfer`
    /// * `"admin transfer time-lock not expired"` — called before 48 hours have passed
    pub fn accept_admin(env: Env) {
        storage::extend_instance_ttl(&env);

        let pending: Address = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdmin)
            .expect("no pending admin transfer");

        let proposal_timestamp: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdminTimestamp)
            .expect("no pending admin timestamp");

        let current_time = env.ledger().timestamp();
        let elapsed = current_time.saturating_sub(proposal_timestamp);

        // Issue #402: Enforce 48-hour time-lock
        if elapsed < ADMIN_TRANSFER_TIMELOCK_DURATION {
            Self::fail(&env, ContractError::AdminTransferTimelockNotExpired);
        }

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
        env.storage()
            .instance()
            .remove(&StorageKey::PendingAdminTimestamp);

        // #399: Emit structured event for backend cache invalidation
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adm_acc")),
            (
                EVENT_VERSION,
                env.ledger().sequence(),
                previous_admin,
                pending,
            ),
        );
    }

    /// Cancel a pending admin transfer.
    ///
    /// Issue #402: Allows current admin to cancel a pending transfer before acceptance.
    /// Useful if the proposed admin is no longer suitable or if the transfer was
    /// initiated in error.
    ///
    /// # Authorization
    /// Requires current admin (or multi-sig threshold) signature.
    ///
    /// # Panics
    /// * `"no pending admin transfer"` — called without a prior `propose_admin_transfer`
    pub fn cancel_admin_proposal(env: Env) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::PROPOSE_ADMIN_ADMIN);

        let pending: Address = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdmin)
            .expect("no pending admin transfer");

        env.storage().instance().remove(&StorageKey::PendingAdmin);
        env.storage()
            .instance()
            .remove(&StorageKey::PendingAdminTimestamp);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("adm_cncl")),
            pending,
        );
    }

    /// Unpause the contract — re-enables `distribute` and `distribute_secondary_royalties`.
    ///
    /// Emergency pauses auto-expire after 48 hours. Before expiration, the
    /// configured admin quorum must authorize `unpause`. After expiration, the
    /// pause is cleared automatically by read/write entrypoints and this call
    /// simply clears any remaining metadata.
    ///
    /// # Authorization
    /// Requires admin signature (multi-sig if admin quorum is configured).
    ///
    /// # Panics
    /// * `"contract not initialized"` — called before `initialize`
    pub fn unpause(env: Env) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::UNPAUSE_ADMIN);
        Self::clear_pause_state(&env);

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("unpause")),
            env.ledger().timestamp(),
        );
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
        Self::auto_unpause_if_expired(&env);
        env.storage()
            .instance()
            .get(&StorageKey::Paused)
            .unwrap_or(false)
    }

    /// Returns pause information for frontend display.
    ///
    /// Returns a tuple of (pause_timestamp, pause_source, remaining_seconds).
    /// If not paused, returns (0, zero_address, 0).
    /// remaining_seconds is the time until auto-expiration (0 if not an emergency pause).
    pub fn get_pause_info(env: Env) -> (u64, Address, u64) {
        storage::extend_instance_ttl(&env);
        Self::auto_unpause_if_expired(&env);

        let paused = env
            .storage()
            .instance()
            .get(&StorageKey::Paused)
            .unwrap_or(false);

        if !paused {
            let zero_addr = Address::from_string(&String::from_str(&env, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
            return (0, zero_addr, 0);
        }

        let timestamp = env.storage()
            .instance()
            .get(&StorageKey::PauseTimestamp)
            .unwrap_or(0);

        let source = env
            .storage()
            .instance()
            .get(&StorageKey::PauseSource)
            .unwrap_or_else(|| Self::zero_address(&env));

        let remaining = if env
            .storage()
            .instance()
            .get::<StorageKey, bool>(&StorageKey::PauseEmergency)
            .unwrap_or(false)
        {
            let current_time = env.ledger().timestamp();
            let elapsed = current_time.saturating_sub(timestamp);
            EMERGENCY_PAUSE_DURATION.saturating_sub(elapsed)
        } else {
            0
        };

        (timestamp, source, remaining)
    }

    /// Issue #402: Returns pending admin transfer information for frontend display.
    ///
    /// Returns a tuple of (pending_admin, proposal_timestamp, remaining_seconds).
    /// If no pending transfer, returns (zero_address, 0, 0).
    /// remaining_seconds is the time until the time-lock expires (0 if already expired).
    pub fn get_pending_admin_transfer(env: Env) -> (Address, u64, u64) {
        storage::extend_instance_ttl(&env);

        let pending: Option<Address> = env.storage().instance().get(&StorageKey::PendingAdmin);

        if pending.is_none() {
            let zero_addr = Address::from_string(&String::from_str(&env, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
            return (zero_addr, 0, 0);
        }

        let pending = pending.unwrap();
        let timestamp = env
            .storage()
            .instance()
            .get(&StorageKey::PendingAdminTimestamp)
            .unwrap_or(0);

        let current_time = env.ledger().timestamp();
        let elapsed = current_time.saturating_sub(timestamp);
        let remaining = ADMIN_TRANSFER_TIMELOCK_DURATION.saturating_sub(elapsed);

        (pending, timestamp, remaining)
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
            (EVENT_VERSION, env.ledger().sequence(), recipients.len()),
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
            (EVENT_VERSION, env.ledger().sequence(), recipients.len()),
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
            (EVENT_VERSION, env.ledger().sequence(), token, amount),
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
    /// * `override_recipients` - Optional override recipient list. If provided, each
    ///   recipient must already exist in the initialized collaborator list. If None/empty,
    ///   falls back to default recipients if configured, otherwise uses the original
    ///   collaborator list.
    ///
    /// # Distribution Logic
    /// Each recipient receives: (total_amount * their_share) / 10,000
    /// The last recipient receives any remaining dust from integer division rounding.
    ///
    /// # Authorization
    /// Requires admin signature
    ///
    /// # Override Restrictions
    /// When `override_recipients` is provided, every recipient must already be
    /// present in the initialized collaborator list. Override distributions also
    /// emit an audit event before funds are transferred.
    ///
    /// # Panics
    /// * `"recipients list cannot be empty"` — no recipients are configured
    /// * `ContractError::Underfunded` — contract has zero balance of the token
    /// * `"contract is paused"` — contract is currently paused
    pub fn distribute_with_override(env: Env, token: Address, override_recipients: Vec<Recipient>) {
        storage::extend_instance_ttl(&env);

        Self::check_admin_auth(&env, auth::msg::DISTRIBUTE_OVERRIDE_ADMIN);

        Self::ensure_not_paused(&env);

        let token_client = token::Client::new(&env, &token);
        let amount = token_client.balance(&env.current_contract_address());
        if amount == 0 {
            soroban_sdk::panic_with_error!(&env, ContractError::Underfunded);
        }
        let used_override = !override_recipients.is_empty();

        // Determine which recipient list to use
        let recipients_to_use: Vec<Recipient> = if !override_recipients.is_empty() {
            // Override recipients are a restricted admin path: they must already be
            // part of the initialized collaborator set and still satisfy the normal
            // share validation rules.
            Self::validate_override_recipients(&env, &override_recipients);
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

        if used_override {
            Self::emit_override_audit_event(&env, &token, n as u32, amount);
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
            env.events().publish(
                (symbol_short!("dist"),),
                (EVENT_VERSION, env.ledger().sequence(), addr, payout),
            );
        }

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("dist_all")),
            (EVENT_VERSION, env.ledger().sequence(), token, amount),
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
}

#[contractimpl]
impl RoyaltySplitter {
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
}

#[contractimpl]
impl RoyaltySplitter {
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
}

#[contractimpl]
impl RoyaltySplitter {
    /// Distribute royalties for multiple tokens in a single transaction.
    ///
    /// Executes multiple independent token distributions atomically to save gas.
    /// Uses the default recipient list (or falls back to collaborators).
    ///
    /// # Arguments
    /// * `tokens` - List of token addresses to distribute.
    ///
    /// # Authorization
    /// Requires admin signature (checked once for the batch).
    pub fn batch_distribute(env: Env, tokens: Vec<Address>) {
        Self::batch_distribute_impl(env, tokens);
    }
}

impl RoyaltySplitter {
    fn batch_distribute_impl(env: Env, tokens: Vec<Address>) {
        storage::extend_instance_ttl(&env);

        if tokens.is_empty() || tokens.len() > 10 {
            Self::fail(&env, ContractError::InvalidBatchSize);
        }

        // Check admin auth once for the entire batch
        Self::check_admin_auth(&env, auth::msg::BATCH_DISTRIBUTE_ADMIN);

        // Check paused state once for the entire batch
        Self::ensure_not_paused(&env);

        // Get recipient list once (reused for all distributions)
        let recipients_to_use = Self::get_recipients_for_batch(&env);
        Self::validate_batch_recipients(&env, &recipients_to_use);

        // Process each token distribution
        for token in tokens.iter() {
            Self::process_batch_token_distribution(&env, token, &recipients_to_use);
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

        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("batch")),
            (EVENT_VERSION, env.ledger().sequence(), tokens.len()),
        );
    }
}

#[contractimpl]
impl RoyaltySplitter {
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
    /// Dust from rounding is tracked and distributed in the next batch (#398).
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

        // Collaborators and ShareMap from persistent storage (#322)
        let collaborators: Vec<Address> =
            storage::persistent_get::<Vec<Address>>(&env, &StorageKey::Collaborators)
                .expect("no collaborators");

        let share_map: Map<Address, u32> =
            storage::persistent_get::<Map<Address, u32>>(&env, &StorageKey::ShareMap)
                .expect("no share map");

        // Add accumulated dust from previous distribution (#398)
        let accumulated_dust: i128 = env
            .storage()
            .instance()
            .get(&StorageKey::SecondaryDust)
            .unwrap_or(0);
        let total_to_distribute = pool + accumulated_dust;

        let n = collaborators.len();
        let mut payouts: Vec<(Address, i128)> = Vec::new(&env);
        let mut total_calculated: i128 = 0;

        for i in 0..(n - 1) {
            let addr = collaborators.get(i).unwrap();
            let share = share_map.get(addr.clone()).unwrap_or(0);
            let payout = Self::checked_bps_amount(&env, total_to_distribute, share);
            payouts.push_back((addr, payout));
            total_calculated = total_calculated
                .checked_add(payout)
                .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
        }

        // Last collaborator receives the remainder. Dust bounded by (n - 1) stroops.
        let last = collaborators.get(n - 1).unwrap();
        let last_payout = total_to_distribute
            .checked_sub(total_calculated)
            .unwrap_or_else(|| Self::fail(&env, ContractError::ArithmeticOverflow));
        payouts.push_back((last, last_payout));

        // Calculate actual dust (difference between theoretical and actual)
        let theoretical_total = total_calculated + last_payout;
        let dust = total_to_distribute - theoretical_total;

        // Validate dust doesn't exceed safety limit (#398)
        if dust > MAX_DUST {
            Self::fail(&env, ContractError::DustExceedsLimit);
        }

        // #463: Pre-validate each recipient payout against available contract balance.
        // Emits SecondaryDistributionFailed for each recipient that cannot be paid so
        // off-chain indexers can reconstruct which recipients were affected.
        let mut success_count: u32 = 0;
        let mut failure_count: u32 = 0;
        let mut running_balance = balance;

        for (addr, payout) in payouts.iter() {
            if payout <= running_balance {
                success_count += 1;
                running_balance -= payout;
            } else {
                failure_count += 1;
                env.events().publish(
                    (symbol_short!("royalty"), symbol_short!("sec_fail")),
                    (EVENT_VERSION, env.ledger().sequence(), addr.clone(), payout),
                );
            }
        }

        // Rollback strategy (#463): if any transfer would fail, emit the summary event
        // (visible in the failed transaction meta for off-chain indexers) then panic so
        // all state changes are rolled back atomically.
        if failure_count > 0 {
            env.events().publish(
                (symbol_short!("royalty"), symbol_short!("sec_dist")),
                (EVENT_VERSION, env.ledger().sequence(), token, pool, dust, success_count, failure_count),
            );
            Self::fail(&env, ContractError::InsufficientBalance);
        }

        // Record distribution with dust tracking (#398)
        let mut history: Vec<DistributionRecord> =
            storage::persistent_get::<Vec<DistributionRecord>>(
                &env,
                &StorageKey::DistributionHistory,
            )
            .unwrap_or(Vec::new(&env));
        history.push_back(DistributionRecord {
            total_amount: pool,
            dust,
            timestamp: env.ledger().timestamp(),
        });
        storage::persistent_set(&env, &StorageKey::DistributionHistory, &history);

        for (addr, payout) in payouts.iter() {
            token_client.transfer(&env.current_contract_address(), &addr, &payout);
            env.events().publish(
                (symbol_short!("sec_dist"),),
                (EVENT_VERSION, env.ledger().sequence(), addr, payout),
            );
        }

        storage::instance_set(&env, &StorageKey::SecondaryPool, &0_i128);

        // Store dust for next distribution (#398)
        storage::instance_set(&env, &StorageKey::SecondaryDust, &dust);

        // #463: Summary event includes success/failure counters for monitoring.
        env.events().publish(
            (symbol_short!("royalty"), symbol_short!("sec_dist")),
            (EVENT_VERSION, env.ledger().sequence(), token, pool, dust, success_count, failure_count),
        );

        storage::instance_set(
            &env,
            &StorageKey::LastSecondaryDistribution,
            &env.ledger().timestamp(),
        );
    }
}

#[contractimpl]
impl RoyaltySplitter {
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
}

#[contractimpl]
impl RoyaltySplitter {
    /// Returns the current secondary royalty rate in basis points (0–10,000).
    /// Returns 0 if `set_royalty_rate` has never been called.
    pub fn get_royalty_rate(env: Env) -> u32 {
        storage::extend_instance_ttl(&env);
        env.storage()
            .instance()
            .get(&StorageKey::RoyaltyRate)
            .unwrap_or(0)
    }
}

#[contractimpl]
impl RoyaltySplitter {
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
            (
                EVENT_VERSION,
                env.ledger().sequence(),
                collaborator,
                new_share,
            ),
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
            (
                EVENT_VERSION,
                env.ledger().sequence(),
                admins.len(),
                threshold,
            ),
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
}
