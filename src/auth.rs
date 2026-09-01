//! Authorization helpers with consistent, integrator-facing failure context.

use soroban_sdk::{symbol_short, Address, Env, String};

/// Static auth failure messages (function context + role).
pub mod msg {
    pub const INITIALIZE_ADMIN: &str = "initialize: admin authorization required";
    pub const SET_ROYALTY_RATE_ADMIN: &str = "set_royalty_rate: admin authorization required";
    pub const PAUSE_ADMIN: &str = "pause: admin authorization required";
    pub const UNPAUSE_ADMIN: &str = "unpause: admin authorization required";
    pub const PAUSE_OPERATION_ADMIN: &str = "pause_operation: admin authorization required";
    pub const UNPAUSE_OPERATION_ADMIN: &str = "unpause_operation: admin authorization required";
    pub const ADMIN_TRANSFER_ADMIN: &str = "admin_transfer: admin authorization required";
    pub const PROPOSE_ADMIN_ADMIN: &str = "propose_admin_transfer: admin authorization required";
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
    pub const SET_INCENTIVES_ENABLED_ADMIN: &str =
        "set_incentives_enabled: admin authorization required";
    pub const DISTRIBUTE_INCENTIVES_ADMIN: &str =
        "distribute_with_incentives: admin authorization required";
    pub const INITIATE_ADMIN_ROTATION_ADMIN: &str =
        "initiate_admin_rotation: admin authorization required";
    pub const CANCEL_ADMIN_ROTATION_ADMIN: &str =
        "cancel_admin_rotation: admin authorization required";
    pub const SET_ADMIN_ROTATION_TIMELOCK_ADMIN: &str =
        "set_admin_rotation_timelock: admin authorization required";
    pub const DISTRIBUTE_RESILIENT_ADMIN: &str =
        "distribute_resilient: admin authorization required";
    pub const SET_ANOMALY_THRESHOLD_ADMIN: &str =
        "set_anomaly_threshold: admin authorization required";
    pub const TRIGGER_EMERGENCY_PAUSE_ADMIN: &str =
        "trigger_emergency_pause: admin authorization required";
    pub const CLEAR_EMERGENCY_PAUSE_ADMIN: &str =
        "clear_emergency_pause: unanimous admin authorization required";
    pub const SET_APPROVED_TOKENS_ADMIN: &str = "set_approved_tokens: admin authorization required";
    pub const RECORD_DISPUTE_ADMIN: &str = "record_dispute: admin authorization required";
    pub const RESOLVE_DISPUTE_ADMIN: &str = "resolve_dispute: admin authorization required";
    pub const CLAWBACK_ADMIN: &str = "clawback: admin authorization required";
    pub const PROPOSE_OPERATION_ADMIN: &str = "propose_operation: admin authorization required";
    pub const APPROVE_OPERATION_ADMIN: &str = "approve_operation: admin authorization required";
    pub const SET_EMERGENCY_PAUSE_SIGNERS_ADMIN: &str =
        "set_emergency_pause_signers: admin authorization required";
    pub const EMERGENCY_PAUSE_SIGNER: &str =
        "emergency_pause: authorized emergency signer authorization required";
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
