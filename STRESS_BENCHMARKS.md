# Stress Benchmarks

This repo now includes stress coverage for large recipient sets and repeated
distributions in [`tests/stress_tests.rs`](./tests/stress_tests.rs).

Soroban test environments expose CPU instructions and memory as the closest
available proxy for on-chain gas during local verification. The stress tests
measure CPU usage with `env.budget()` and assert the contract stays below
`1_000_000` CPU instructions per large batch.

## Scenarios

| Scenario | Recipients | Cycles | Amount | CPU guard |
| --- | ---: | ---: | ---: | ---: |
| 100+ recipient override distribution | 120 | 1 | 120,000,000 | `< 1,000,000` |
| Repeated large batches on same contract | 100 | 5 | 500,000,000 | `< 1,000,000` per cycle |
| Large-amount distribution | 100 | 1 | 1,000,000,000,000,000 | `< 1,000,000` |
| Scale comparison | 100 vs 120 | 2 | 10,000,000 | larger batch must cost more CPU and stay `< 1,000,000` |
| Residual-balance check | 150 | 3 | 75,000,000 | contract balance returns to `0` each cycle |

## Notes

- The 100+ recipient cases use `distribute_with_override`, because the contract
  still caps initialized collaborator lists at 10 addresses.
- The benchmarks are intentionally run on realistic distribution sizes rather
  than synthetic micro-benchmarks.
- For mainnet readiness, re-run the stress suite against a Soroban-compatible
  local or staging network before deployment.

## Validation Checklist

Use this checklist when reviewing a release candidate:

1. Run `cargo test --test stress_tests`.
2. Confirm all five stress scenarios pass.
3. Record the CPU instruction totals printed by the test harness or CI logs.
4. Verify each large batch stays below the 1M CPU guard.
5. Re-run the same scenarios on a Soroban-compatible staging or mainnet-fork
   environment before deployment.

## Scenario Summary

- `test_override_distribution_with_100_plus_recipients`: 120 recipients, one
  large batch, measures CPU usage.
- `test_repeated_large_batches_same_contract`: 100 recipients, 5 repeated
  distributions on the same contract.
- `test_large_amount_distribution_with_100_recipients`: 100 recipients, very
  large token amount, checks rounding and overflow safety.
- `test_large_batch_scale_is_reasonable`: compares 100 vs 120 recipients to
  confirm scaling behavior.
- `test_repeated_batches_do_not_leave_residual_balance`: 150 recipients, 3
  repeated batches, ensures no contract-side balance residue remains.
