# Contract Events

All events emitted by the `RoyaltySplitter` Soroban contract.

Topic symbols are encoded with `symbol_short!` (≤ 8 chars). Data tuples are
serialised as Soroban `Val`s in XDR.

---

## `royalty` / `init`

Emitted by `initialize`.

| Field    | Type              | Description                          |
| -------- | ----------------- | ------------------------------------ |
| topics   | `(royalty, init)` | Fixed symbols                        |
| data[0]  | `Vec<Address>`    | Ordered collaborator addresses       |
| data[1]  | `Vec<u32>`        | Basis-point shares (sum = 10 000)    |

---

## `royalty` / `rate_set`

Emitted by `set_royalty_rate`.

| Field   | Type               | Description                  |
| ------- | ------------------ | ---------------------------- |
| topics  | `(royalty, rate_set)` | Fixed symbols             |
| data    | `u32`              | New royalty rate (bps)       |

---

## `royalty` / `admin_xfr`

Emitted by `admin_transfer` (single-step transfer).

| Field   | Type                    | Description                          |
| ------- | ----------------------- | ------------------------------------ |
| topics  | `(royalty, admin_xfr)`  | Fixed symbols                        |
| data[0] | `Address`               | Previous admin                       |
| data[1] | `Address`               | New admin                            |

---

## `royalty` / `adm_prop`

Emitted by `propose_admin_transfer`.

| Field   | Type                   | Description               |
| ------- | ---------------------- | ------------------------- |
| topics  | `(royalty, adm_prop)`  | Fixed symbols             |
| data    | `Address`              | Proposed new admin        |

---

## `royalty` / `adm_acc`

Emitted by `accept_admin`.

| Field   | Type                  | Description         |
| ------- | --------------------- | ------------------- |
| topics  | `(royalty, adm_acc)`  | Fixed symbols       |
| data[0] | `Address`             | Previous admin      |
| data[1] | `Address`             | New (accepted) admin |

---

## `default` / `rcpt_set`

Emitted by `set_default_recipients`.

| Field   | Type                  | Description                        |
| ------- | --------------------- | ---------------------------------- |
| topics  | `(default, rcpt_set)` | Fixed symbols                      |
| data    | `u32`                 | Number of default recipients set   |

---

## `royalty` / `recip_set`

Emitted by `set_recipients`.

| Field   | Type                   | Description                          |
| ------- | ---------------------- | ------------------------------------ |
| topics  | `(royalty, recip_set)` | Fixed symbols                        |
| data    | `u32`                  | Number of collaborators updated      |

---

## `royalty` / `withdraw`

Emitted by `withdraw`.

| Field   | Type                  | Description               |
| ------- | --------------------- | ------------------------- |
| topics  | `(royalty, withdraw)` | Fixed symbols             |
| data[0] | `Address`             | Token contract address    |
| data[1] | `i128`                | Amount withdrawn          |

---

## `royalty` / `dist_all`

Emitted by `distribute`, `distribute_with_override`, and `batch_distribute` (once per token).

| Field   | Type                  | Description                          |
| ------- | --------------------- | ------------------------------------ |
| topics  | `(royalty, dist_all)` | Fixed symbols                        |
| data[0] | `Address`             | Token contract address               |
| data[1] | `i128`                | Total amount distributed             |

---

## `royalty` / `batch`

Emitted by `batch_distribute` after all tokens are processed.

| Field   | Type               | Description                      |
| ------- | ------------------ | -------------------------------- |
| topics  | `(royalty, batch)` | Fixed symbols                    |
| data    | `u32`              | Number of tokens distributed     |

---

## `royalty` / `sec_dist`

Emitted by `distribute_secondary_royalties`.

| Field   | Type                  | Description                             |
| ------- | --------------------- | --------------------------------------- |
| topics  | `(royalty, sec_dist)` | Fixed symbols                           |
| data[0] | `Address`             | Token contract address                  |
| data[1] | `i128`                | Total secondary royalties distributed   |

---

## `share` / `updated`

Emitted by `update_share`.

| Field   | Type                 | Description                    |
| ------- | -------------------- | ------------------------------ |
| topics  | `(share, updated)`   | Fixed symbols                  |
| data[0] | `Address`            | Collaborator address           |
| data[1] | `u32`                | New basis-point share          |

---

## `royalty` / `adms_set`

Emitted by `set_admins`.

| Field   | Type                  | Description                        |
| ------- | --------------------- | ---------------------------------- |
| topics  | `(royalty, adms_set)` | Fixed symbols                      |
| data[0] | `u32`                 | Number of admins in the new list   |
| data[1] | `u32`                 | Signing threshold                  |

---

## `loan_liq` / `<borrower>` / `<liquidator>` — `loan_liquidated` (#665)

Emitted by `liquidate`.

| Field   | Type                                      | Description                             |
| ------- | ----------------------------------------- | --------------------------------------- |
| topics[0] | `Symbol` (`loan_liq`)                   | Fixed event discriminator               |
| topics[1] | `Address`                               | Borrower whose loan was liquidated      |
| topics[2] | `Address`                               | Liquidator performing the liquidation   |
| data    | `LiquidationEvent`                        | Struct with loan details (see below)    |

### `LiquidationEvent` struct

| Field              | Type     | Description                                     |
| ------------------ | -------- | ----------------------------------------------- |
| `loan_id`          | `String` | Unique loan identifier                          |
| `repay_amount`     | `i128`   | Amount repaid by the liquidator                 |
| `collateral_seized`| `i128`   | Collateral amount transferred to the liquidator |

**Authorization:** The `liquidator` address must sign the transaction.

**Backend processing:** On receipt, the backend records the liquidation in
`loan_liquidations` and updates the loan's status to `liquidated` (see
`backend/src/database/liquidations.js`).
