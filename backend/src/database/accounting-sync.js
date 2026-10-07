/**
 * Accounting sync tracking — closes #940.
 *
 * Persists QuickBooks OAuth connection state, distribution sync runs, and
 * per-entity sync status (invoices / journal entries) so accounting teams can
 * see exactly which distributions reached QuickBooks and which have been paid.
 *
 * Tables:
 *   quickbooks_connection    — single active OAuth connection (latest realm)
 *   quickbooks_oauth_state   — one-time CSRF state tokens for OAuth flow
 *   accounting_syncs         — a sync run (e.g. "synced all distributions")
 *   accounting_sync_items    — one row per QuickBooks entity created
 */

import { db, countWrite } from "./core.js";

// ─── Schema ────────────────────────────────────────────────────────────────────

/**
 * Initialize the accounting sync tables.
 * Call at startup (idempotent); honours DATABASE_PATH used by core.js.
 */
export function ensureAccountingSyncTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quickbooks_connection (
      id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id = 1),
      realm_id TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at DATETIME,
      status TEXT NOT NULL DEFAULT 'disconnected'
        CHECK(status IN ('connected', 'disconnected', 'error')),
      error_message TEXT,
      connected_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quickbooks_oauth_state (
      state TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      redeemed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS accounting_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      realm_id TEXT,
      sync_type TEXT NOT NULL DEFAULT 'distributions'
        CHECK(sync_type IN ('distributions', 'payments')),
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK(status IN ('pending', 'in_progress', 'completed', 'failed', 'partial')),
      total_items INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      summary TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounting_sync_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id INTEGER NOT NULL,
      transaction_id INTEGER,
      kind TEXT NOT NULL CHECK(kind IN ('invoice', 'journal_entry')),
      recipient TEXT,
      amount TEXT,
      quickbooks_id TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK(status IN ('in_progress', 'synced', 'confirmed', 'failed')),
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sync_id) REFERENCES accounting_syncs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_accounting_sync_items_sync_id
      ON accounting_sync_items(sync_id);
    CREATE INDEX IF NOT EXISTS idx_accounting_sync_items_transaction_id
      ON accounting_sync_items(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_accounting_sync_items_quickbooks_id
      ON accounting_sync_items(quickbooks_id);
    CREATE INDEX IF NOT EXISTS idx_accounting_sync_items_status
      ON accounting_sync_items(status);
    CREATE INDEX IF NOT EXISTS idx_accounting_syncs_status
      ON accounting_syncs(status);
  `);
}

let tablesEnsured = false;
function ensureTables() {
  if (!tablesEnsured) {
    ensureAccountingSyncTables();
    tablesEnsured = true;
  }
}

// ─── QuickBooks connection ─────────────────────────────────────────────────────

/**
 * Save (upsert) the single active QuickBooks OAuth connection.
 * @param {{ realmId: string|undefined, accessToken, refreshToken, expiresAt, status }} connection
 */
export function saveQuickBooksConnection(connection) {
  ensureTables();
  const existing = db.prepare("SELECT id FROM quickbooks_connection ORDER BY id LIMIT 1").get();
  if (existing) {
    db.prepare(
      `UPDATE quickbooks_connection SET
         realm_id = COALESCE(?, realm_id),
         access_token = COALESCE(?, access_token),
         refresh_token = COALESCE(?, refresh_token),
         token_expires_at = COALESCE(?, token_expires_at),
         status = COALESCE(?, status),
         connected_at = COALESCE(
           CASE WHEN ? IS NOT NULL THEN ? END, connected_at
         ),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      connection.realmId ?? null,
      connection.accessToken ?? null,
      connection.refreshToken ?? null,
      connection.expiresAt ?? null,
      connection.status ?? null,
      connection.connectedAt ?? null,
      connection.connectedAt ?? null,
      existing.id
    );
    countWrite();
    return getQuickBooksConnection();
  }

  const result = db
    .prepare(
      `INSERT INTO quickbooks_connection
         (realm_id, access_token, refresh_token, token_expires_at, status, connected_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      connection.realmId ?? null,
      connection.accessToken ?? null,
      connection.refreshToken ?? null,
      connection.expiresAt ?? null,
      connection.status ?? "connected",
      connection.connectedAt ?? new Date().toISOString()
    );
  countWrite();
  return { id: result.lastInsertRowid, ...connection };
}

/**
 * Return the active QuickBooks connection (no tokens), or null.
 */
export function getQuickBooksConnection() {
  ensureTables();
  const row = db
    .prepare(
      `SELECT id, realm_id, token_expires_at, status, connected_at, updated_at
       FROM quickbooks_connection ORDER BY id LIMIT 1`
    )
    .get();
  return row ?? null;
}

/**
 * Return the connection including OAuth tokens (service-internal use only).
 */
export function getQuickBooksTokens() {
  ensureTables();
  const row = db
    .prepare(
      `SELECT id, realm_id, access_token, refresh_token, token_expires_at, status
       FROM quickbooks_connection ORDER BY id LIMIT 1`
    )
    .get();
  return row ?? null;
}

/**
 * Update the access token of the stored connection (post-refresh).
 */
export function updateQuickBooksAccessToken(accessToken, expiresAt) {
  ensureTables();
  const result = db
    .prepare(
      `UPDATE quickbooks_connection
       SET access_token = ?, token_expires_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`
    )
    .run(accessToken, expiresAt ?? null);
  if (result.changes > 0) countWrite();
  return result.changes > 0;
}

/**
 * Mark the connection status (connected / disconnected / error).
 */
export function setQuickBooksConnectionStatus(status, errorMessage = null) {
  ensureTables();
  const result = db
    .prepare(
      `UPDATE quickbooks_connection SET
         status = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`
    )
    .run(status ?? "disconnected");
  if (errorMessage) {
    db.prepare(
      `UPDATE quickbooks_connection SET error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`
    ).run(errorMessage);
  }
  if (result.changes > 0) countWrite();
  return result.changes > 0;
}

// ─── OAuth state ───────────────────────────────────────────────────────────────

/**
 * Persist a CSRF state token for the OAuth authorize step.
 */
export function createQuickBooksOAuthState(state) {
  ensureTables();
  db.prepare("INSERT INTO quickbooks_oauth_state (state) VALUES (?)").run(state);
  countWrite();
  return state;
}

/**
 * Atomically consume a CSRF state token. Returns true only the first time a
 * valid, unexpired state is redeemed.
 */
export function redeemQuickBooksOAuthState(state) {
  ensureTables();
  const row = db
    .prepare(
      `SELECT state FROM quickbooks_oauth_state
       WHERE state = ? AND redeemed = 0 AND created_at > datetime('now', '-15 minutes')`
    )
    .get(state);
  if (!row) return false;
  db.prepare("UPDATE quickbooks_oauth_state SET redeemed = 1 WHERE state = ?").run(state);
  countWrite();
  return true;
}

// ─── Sync runs ─────────────────────────────────────────────────────────────────

/**
 * Create a sync run record.
 * @param {{ realmId: string|null, syncType: string, totalItems: number }} params
 */
export function createAccountingSync({ realmId = null, syncType = "distributions", totalItems = 0 }) {
  ensureTables();
  const result = db
    .prepare(
      `INSERT INTO accounting_syncs (realm_id, sync_type, status, total_items)
       VALUES (?, ?, 'in_progress', ?)`
    )
    .run(realmId, syncType, totalItems);
  countWrite();
  return db
    .prepare("SELECT * FROM accounting_syncs WHERE id = ?")
    .get(result.lastInsertRowid);
}

/**
 * Update a sync run's counters / status.
 */
export function updateAccountingSyncStatus({
  syncId,
  status,
  successCount,
  failureCount,
  errorMessage = null,
  summary = null,
}) {
  ensureTables();
  const result = db
    .prepare(
      `UPDATE accounting_syncs SET
         status = ?,
         success_count = ?,
         failure_count = ?,
         error_message = COALESCE(?, error_message),
         summary = COALESCE(?, summary),
         completed_at = CASE WHEN ? = 'completed' OR ? = 'failed' OR ? = 'partial'
           THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE completed_at END
       WHERE id = ?`
    )
    .run(
      status ?? "in_progress",
      successCount ?? 0,
      failureCount ?? 0,
      errorMessage,
      summary ? JSON.stringify(summary) : null,
      status ?? "",
      status ?? "",
      status ?? "",
      syncId
    );
  if (result.changes > 0) countWrite();
  return getAccountingSync(syncId);
}

/**
 * Fetch a single sync run with its item count.
 */
export function getAccountingSync(syncId) {
  ensureTables();
  const row = db
    .prepare(
      `SELECT s.*,
         (SELECT COUNT(*) FROM accounting_sync_items si WHERE si.sync_id = s.id) AS item_count
       FROM accounting_syncs s WHERE s.id = ?`
    )
    .get(syncId);
  return row ?? null;
}

/**
 * Most recent sync runs, newest first.
 */
export function getRecentAccountingSyncs(limit = 10) {
  ensureTables();
  return db
    .prepare(
      `SELECT s.*,
         (SELECT COUNT(*) FROM accounting_sync_items si WHERE si.sync_id = s.id) AS item_count
       FROM accounting_syncs s
       ORDER BY s.id DESC
       LIMIT ?`
    )
    .all(limit);
}

/**
 * Latest sync run of a given type (null if none).
 */
export function getLatestAccountingSync(syncType = "distributions") {
  ensureTables();
  return (
    db
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM accounting_sync_items si WHERE si.sync_id = s.id) AS item_count
         FROM accounting_syncs s
         WHERE s.sync_type = ?
         ORDER BY s.id DESC
         LIMIT 1`
      )
      .get(syncType) ?? null
  );
}

