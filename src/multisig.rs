//! Multi-signature (M-of-N) threshold verification (#1041).
//!
//! On-chain M-of-N authorization for sensitive operations is enforced by the
//! governance flow introduced in #894 (`propose_operation` / `approve_operation`,
//! with a configurable admin `threshold` set via `set_admins`). This module
//! contributes the reusable, fully unit-tested threshold-verification primitive
//! that the off-chain orchestration service (`multisig-manager.js`) and the
//! `MultiSigSigning` UI share, so the "M distinct signatures met the threshold"
//! rule is defined and validated in one place.
//!
//! The primitive is intentionally pure (operates on counts, not host state) so it
//! can be unit-tested by `cargo test` without standing up a Soroban environment,
//! and it mirrors the comparison performed in `approve_operation`.

/// Returns `true` when `provided` distinct valid signatures satisfy an M-of-N
/// threshold of `required`.
///
/// * `required` is **M** — the minimum number of distinct authorized signatures.
/// * `provided` is the count of distinct, authorized signatures collected so far.
///
/// A threshold of `0` (unconfigured) is intentionally **never** satisfied, so an
/// M-of-N gate cannot be bypassed by an unset threshold (#1041 false-positive
/// guard).
pub fn verify_m_of_n(required: u32, provided: u32) -> bool {
    required >= 1 && provided >= required
}

/// Alias matching the on-chain `approve_operation` semantics: `true` when the
/// collected approver count reaches the proposal threshold.
pub fn threshold_met(threshold: u32, approver_count: u32) -> bool {
    verify_m_of_n(threshold, approver_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m_of_n_exact_threshold_succeeds() {
        assert!(verify_m_of_n(3, 3));
        assert!(verify_m_of_n(1, 1));
    }

    #[test]
    fn m_of_n_below_threshold_fails() {
        assert!(!verify_m_of_n(3, 2));
        assert!(!verify_m_of_n(2, 1));
        assert!(!verify_m_of_n(1, 0));
    }

    #[test]
    fn m_of_n_unconfigured_threshold_never_passes() {
        assert!(!verify_m_of_n(0, 5));
        assert!(!verify_m_of_n(0, 0));
    }

    #[test]
    fn m_of_n_more_than_threshold_succeeds() {
        assert!(verify_m_of_n(2, 5));
        assert!(verify_m_of_n(3, 10));
    }

    #[test]
    fn threshold_met_matches_verify_m_of_n() {
        assert!(threshold_met(3, 3));
        assert!(!threshold_met(3, 2));
        assert!(!threshold_met(0, 9));
    }
}
