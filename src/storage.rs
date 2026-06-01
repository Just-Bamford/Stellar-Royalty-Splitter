//! Typed storage accessors (Soroban `#[contracttype]` key pattern).

use soroban_sdk::{Env, IntoVal, TryFromVal, Val};

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