// ─── Distribution discovery ────────────────────────────────────────────────────

/**
 * List distribution transactions that have not yet been synced to QuickBooks,
 * newest first. Every distribution has >= 1 payout row; a distribution is
 * considered unsynced when no accounting_sync_items row references it.
 *
 * @param {number} limit
 */
export function getUnsyncedDistributionTransactions(limit = 500) {
  ensureTables();
  return db
    .prepare(
      `SELECT t.id, t.contractId, t.type, t.initiatorAddress, t.requestedAmount,
              t.timestamp, t.status,
              COUNT(dp.id) AS payoutCount,
              SUM(CAST(dp.amountReceived AS REAL)) AS totalPayout
       FROM transactions t
       JOIN distribution_payouts dp ON dp.transactionId = t.id
       WHERE t.type = 'distribute'
         AND NOT EXISTS (
           SELECT 1 FROM accounting_sync_items si
           WHERE si.transaction_id = t.id
         )
       GROUP BY t.id
       ORDER BY t.timestamp ASC
       LIMIT ?`
    )
    .all(limit);
}

/**
 * Fetch individual payout rows for a distribution transaction.
 */
export function getDistributionPayouts(transactionId) {
  ensureTables();
  return db
    .prepare(
      `SELECT collaboratorAddress, amountReceived
       FROM distribution_payouts
       WHERE transactionId = ?
       ORDER BY id ASC`
    )
    .all(transactionId);
}

