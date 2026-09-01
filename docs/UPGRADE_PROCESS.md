# Contract Upgrade Process

This document describes how to safely upgrade the `RoyaltySplitter` Soroban contract
on Stellar while preserving all on-chain state.

---

## How Soroban contract upgrades work

A Soroban contract upgrade replaces the contract's executable WASM bytecode in-place,
without touching any storage entries. The contract address, instance storage, and
persistent storage all remain unchanged. From the perspective of callers, the contract
address is the same — only the logic changes.

The upgrade is performed by calling `update_wasm(wasm_hash)`, which is a privileged
entrypoint that calls `env.deployer().update_current_contract_wasm(wasm_hash)` under
the hood. The WASM blob must be uploaded to the ledger before this call; the hash
returned by the upload is what gets passed to `update_wasm`.

---

## Step-by-step upgrade guide

### 1. Build and optimize the new WASM

```bash
# Build the release artifact
cargo build --target wasm32-unknown-unknown --release

# Optionally optimise for size (reduces ledger fees)
make optimize
```

The artifact is written to:
`target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm`

### 2. Upload the WASM to the Stellar network

Use the Stellar CLI to upload the contract bytecode and record the hash it returns:

```bash
stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/stellar_royalty_splitter.wasm \
  --source <ADMIN_KEYPAIR> \
  --network <mainnet|testnet>
```

The command prints a 32-byte hex hash (e.g. `abc123...`). Save it — you need it in
the next step.

### 3. Call `update_wasm` on the deployed contract

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_KEYPAIR> \
  --network <mainnet|testnet> \
  -- update_wasm \
  --wasm_hash <HEX_HASH_FROM_STEP_2>
```

This call requires an admin signature. If the contract uses multi-sig (`set_admins`),
the required threshold of admins must all sign the transaction.

### 4. Verify the upgrade

```bash
# Check the version string returned by the upgraded contract
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ANY_KEYPAIR> \
  --network <mainnet|testnet> \
  -- get_version
```

The returned string should match the `version` field in `Cargo.toml`.

---

## What is preserved across upgrades

All storage entries survive a WASM upgrade unchanged:

| Storage tier | Key | Preserved? |
|---|---|---|
| Instance | `Admin` | ✅ Yes |
| Instance | `ContractVersion` | ✅ Yes (value from before upgrade) |
| Instance | `Paused` | ✅ Yes |
| Instance | `RoyaltyRate` | ✅ Yes |
| Instance | `SecondaryPool` | ✅ Yes |
| Instance | `SecondaryToken` | ✅ Yes |
| Instance | `LastDistribution` | ✅ Yes |
| Instance | `DistributeHistory` | ✅ Yes |
| Instance | `PendingAdmin` | ✅ Yes |
| Instance | `AdminList` | ✅ Yes |
| Instance | `AdminThreshold` | ✅ Yes |
| Persistent | `Collaborators` | ✅ Yes |
| Persistent | `ShareMap` | ✅ Yes |
| Persistent | `DefaultRecipients` | ✅ Yes |
| Persistent | `RoyaltyRateHistory` | ✅ Yes |

The `ContractVersion` key is **not** automatically updated on upgrade — it retains
the value written at `initialize` time. If you want callers to detect the new
version, update it explicitly after the upgrade:

```bash
# There is no built-in "set_version" call — the version is informational only.
# Callers should use the WASM hash or your own off-chain registry to track versions.
```

---

## Rollback procedure

Soroban does not have a built-in rollback mechanism. A rollback is simply another
`update_wasm` call that points to the **previous** WASM artifact.

Best practice:

1. **Keep the previous WASM hash** in your deployment log or a configuration file
   before every upgrade.
2. If the new version is found to be faulty:
   - Optionally call `pause()` immediately to halt distributions.
   - Upload the previous WASM to the network (if it is not already uploaded and
     still has a live ledger entry).
   - Call `update_wasm(<previous_hash>)` to restore the old logic.
3. Verify state integrity using the read-only getters (`get_admin`, `get_recipients`,
   `get_distribute_count`, etc.).
4. Call `unpause()` once you are satisfied.

Since all storage is preserved through every `update_wasm` call, a rollback followed
by re-upgrade is always safe from a data perspective. The only concern is any state
mutations that happened between the forward upgrade and the rollback — those are
permanent.

---

## Pre-upgrade checklist

- [ ] New WASM builds without warnings (`cargo build --release`)
- [ ] All tests pass locally (`cargo test --features testutils`)
- [ ] Upgrade tests pass (`cargo test --features testutils --test upgrade_test`)
- [ ] WASM size is within acceptable limits (`make check-size`)
- [ ] Previous WASM hash is recorded in your deployment log
- [ ] Admin key(s) are available and accessible
- [ ] If multi-sig is configured, all required signers are coordinated
- [ ] Contract is optionally paused during the upgrade window to prevent concurrent
  distributions

---

## Testing

The upgrade test suite lives in `tests/upgrade_test.rs` and covers:

| Test | Scenario |
|---|---|
| `test_upgrade_success` | Happy-path upgrade; contract remains functional |
| `test_upgrade_requires_admin_auth` | Non-admin cannot trigger upgrade |
| `test_upgrade_before_initialize_panics` | Upgrade on uninitialized contract panics |
| `test_upgrade_preserves_core_state` | Admin, shares, version, paused flag all survive |
| `test_upgrade_preserves_royalty_rate` | Royalty rate survives upgrade |
| `test_upgrade_preserves_distribute_history` | Distribution counter survives upgrade |
| `test_upgrade_preserves_default_recipients` | Default recipients survive upgrade |
| `test_upgrade_preserves_secondary_pool` | Secondary pool balance survives upgrade |
| `test_rollback_via_second_upgrade` | Two consecutive upgrades leave state intact |
| `test_rollback_while_paused` | Pause flag survives forward + rollback upgrade |
| `test_rollback_after_recipient_update` | Recipient changes post-upgrade survive rollback |
| `test_upgrade_path_then_update_recipients` | Add collaborator after upgrade; distribute correctly |
| `test_upgrade_path_with_secondary_royalties` | Secondary royalties distribute correctly post-upgrade |
| `test_upgrade_path_preserves_multi_sig_admins` | Multi-sig admin list survives upgrade |
| `test_two_sequential_upgrades` | Two sequential upgrades; counter increments correctly |
| `test_distribute_works_after_upgrade` | `distribute()` works post-upgrade |
| `test_distribute_with_override_works_after_upgrade` | `distribute_with_override()` works post-upgrade |
| `test_batch_distribute_works_after_upgrade` | `batch_distribute()` works post-upgrade |

Run the suite with:

```bash
cargo test --features testutils --test upgrade_test -- --nocapture
```
