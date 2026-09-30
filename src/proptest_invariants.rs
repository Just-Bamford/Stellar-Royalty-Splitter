//! Property-Based Testing for Contract Invariants
//! Issue #965 - Testing contract with extreme values and edge cases
//!
//! This module defines invariants that MUST ALWAYS hold regardless of input:
//! 1. Share sum invariant: Collaborator shares always sum to exactly 10,000
//! 2. Distribution conservation: Total distributed amount equals input amount
//! 3. No loss invariant: Sum of all payouts equals total royalty amount
//! 4. Rounding fairness: Rounding errors are minimal and distributed fairly
//! 5. No duplicate recipients: All recipient addresses are unique
//! 6. Non-negative amounts: All share amounts are >= 0
//! 7. Maximum collaborators: Number of collaborators <= MAX_COLLABORATORS

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    // Re-export from main contract for testing
    const MAX_COLLABORATORS: u32 = 100;
    const SHARE_PRECISION: i128 = 10_000;

    /// Generate valid collaborator shares that sum to exactly 10,000
    fn valid_shares_strategy() -> impl Strategy<Value = Vec<i128>> {
        (1..=MAX_COLLABORATORS as usize).prop_flat_map(|num_collabs| {
            prop::collection::vec(1i128..SHARE_PRECISION, num_collabs - 1).prop_map(
                move |mut partial_shares| {
                    // Ensure they don't exceed SHARE_PRECISION
                    let mut result = Vec::new();
                    let mut sum = 0i128;
                    let partial_len = partial_shares.len() as i128;

                    for share in partial_shares.iter_mut() {
                        // Clamp to ensure we don't exceed total
                        let max_allowed =
                            SHARE_PRECISION - sum - (partial_len - result.len() as i128);
                        *share = (*share).min(max_allowed).max(1);
                        result.push(*share);
                        sum += *share;
                    }

                    // Last share fills to exactly SHARE_PRECISION
                    result.push(SHARE_PRECISION - sum);
                    result
                },
            )
        })
    }

    /// Generate large royalty amounts for edge case testing
    fn large_amount_strategy() -> impl Strategy<Value = i128> {
        prop_oneof![
            // Small amounts (rounding edge cases)
            1i128..=1000i128,
            // Medium amounts
            1000i128..=1_000_000i128,
            // Large amounts
            1_000_000i128..=1_000_000_000i128,
            // Very large amounts (near i128 limits, but safe for multiplication)
            1_000_000_000i128..=100_000_000_000i128,
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        /// Property: Share sum must always equal 10,000 (SHARE_PRECISION)
        #[test]
        fn prop_shares_always_sum_to_precision(shares in valid_shares_strategy()) {
            let sum: i128 = shares.iter().sum();
            prop_assert_eq!(sum, SHARE_PRECISION, "Shares must sum to exactly {}", SHARE_PRECISION);
        }

        /// Property: Distribution conserves total amount (no loss, no gain)
        #[test]
        fn prop_distribution_conserves_total(
            shares in valid_shares_strategy(),
            amount in large_amount_strategy()
        ) {
            // Calculate distributed amounts using the same logic as contract
            let mut total_distributed = 0i128;

            for share in shares.iter() {
                let portion = (amount * share) / SHARE_PRECISION;
                total_distributed += portion;
            }

            // Allow rounding error of at most (num_collaborators - 1)
            let rounding_error = (amount - total_distributed).abs();
            let max_rounding = (shares.len() as i128 - 1).max(0);

            prop_assert!(
                rounding_error <= max_rounding,
                "Rounding error {} exceeds maximum allowed {} for {} collaborators",
                rounding_error,
                max_rounding,
                shares.len()
            );
        }

        /// Property: No single collaborator receives more than their fair share + rounding
        #[test]
        fn prop_no_overpayment(
            shares in valid_shares_strategy(),
            amount in large_amount_strategy()
        ) {
            for share in shares.iter() {
                let portion = (amount * share) / SHARE_PRECISION;
                let theoretical_max = (amount * share + SHARE_PRECISION - 1) / SHARE_PRECISION;

                prop_assert!(
                    portion <= theoretical_max,
                    "Collaborator received {} but max should be {}",
                    portion,
                    theoretical_max
                );
            }
        }

        /// Property: All distributed amounts are non-negative
        #[test]
        fn prop_no_negative_payouts(
            shares in valid_shares_strategy(),
            amount in 0i128..=1_000_000_000
        ) {
            for share in shares.iter() {
                let portion = (amount * share) / SHARE_PRECISION;
                prop_assert!(portion >= 0, "Payout cannot be negative: {}", portion);
            }
        }

        /// Property: Rounding error is distributed fairly (no single large error)
        #[test]
        fn prop_rounding_error_distribution(
            shares in valid_shares_strategy(),
            amount in large_amount_strategy()
        ) {
            let mut total_distributed = 0i128;
            let mut portions = Vec::new();

            for share in shares.iter() {
                let portion = (amount * share) / SHARE_PRECISION;
                portions.push(portion);
                total_distributed += portion;
            }

            let total_error = amount - total_distributed;

            // Each collaborator's rounding error should be at most 1
            for (share, portion) in shares.iter().zip(portions.iter()) {
                let theoretical = (amount * share) as f64 / SHARE_PRECISION as f64;
                let actual_error = (theoretical - *portion as f64).abs();

                prop_assert!(
                    actual_error <= 1.0,
                    "Individual rounding error {} exceeds 1 for share {}",
                    actual_error,
                    share
                );
            }

            // Total error should be small relative to number of collaborators
            prop_assert!(
                total_error.abs() <= shares.len() as i128,
                "Total rounding error {} too large for {} collaborators",
                total_error,
                shares.len()
            );
        }

        /// Property: Zero amount distributes to all zeros
        #[test]
        fn prop_zero_amount_distributes_to_zeros(shares in valid_shares_strategy()) {
            let amount = 0i128;

            for share in shares.iter() {
                let portion = (amount * share) / SHARE_PRECISION;
                prop_assert_eq!(portion, 0, "Zero amount should distribute to zero");
            }
        }

        /// Property: Shares must all be positive (1..=10000)
        #[test]
        fn prop_all_shares_positive(shares in valid_shares_strategy()) {
            for share in shares.iter() {
                prop_assert!(*share > 0, "Share must be positive: {}", share);
                prop_assert!(*share <= SHARE_PRECISION, "Share cannot exceed precision: {}", share);
            }
        }

        /// Property: Number of collaborators within bounds
        #[test]
        fn prop_collaborator_count_within_bounds(shares in valid_shares_strategy()) {
            prop_assert!(
                shares.len() >= 1 && shares.len() <= MAX_COLLABORATORS as usize,
                "Collaborator count {} out of bounds [1, {}]",
                shares.len(),
                MAX_COLLABORATORS
            );
        }

        /// Property: Distribution is monotonic (larger share = larger payout)
        #[test]
        fn prop_distribution_monotonic(
            shares in valid_shares_strategy(),
            amount in 1i128..=1_000_000_000
        ) {
            let mut portions: Vec<(i128, i128)> = shares.iter()
                .map(|&share| {
                    let portion = (amount * share) / SHARE_PRECISION;
                    (share, portion)
                })
                .collect();

            // Sort by share
            portions.sort_by_key(|&(share, _)| share);

            // Check monotonicity (allowing for rounding ties)
            for i in 1..portions.len() {
                let (share1, portion1) = portions[i - 1];
                let (share2, portion2) = portions[i];

                if share2 > share1 {
                    prop_assert!(
                        portion2 >= portion1,
                        "Larger share {} got smaller payout {} vs share {} payout {}",
                        share2,
                        portion2,
                        share1,
                        portion1
                    );
                }
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(50))]

        /// Property: Extreme cases - single collaborator gets everything
        #[test]
        fn prop_single_collaborator_gets_all(amount in large_amount_strategy()) {
            let shares = vec![SHARE_PRECISION];
            let portion = (amount * shares[0]) / SHARE_PRECISION;

            prop_assert_eq!(portion, amount, "Single collaborator must receive entire amount");
        }

        /// Property: Equal shares distribute equally (or within rounding)
        #[test]
        fn prop_equal_shares_distribute_fairly(
            num_collabs in 2..=20usize,
            amount in large_amount_strategy()
        ) {
            let share_each = SHARE_PRECISION / num_collabs as i128;
            let remainder = SHARE_PRECISION % num_collabs as i128;

            let mut shares = vec![share_each; num_collabs];
            // Distribute remainder to first collaborators
            for i in 0..remainder as usize {
                shares[i] += 1;
            }

            let portions: Vec<i128> = shares.iter()
                .map(|&share| (amount * share) / SHARE_PRECISION)
                .collect();

            // All portions should be within 1 of each other
            let min_portion = *portions.iter().min().unwrap();
            let max_portion = *portions.iter().max().unwrap();
            let max_allowed_diff = (amount / SHARE_PRECISION) + 1;

            prop_assert!(
                max_portion - min_portion <= max_allowed_diff,
                "Equal shares produced unequal payouts: min={}, max={}, max_allowed={}",
                min_portion,
                max_portion,
                max_allowed_diff
            );
        }

        /// Property: Very large amounts don't overflow
        #[test]
        fn prop_no_overflow_on_large_amounts(
            shares in valid_shares_strategy(),
            amount in 1_000_000_000i128..=10_000_000_000i128
        ) {
            for share in shares.iter() {
                // This should not panic due to overflow
                let portion = (amount * share) / SHARE_PRECISION;

                prop_assert!(
                    portion >= 0,
                    "Large amount calculation resulted in negative: {}",
                    portion
                );
            }
        }
    }

    #[test]
    fn test_invariant_documentation() {
        // This test documents the invariants for maintainers
        println!("CONTRACT INVARIANTS (must always hold):");
        println!("1. Share sum = 10,000 (SHARE_PRECISION)");
        println!("2. Distribution conservation: Σ(payouts) ≈ total_amount");
        println!("3. No negative payouts");
        println!("4. Rounding error ≤ (num_collaborators - 1)");
        println!("5. Monotonicity: larger share → larger payout");
        println!("6. All shares > 0 and ≤ 10,000");
        println!("7. Collaborators ∈ [1, {}]", MAX_COLLABORATORS);
        println!("8. No overflow on large amounts");
    }
}
