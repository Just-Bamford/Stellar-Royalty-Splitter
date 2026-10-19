use proptest::prelude::*;

fn allocate(amount: i128, shares: &[u32]) -> Vec<i128> {
    let mut payouts = Vec::with_capacity(shares.len());
    let mut calculated = 0i128;
    for (index, share) in shares.iter().enumerate() {
        let payout = if index + 1 == shares.len() {
            amount - calculated
        } else {
            let q = amount / 10_000;
            let r = amount % 10_000;
            q * i128::from(*share) + (r * i128::from(*share)) / 10_000
        };
        if index + 1 != shares.len() {
            calculated += payout;
        }
        payouts.push(payout);
    }
    payouts
}

proptest! {
    #[test]
    fn distribution_conserves_every_strop((amount, raw) in (1i64..i64::MAX as i64, proptest::collection::vec(0u16..=10_000u16, 1..32))) {
        let raw_sum: u32 = raw.iter().map(|share| u32::from(*share)).sum();
        prop_assume!(raw_sum <= 10_000);
        let mut shares: Vec<u32> = raw.into_iter().map(u32::from).collect();
        *shares.last_mut().unwrap() += 10_000 - raw_sum;
        let payouts = allocate(i128::from(amount), &shares);
        prop_assert_eq!(payouts.iter().sum::<i128>(), i128::from(amount));
        prop_assert!(payouts.iter().all(|payout| *payout >= 0));
    }

    #[test]
    fn each_payout_respects_share_and_rounding_dust((amount, raw) in (1i64..1_000_000_000_000i64, proptest::collection::vec(0u16..=10_000u16, 1..24))) {
        let raw_sum: u32 = raw.iter().map(|share| u32::from(*share)).sum();
        prop_assume!(raw_sum <= 10_000);
        let mut shares: Vec<u32> = raw.into_iter().map(u32::from).collect();
        *shares.last_mut().unwrap() += 10_000 - raw_sum;
        let amount = i128::from(amount);
        let payouts = allocate(amount, &shares);
        for (index, (payout, share)) in payouts.iter().zip(shares.iter()).enumerate() {
            let exact_floor = (amount / 10_000) * i128::from(*share)
                + ((amount % 10_000) * i128::from(*share)) / 10_000;
            if index + 1 < shares.len() {
                prop_assert!(*payout <= exact_floor);
                prop_assert!(exact_floor - *payout <= 1);
            } else {
                prop_assert!(*payout <= exact_floor + i128::from(shares.len() as u32));
            }
        }
    }
}
