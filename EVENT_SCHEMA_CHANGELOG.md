# Event Schema Changelog

This document tracks changes to contract event schemas to help off-chain processors handle version upgrades gracefully.

## Version 1 (Contract v0.2.0+)

### Overview
Starting with contract version 0.2.0, all events include versioning and ordering information to ensure compatibility across contract upgrades.

### Event Format Changes

#### All Events
- **Added**: `event_version` (u32) - Version identifier for the event schema
- **Added**: `ledger_sequence` (u32) - Ledger sequence number for event ordering

#### Event Topics and Data

##### `royalty.init`
- **Before**: `(collaborators, shares)`
- **After**: `(event_version, ledger_sequence, collaborators, shares)`
- **Emit timing**: Before state changes for atomicity

##### `royalty.rate_set`
- **Before**: `new_rate`
- **After**: `(event_version, ledger_sequence, new_rate)`
- **Emit timing**: After state changes

##### `royalty.admin_xfr`
- **Before**: `(previous_admin, new_admin)`
- **After**: `(event_version, ledger_sequence, previous_admin, new_admin)`
- **Emit timing**: After state changes

##### `royalty.adm_prop`
- **Before**: `new_admin`
- **After**: `(event_version, ledger_sequence, new_admin)`
- **Emit timing**: After state changes

##### `royalty.adm_acc`
- **Before**: `(previous_admin, pending)`
- **After**: `(event_version, ledger_sequence, previous_admin, pending)`
- **Emit timing**: After state changes

##### `default.rcpt_set`
- **Before**: `recipients.len()`
- **After**: `(event_version, ledger_sequence, recipients.len())`
- **Emit timing**: After state changes

##### `royalty.recip_set`
- **Before**: `recipients.len()`
- **After**: `(event_version, ledger_sequence, recipients.len())`
- **Emit timing**: After state changes

##### `royalty.withdraw`
- **Before**: `(token, amount)`
- **After**: `(event_version, ledger_sequence, token, amount)`
- **Emit timing**: After state changes

##### `dist` (individual distribution)
- **Before**: `(addr, payout)`
- **After**: `(event_version, ledger_sequence, addr, payout)`
- **Emit timing**: After each transfer

##### `royalty.dist_all` (aggregate distribution)
- **Before**: `(token, amount)`
- **After**: `(event_version, ledger_sequence, token, amount)`
- **Emit timing**: After all transfers

##### `royalty.batch` (batch distribution)
- **Before**: `tokens.len()`
- **After**: `(event_version, ledger_sequence, tokens.len())`
- **Emit timing**: After all distributions

##### `sec_dist` (individual secondary distribution)
- **Before**: `(addr, payout)`
- **After**: `(event_version, ledger_sequence, addr, payout)`
- **Emit timing**: After each transfer

##### `royalty.sec_dist` (aggregate secondary distribution)
- **Before**: `(token, pool, dust)`
- **After**: `(event_version, ledger_sequence, token, pool, dust)`
- **Emit timing**: After all transfers
- **Note**: Dust field added in v0.2.0 for #398

##### `share.updated`
- **Before**: `(collaborator, new_share)`
- **After**: `(event_version, ledger_sequence, collaborator, new_share)`
- **Emit timing**: After state changes

##### `royalty.adms_set`
- **Before**: `(admins.len(), threshold)`
- **After**: `(event_version, ledger_sequence, admins.len(), threshold)`
- **Emit timing**: After state changes

##### `auth_req` (authorization request)
- **Format**: Unchanged (context string only)
- **Note**: Used internally for authorization, not versioned

### Migration Guide for Off-chain Processors

#### Detecting Event Version
Events emitted by contracts with version < 0.2.0 will not have the versioning fields. To detect the version:

1. Check the contract version using `get_version()`
2. If version >= "0.2.0", expect versioned events
3. If version < "0.2.0", use legacy event parsing

#### Event Ordering
Use the `ledger_sequence` field to order events across multiple transactions. Events with lower sequence numbers occurred earlier.

#### Backward Compatibility
- Legacy events (pre-0.2.0) can still be parsed by ignoring the first two tuple elements if present
- Versioned events can be detected by checking if the first element is a u32 (event_version)

### Constants
- `EVENT_VERSION`: Current event version (1)
- `MAX_DUST`: Maximum dust allowed (100 stroops = 1 basis point)

### Related Issues
- #405: Add Event Versioning & Ordering Guarantees
- #398: Fix Secondary Royalty Pool Dust Handling
