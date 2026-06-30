//! Authorization helpers with consistent, integrator-facing failure context.

use soroban_sdk::{symbol_short, Address, Env, String};

/// Static auth failure messages (function context + role).
pub mod msg {
    pub const INITIALIZE_ADMIN: &str = "initialize: admin authorization required";
    pub const COMMIT_INITIALIZE_ADMIN: &str = "commit_initialize: admin authorization required";
    pub const REVEAL_INITIALIZE_ADMIN: &str = "reveal_initialize: admin authorization required";
    pub const SET_ROYALTY_RATE_ADMIN: &str = "set_royalty_rate: admin authorization required";
    pub const PAUSE_ADMIN: &str = "pause: admin authorization required";
    pub const UNPAUSE_ADMIN: &str = "unpause: admin authorization required";
    pub const ADMIN_TRANSFER_ADMIN: &str = "admin_transfer: admin authorization required";
    pub const PROPOSE_ADMIN_ADMIN: &str =
        "propose_admin_transfer: admin authorization required";
    pub const ACCEPT_ADMIN_PENDING: &str = "accept_admin: pending admin authorization required";
    pub const SET_DEFAULT_RECIPIENTS_ADMIN: &str =
        "set_default_recipients: admin authorization required";
    pub const SET_RECIPIENTS_ADMIN: &str = "set_recipients: admin authorization required";
    pub const WITHDRAW_ADMIN: &str = "withdraw: admin authorization required";
    pub const DISTRIBUTE_ADMIN: &str = "distribute: admin authorization required";
    pub const DISTRIBUTE_OVERRIDE_ADMIN: &str =
        "distribute_with_override: admin authorization required";
    pub const BATCH_DISTRIBUTE_ADMIN: &str = "batch_distribute: admin authorization required";
    pub const DISTRIBUTE_SECONDARY_ADMIN: &str =
        "distribute_secondary_royalties: admin authorization required";
    pub const UPDATE_SHARE_ADMIN: &str = "update_share: admin authorization required";
    pub const UPDATE_WASM_ADMIN: &str = "update_wasm: admin authorization required";
    pub const RECORD_SECONDARY_PAYER: &str =
        "record_secondary_royalty: payer authorization required";
    pub const SET_ADMINS_ADMIN: &str = "set_admins: admin authorization required";
    pub const PAUSE_COLLABORATOR: &str = "pause_collaborator_distributions: collaborator authorization required";
}

/// Requires admin authorization; panics with `message` if missing.
pub fn require_admin(env: &Env, admin: &Address, message: &str) {
    require_address_auth(env, admin, message);
}

/// Requires payer authorization; panics with `message` if missing.
pub fn require_payer(env: &Env, payer: &Address, message: &str) {
    require_address_auth(env, payer, message);
}

fn require_address_auth(env: &Env, address: &Address, message: &str) {
    let context = String::from_str(env, message);
    env.events().publish((symbol_short!("auth_req"),), context);

    // Enforce authorization. Publish context before `require_auth` so failed
    // simulations include the function-specific message in event metadata.
    address.require_auth();
}
