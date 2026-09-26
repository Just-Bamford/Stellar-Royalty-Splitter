//! Typed storage accessors (Soroban `#[contracttype]` key pattern).

use soroban_sdk::{contracttype, Address, Env, IntoVal, TryFromVal, Val};

use crate::StorageKey;

/// Minimum ledgers before bumping instance storage TTL.
pub const MIN_TTL: u32 = 17_280;
/// Maximum target TTL for instance storage.
pub const MAX_TTL: u32 = 34_560;

/// Persistent storage TTL constants — much larger than instance because persistent
/// entries are only bumped explicitly (not on every function call).
/// 518_400 ≈ 30 days; 2_073_600 ≈ 120 days (Stellar mainnet archival threshold).
pub const PERSISTENT_MIN_TTL: u32 = 518_400;
pub const PERSISTENT_MAX_TTL: u32 = 2_073_600;

/// Bump instance storage TTL so contract state does not expire on Mainnet.
pub fn extend_instance_ttl(env: &Env) {
    env.storage().instance().extend_ttl(MIN_TTL, MAX_TTL);
}

/// Bump a single persistent storage key's TTL.
#[allow(dead_code)]
pub fn extend_persistent_ttl_for(env: &Env, key: &StorageKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_MIN_TTL, PERSISTENT_MAX_TTL);
}

/// Read a value from instance storage.
pub fn instance_get<T>(env: &Env, key: &StorageKey) -> Option<T>
where
    T: TryFromVal<Env, Val> + Clone,
{
    env.storage().instance().get(key)
}

/// Write a value to instance storage.
pub fn instance_set<T>(env: &Env, key: &StorageKey, value: &T)
where
    T: IntoVal<Env, Val> + Clone,
{
    env.storage().instance().set(key, value);
}

/// Returns whether instance storage contains `key`.
#[allow(dead_code)]
pub fn instance_has(env: &Env, key: &StorageKey) -> bool {
    env.storage().instance().has(key)
}

/// Write a value to persistent storage and bump its TTL.
pub fn persistent_set<T>(env: &Env, key: &StorageKey, value: &T)
where
    T: IntoVal<Env, Val> + Clone,
{
    env.storage().persistent().set(key, value);
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_MIN_TTL, PERSISTENT_MAX_TTL);
}

/// Remove a value from persistent storage.
#[allow(dead_code)]
pub fn persistent_remove(env: &Env, key: &StorageKey) {
    env.storage().persistent().remove(key);
}

/// Read a value from persistent storage and bump its TTL if present.
pub fn persistent_get<T>(env: &Env, key: &StorageKey) -> Option<T>
where
    T: TryFromVal<Env, Val> + Clone,
{
    let val: Option<T> = env.storage().persistent().get(key);
    if val.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_MIN_TTL, PERSISTENT_MAX_TTL);
    }
    val
}

// ─────────────────────────────────────────────────────────────────────────────
// #933 — NFT metadata binding for dynamic rates
// ─────────────────────────────────────────────────────────────────────────────

/// Binds the contract to an NFT collection and the external metadata oracle
/// that knows each token's attributes (rarity, tier, ...). Stored under
/// `StorageKey::MetadataBinding`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataBinding {
    pub collection_address: Address,
    pub metadata_oracle: Address,
}

/// A cached metadata-oracle answer for one token, stored under
/// `StorageKey::MetadataRateCache(collection, token_id)`.
///
/// `rate_override` is cached even when it is `None` ("no override for this
/// token") so a token without special attributes does not cost an oracle call
/// on every sale. The oracle address is recorded so rebinding to a different
/// oracle invalidates every entry written by the previous one.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataRateCache {
    pub metadata_oracle: Address,
    pub rate_override: Option<u32>,
    pub cached_at: u64,
}

/// How long a metadata-oracle answer stays valid, in seconds (1 hour).
pub const METADATA_CACHE_TTL_SECS: u64 = 3_600;

/// Temporary-storage TTL for cache entries, in ledgers. Comfortably longer
/// than `METADATA_CACHE_TTL_SECS` at ~5 s per ledger; freshness is decided by
/// `cached_at`, this only stops dead entries from lingering on-ledger.
pub const METADATA_CACHE_LEDGER_TTL: u32 = 1_440;

// ─────────────────────────────────────────────────────────────────────────────
// #932 — Linked pools
// ─────────────────────────────────────────────────────────────────────────────

/// A link to another royalty-splitter contract whose collaborators take
/// `share` basis points of every primary distribution made by this contract.
/// The whole list is stored under `StorageKey::LinkedContracts`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LinkedPool {
    pub source_contract: Address,
    pub share: u32,
}

/// Maximum number of pools a single contract may link to. Every link is one
/// extra token transfer per distribution, so the list is kept small.
pub const MAX_LINKED_POOLS: u32 = 5;

/// Read a value from temporary storage.
pub fn temporary_get<T>(env: &Env, key: &StorageKey) -> Option<T>
where
    T: TryFromVal<Env, Val> + Clone,
{
    env.storage().temporary().get(key)
}

/// Write a value to temporary storage with the given ledger TTL.
pub fn temporary_set<T>(env: &Env, key: &StorageKey, value: &T, ttl: u32)
where
    T: IntoVal<Env, Val> + Clone,
{
    env.storage().temporary().set(key, value);
    env.storage().temporary().extend_ttl(key, ttl, ttl);
}

// ─────────────────────────────────────────────────────────────────────────────
// #955 — Governance token and staking
// ─────────────────────────────────────────────────────────────────────────────

/// Governance token staking information for an account.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StakeInfo {
    pub staked_amount: i128,
    pub pending_unstake_amount: i128,
    pub cooldown_until: u64,
}
