# Contract Event Schema

This document is the source of truth for every event the `RoyaltySplitter`
contract (`src/lib.rs`) emits via `env.events().publish(...)`. It exists so
indexers, the frontend, and analytics integrations can consume events
instead of polling storage (#661).

## Conventions

- **Topics** are a tuple of `Symbol`s. Every event below uses a 2-symbol
  topic of the shape `(namespace, action)`, e.g. `("royalty", "dist")`,
  except the diagnostic `auth_req` event (see [Diagnostic events](#diagnostic-events)).
- **Payloads** are a fixed-shape tuple per topic — the same topic always
  carries the same payload shape, so a consumer can decode by topic without
  inspecting the data first.
- No event payload ever contains a private key, signature, or secret. Payloads
  only carry addresses, amounts, and other data that is already public once
  the transaction is on-chain.
- `distribution_type` is a `Symbol` distinguishing how a payout was
  triggered: `"primary"` (single-token `distribute`/`distribute_with_override`),
  `"batch"` (`batch_distribute`), or `"secondary"` (`distribute_secondary_royalties`).

## Lifecycle events

| Topic | Emitted by | Payload | Description |
|---|---|---|---|
| `("royalty", "init")` | `initialize` | `(Vec<Address> collaborators, Vec<u32> shares)` | Fired once, when the split is initialized. `collaborators[0]` is the admin. |
| `("royalty", "rate_set")` | `set_royalty_rate` | `u32 new_rate` | New secondary royalty rate, in basis points. |
| `("royalty", "recip_set")` | `set_recipients` | `u32 recipient_count` | Primary collaborator list was replaced. |
| `("default", "rcpt_set")` | `set_default_recipients` | `u32 recipient_count` | Default (fallback) recipient list was set. |
| `("share", "updated")` | `update_share` | `(Address collaborator, u32 new_share)` | One collaborator's basis-point share changed. |
| `("royalty", "adms_set")` | `set_admins` | `(u32 admin_count, u32 threshold)` | Multi-sig admin list and signing threshold configured. |
| `("royalty", "admin_xfr")` | `admin_transfer` | `(Address previous_admin, Address new_admin)` | Single-step admin transfer completed (non-multisig only). |
| `("royalty", "paused")` | `pause` | `Address admin` | Contract was paused by the current admin. |
| `("royalty", "unpaused")` | `unpause` | `Address admin` | Contract was unpaused by the current admin. |
| `("royalty", "adm_prop")` | `propose_admin_transfer` | `Address new_admin` | First step of the two-step admin transfer — nominates a pending admin. |
| `("royalty", "adm_acc")` | `accept_admin` | `(Address previous_admin, Address new_admin)` | Second step — the pending admin accepted and is now current admin. |
| `("royalty", "withdraw")` | `withdraw` | `(Address token, i128 amount)` | Admin recovered stuck token balance to their own address. |

## Distribution events

| Topic | Emitted by | Payload | Description |
|---|---|---|---|
| `("royalty", "dist")` | `distribute`, `distribute_with_override`, `batch_distribute`, `distribute_resilient` | `(Address recipient, i128 amount, Address token, Symbol distribution_type)` | One event **per recipient** per token payout. `distribution_type` is `"primary"` for `distribute`/`distribute_with_override`/`distribute_resilient`, `"batch"` for `batch_distribute`. Only emitted for *successful* transfers when the caller is `distribute_resilient`. |
| `("royalty", "dist_all")` | `distribute_with_override` (and via it, `distribute`), `batch_distribute`, `distribute_resilient` | `(Address token, i128 total_amount)` | One event **per token** summarizing the total amount distributed. For `distribute_resilient` this is the amount actually transferred (may be less than the full balance if any recipient's transfer failed), and it is only emitted if at least one transfer succeeded. |
| `("royalty", "batch")` | `batch_distribute` | `u32 token_count` | Fired once per `batch_distribute` call, after all per-token distributions complete. |
| `("royalty", "sec_pay")` | `distribute_secondary_royalties` | `(Address recipient, i128 amount, Address token, Symbol "secondary")` | One event **per recipient** for a secondary royalty pool payout. |
| `("royalty", "sec_dist")` | `distribute_secondary_royalties` | `(Address token, i128 pool_amount)` | Fired once per call, summarizing the total secondary pool amount distributed. |
| `("royalty", "dist_strt")` | `distribute_resilient` | `(Address token, i128 total_amount, u32 recipient_count)` | Fired once, before any transfer is attempted. |
| `("royalty", "dist_fail")` | `distribute_resilient` | `(Address token, Vec<Address> failed_recipients)` | Fired once, only if at least one recipient's transfer failed — lists every recipient whose transfer did not succeed. |

### Why both a per-recipient and a summary event?

The per-recipient event (`dist` / `sec_pay`) is self-contained: an indexer
can build a full payout ledger from that topic alone, without needing to
correlate it with anything else in the same transaction. The summary event
(`dist_all` / `sec_dist` / `batch`) is cheaper to consume when a caller only
needs the aggregate (e.g. "how much did this contract distribute of token X
this month") and would otherwise have to sum every per-recipient event.

## Diagnostic events

| Topic | Emitted by | Payload | Description |
|---|---|---|---|
| `("auth_req",)` | Every admin-gated or payer-gated call, before `require_auth()` | `String` | Human-readable context (e.g. `"pause: admin authorization required"`) describing which authorization is about to be checked. Emitted even when the subsequent `require_auth()` fails, so failed-simulation tooling can surface *why* a call would be rejected. Not part of the stable public schema above — treat as best-effort debugging context, not something to build indexer logic on. |

## Adding a new event

- Reuse an existing `namespace` symbol (`royalty`, `default`, `share`) unless
  the event genuinely belongs to a new concern.
- Keep the payload a fixed-shape tuple — don't vary the number or order of
  fields for the same topic.
- Never add secrets, raw transaction XDR, or user data beyond what's already
  public on-chain (addresses, amounts, counts, symbols).
- Add a row to the appropriate table above and a test asserting the exact
  topic and payload shape (see `tests/integration_test.rs`, search for
  `Issue #661`).