/**
 * Fetch a single distribute transaction by id together with its payout count
 * and total payout (used when a sync is restricted to explicit ids).
 */
export function getDistributionTransactionById(transactionId) {
  ensureTables();
  return (
    db
      .prepare(
        `SELECT t.id, t.contractId, t.type, t.initiatorAddress, t.requestedAmount,
                t.timestamp, t.status,
                COUNT(dp.id) AS payoutCount,
                SUM(CAST(dp.amountReceived AS REAL)) AS totalPayout
         FROM transactions t
         JOIN distribution_payouts dp ON dp.transactionId = t.id
         WHERE t.type = 'distribute' AND t.id = ?
         GROUP BY t.id
         LIMIT 1`
      )
      .get(transactionId) ?? null
  );
}

// ─── Sync items ────────────────────────────────────────────────────────────────

/**
 * Add a per-entity sync item.
 * @param {{ syncId: number, transactionId: number|null, kind: string, recipient: string|null,
 *           amount: string|null, quickBooksId: string|null, status: string, detail: string|null }} params
 */
export function addAccountingSyncItem({
  syncId,
  transactionId,
  kind,
  recipient = null,
  amount = null,
  quickBooksId = null,
  status = "in_progress",
  detail = null,
}) {
  ensureTables();
  const result = db
    .prepare(
      `INSERT INTO accounting_sync_items
         (sync_id, transaction_id, kind, recipient, amount, quickbooks_id, status, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(syncId, transactionId, kind, recipient, amount, quickBooksId, status, detail);
  countWrite();
  return getAccountingSyncItem(result.lastInsertRowid);
}

export function getAccountingSyncItem(itemId) {
  ensureTables();
  return db.prepare("SELECT * FROM accounting_sync_items WHERE id = ?").get(itemId) ?? null;
}

/**
 * All items created during a sync run.
 */
export function getAccountingSyncItems(syncId) {
  ensureTables();
  return db
    .prepare("SELECT * FROM accounting_sync_items WHERE sync_id = ? ORDER BY id ASC")
    .all(syncId);
}

/**
 * Look up a sync item by its QuickBooks generated id.
 */
export function findAccountingSyncItemByQuickBooksId(quickBooksId, kind = "invoice") {
  ensureTables();
  return (
    db
      .prepare(
        `SELECT * FROM accounting_sync_items
         WHERE quickbooks_id = ? AND kind = ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(String(quickBooksId), kind) ?? null
  );
}

/**
 * Mark a sync item as successfully created in QuickBooks.
 */
export function markAccountingSyncItemSynced(itemId, quickBooksId) {
  ensureTables();
  const result = db
    .prepare(
      `UPDATE accounting_sync_items
       SET status = 'synced', quickbooks_id = COALESCE(?, quickbooks_id)
       WHERE id = ?`
    )
    .run(quickBooksId ? String(quickBooksId) : null, itemId);
  if (result.changes > 0) countWrite();
  return getAccountingSyncItem(itemId);
}

/**
 * Mark a sync item failed.
 */
export function markAccountingSyncItemFailed(itemId, detail) {
  ensureTables();
  const result = db
    .prepare(
      `UPDATE accounting_sync_items
       SET status = 'failed', detail = COALESCE(?, detail)
       WHERE id = ?`
    )
    .run(detail ? String(detail) : null, itemId);
  if (result.changes > 0) countWrite();
  return getAccountingSyncItem(itemId);
}

/**
 * Mark an invoice sync item confirmed (QuickBooks webhook reported payment).
 */
export function markAccountingSyncItemConfirmed(quickBooksId) {
  ensureTables();
  const item = findAccountingSyncItemByQuickBooksId(quickBooksId);
  if (!item) return null;
  const result = db
    .prepare(
      `UPDATE accounting_sync_items
       SET status = 'confirmed', detail = COALESCE(detail, 'Invoice paid (QuickBooks webhook)')
       WHERE id = ?`
    )
    .run(item.id);
  if (result.changes > 0) countWrite();
  return getAccountingSyncItem(item.id);
}