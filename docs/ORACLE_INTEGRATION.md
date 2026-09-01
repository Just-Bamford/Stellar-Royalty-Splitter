# Royalty-rate oracle integration

The contract supports the [SEP-40 Oracle Consumer Interface](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0040.md), which is the common price-feed interface used by Stellar oracle providers. Stellar’s oracle documentation currently identifies **Reflector Network** as a public SEP-40-compatible provider and also lists DIA feeds. Reflector reports prices as an integer plus a provider-wide `decimals()` precision, so the contract normalizes the returned `lastprice` value to basis points before storing it as the royalty rate.

## Configuration

An administrator calls `set_royalty_oracle(source, asset, update_frequency, max_staleness)`. `source` is the deployed SEP-40 oracle contract, and `asset` is either `OracleAsset::Stellar(address)` or `OracleAsset::Other(symbol)`. Both time values are expressed in seconds and must be non-zero. The current configuration is available through `get_royalty_oracle()`.

Soroban contracts cannot wake themselves up on a timer. The configured frequency therefore acts as an on-chain eligibility interval: an external keeper, backend, or administrator calls `update_royalty_rate_from_oracle()` after the interval has elapsed. The function is permissionless so a keeper can perform the refresh without holding the contract administrator’s key. The contract records the refresh timestamp only after a successful quote has been validated.

## Safety and fallback behavior

`fetch_royalty_rate_from_oracle()` calls the oracle’s `decimals()` and `lastprice(asset)` methods through a fallible cross-contract invocation. It rejects missing, malformed, future-dated, stale, non-positive, over-precision, and out-of-range values. `update_royalty_rate_from_oracle()` changes the stored rate only after all checks succeed. If the oracle call fails or the quote is stale, the previous manual or oracle-derived rate remains unchanged; callers can continue using that rate as the fallback.

The update frequency prevents repeated refreshes within the configured interval. It is deliberately enforced by the contract rather than by a keeper, so multiple keepers cannot cause unnecessary rate changes or duplicate history entries. Every successful refresh uses the existing royalty-rate history and event path, preserving the audit trail used by manual rate updates.

## Testing on a simulated network

The integration tests register a local mock SEP-40 oracle contract in `tests/oracle_test.rs`. Run the tests with:

```text
cargo test --features testutils --test oracle_test -- --nocapture
```

The suite verifies a successful quote and decimal conversion, administrator configuration, missing-quote fallback, stale-quote rejection, refresh-frequency enforcement, and the full upgrade path. The upgrade test initializes the v1 contract, configures and uses the oracle, uploads the compiled WASM as the v2 artifact, calls `update_wasm`, verifies the administrator, initialization state, royalty rate, and oracle configuration, then invokes the new v2 oracle refresh method again. This simulates the Soroban upgrade flow while keeping all state in the same contract address.

For a deployed testnet or mainnet instance, replace the mock source with a provider’s deployed contract address, select the provider’s supported asset identifier, and use a keeper or backend job to call the refresh method at the configured interval. The provider’s documented resolution and retention should be reflected in `max_staleness`; Reflector’s public documentation describes a default five-minute feed resolution and advises consumers to check timestamps for staleness.
