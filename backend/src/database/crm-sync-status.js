/**
 * Persistence for the Salesforce CRM integration (#939).
 *
 * Four tables back the feature (created by the `initializeDatabase` migration
 * in `core.js`):
 *   crm_connections        — one OAuth connection per (contract, provider)
 *   crm_sync_status        — progress/reporting for the last sync run
 *   crm_contact_mappings   — collaborator wallet ⇄ Salesforce Contact id
 *   crm_activity_log       — audit trail of outbound/inbound CRM events
 *
 * OAuth tokens are stored encrypted (see `services/salesforce.js`) and are
 * never returned through the HTTP layer.
 */
import { db, countWrite } from "./core.js";

export const CRM_PROVIDER = "salesforce";
export const CRM_SYNC_STATES = ["idle", "running", "completed", "failed"];
export const CRM_ACTIVITY_STATES = ["success", "failed", "skipped"];
export const CRM_SYNC_DIRECTIONS = ["outbound", "inbound"];

function nowIso() {
  return new Date().toISOString();
}

// ── Connections ─────────────────────────────────────────────────────────────

export function getConnection(contractId, provider = CRM_PROVIDER) {
  return (
    db
      .prepare(
        `SELECT id, contractId, provider, instanceUrl, orgId, accessToken, refreshToken,
                accessTokenExpiresAt, connectedBy, status, createdAt, updatedAt
         FROM crm_connections
         WHERE contractId = ? AND provider = ?`
      )
      .get(contractId, provider) ?? null
  );
}

export function saveConnection({
  contractId,
  provider = CRM_PROVIDER,
  instanceUrl,
  orgId = null,
  accessToken = null,
  refreshToken = null,
  accessTokenExpiresAt = null,
  connectedBy = null,
}) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO crm_connections
       (contractId, provider, instanceUrl, orgId, accessToken, refreshToken,
        accessTokenExpiresAt, connectedBy, status, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
     ON CONFLICT(contractId, provider) DO UPDATE SET
       instanceUrl          = excluded.instanceUrl,
       orgId                = excluded.orgId,
       accessToken          = excluded.accessToken,
       refreshToken         = COALESCE(excluded.refreshToken, refreshToken),
       accessTokenExpiresAt = excluded.accessTokenExpiresAt,
       connectedBy          = excluded.connectedBy,
       status               = 'connected',
       updatedAt            = excluded.updatedAt`
  ).run(
    contractId,
    provider,
    instanceUrl,
    orgId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt,
    connectedBy,
    now
  );
  countWrite();
  return getConnection(contractId, provider);
}

export function updateConnectionTokens(
  contractId,
  { provider = CRM_PROVIDER, accessToken = null, refreshToken = null, accessTokenExpiresAt = null } = {}
) {
  const result = db
    .prepare(
      `UPDATE crm_connections
       SET accessToken = COALESCE(?, accessToken),
           refreshToken = COALESCE(?, refreshToken),
           accessTokenExpiresAt = COALESCE(?, accessTokenExpiresAt),
           status = 'connected',
           updatedAt = ?
       WHERE contractId = ? AND provider = ?`
    )
    .run(accessToken, refreshToken, accessTokenExpiresAt, nowIso(), contractId, provider);
  if (result.changes > 0) countWrite();
  return getConnection(contractId, provider);
}

export function disconnectConnection(contractId, provider = CRM_PROVIDER) {
  const result = db
    .prepare(
      `UPDATE crm_connections
       SET status = 'disconnected', accessToken = NULL, refreshToken = NULL,
           accessTokenExpiresAt = NULL, updatedAt = ?
       WHERE contractId = ? AND provider = ?`
    )
    .run(nowIso(), contractId, provider);
  if (result.changes > 0) countWrite();
  return result.changes > 0;
}

// ── Sync status ─────────────────────────────────────────────────────────────

export function getSyncStatus(contractId, provider = CRM_PROVIDER) {
  return (
    db
      .prepare(
        `SELECT id, contractId, provider, status, totalCollaborators, syncedCount,
                failedCount, lastSyncedAt, lastError, startedAt, completedAt, updatedAt
         FROM crm_sync_status
         WHERE contractId = ? AND provider = ?`
      )
      .get(contractId, provider) ?? null
  );
}

export function startSync(contractId, totalCollaborators, provider = CRM_PROVIDER) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO crm_sync_status
       (contractId, provider, status, totalCollaborators, syncedCount, failedCount,
        lastError, startedAt, completedAt, updatedAt)
     VALUES (?, ?, 'running', ?, 0, 0, NULL, ?, NULL, ?)
     ON CONFLICT(contractId, provider) DO UPDATE SET
       status             = 'running',
       totalCollaborators = excluded.totalCollaborators,
       syncedCount        = 0,
       failedCount        = 0,
       lastError          = NULL,
       startedAt          = excluded.startedAt,
       completedAt        = NULL,
       updatedAt          = excluded.updatedAt`
  ).run(contractId, provider, totalCollaborators, now, now);
  countWrite();
  return getSyncStatus(contractId, provider);
}

export function incrementSyncProgress(
  contractId,
  { synced = 0, failed = 0 } = {},
  provider = CRM_PROVIDER
) {
  db.prepare(
    `UPDATE crm_sync_status
     SET syncedCount = syncedCount + ?,
         failedCount = failedCount + ?,
         updatedAt = ?
     WHERE contractId = ? AND provider = ?`
  ).run(synced, failed, nowIso(), contractId, provider);
  countWrite();
  return getSyncStatus(contractId, provider);
}

export function finishSync(
  contractId,
  { status = "completed", error = null } = {},
  provider = CRM_PROVIDER
) {
  const now = nowIso();
  db.prepare(
    `UPDATE crm_sync_status
     SET status = ?,
         lastError = ?,
         lastSyncedAt = CASE WHEN ? = 'completed' THEN ? ELSE lastSyncedAt END,
         completedAt = ?,
         updatedAt = ?
     WHERE contractId = ? AND provider = ?`
  ).run(status, error, status, now, now, now, contractId, provider);
  countWrite();
  return getSyncStatus(contractId, provider);
}

// ── Contact mappings ────────────────────────────────────────────────────────

export function getContactMappingByAddress(contractId, address, provider = CRM_PROVIDER) {
  return (
    db
      .prepare(
        `SELECT id, contractId, provider, address, externalId, name, email, syncState,
                lastDirection, lastSyncedAt, createdAt, updatedAt
         FROM crm_contact_mappings
         WHERE contractId = ? AND provider = ? AND address = ?`
      )
      .get(contractId, provider, address) ?? null
  );
}

/** Contact ids are unique per Salesforce org, so no contract id is required. */
export function findContactMappingByExternalId(externalId, provider = CRM_PROVIDER) {
  return (
    db
      .prepare(
        `SELECT id, contractId, provider, address, externalId, name, email, syncState,
                lastDirection, lastSyncedAt, createdAt, updatedAt
         FROM crm_contact_mappings
         WHERE provider = ? AND externalId = ?`
      )
      .get(provider, externalId) ?? null
  );
}

export function listContactMappings(contractId, provider = CRM_PROVIDER) {
  return db
    .prepare(
      `SELECT id, contractId, provider, address, externalId, name, email, syncState,
              lastDirection, lastSyncedAt, createdAt, updatedAt
       FROM crm_contact_mappings
       WHERE contractId = ? AND provider = ?
       ORDER BY updatedAt DESC`
    )
    .all(contractId, provider);
}

export function upsertContactMapping({
  contractId,
  provider = CRM_PROVIDER,
  address,
  externalId,
  name = null,
  email = null,
  syncState = "synced",
  direction = "outbound",
}) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO crm_contact_mappings
       (contractId, provider, address, externalId, name, email, syncState, lastDirection, lastSyncedAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(contractId, provider, address) DO UPDATE SET
       externalId    = excluded.externalId,
       name          = COALESCE(excluded.name, name),
       email         = COALESCE(excluded.email, email),
       syncState     = excluded.syncState,
       lastDirection = excluded.lastDirection,
       lastSyncedAt  = excluded.lastSyncedAt,
       updatedAt     = excluded.updatedAt`
  ).run(contractId, provider, address, externalId, name, email, syncState, direction, now, now);
  countWrite();
  return getContactMappingByAddress(contractId, address, provider);
}

// ── Activity log ────────────────────────────────────────────────────────────

export function recordCrmActivity({
  contractId,
  provider = CRM_PROVIDER,
  address = null,
  activityType,
  externalId = null,
  payload = null,
  status = "success",
  error = null,
}) {
  const result = db
    .prepare(
      `INSERT INTO crm_activity_log
         (contractId, provider, address, activityType, externalId, payload, status, error, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      contractId,
      provider,
      address,
      activityType,
      externalId,
      payload === null ? null : JSON.stringify(payload),
      status,
      error,
      nowIso()
    );
  countWrite();
  return result.lastInsertRowid;
}

export function listCrmActivities(contractId, { provider = CRM_PROVIDER, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return db
    .prepare(
      `SELECT id, contractId, provider, address, activityType, externalId, payload, status, error, createdAt
       FROM crm_activity_log
       WHERE contractId = ? AND provider = ?
       ORDER BY createdAt DESC, id DESC
       LIMIT ?`
    )
    .all(contractId, provider, safeLimit);
}

// ── Collaborator discovery ──────────────────────────────────────────────────

/**
 * Aggregate every collaborator we know about for a contract: the union of the
 * suspension table and recorded payout recipients, with cumulative earnings
 * expressed in stroops. Used by `sync-collaborators` when the caller does not
 * supply an explicit list.
 *
 * Both source tables are read defensively — a fresh database that has never
 * recorded a payout or a suspension simply yields an empty list.
 */
export function listKnownCollaborators(contractId) {
  const collaborators = new Map();

  const ensure = (address) => {
    if (!collaborators.has(address)) {
      collaborators.set(address, { address, status: "active", earnings: 0n });
    }
    return collaborators.get(address);
  };

  try {
    const statuses = db
      .prepare(`SELECT address, status FROM contributor_status WHERE contractId = ?`)
      .all(contractId);
    for (const row of statuses) {
      if (!row?.address) continue;
      ensure(row.address).status = row.status || "active";
    }
  } catch {
    // contributor_status is optional for a contract that has never suspended anyone
  }

  try {
    const payouts = db
      .prepare(
        `SELECT collaboratorAddress AS address, amountReceived
         FROM distribution_payouts WHERE contractId = ?`
      )
      .all(contractId);
    for (const row of payouts) {
      if (!row?.address) continue;
      const entry = ensure(row.address);
      try {
        entry.earnings += BigInt(String(row.amountReceived ?? 0));
      } catch {
        // Non-numeric payout amounts are ignored rather than failing the sync
      }
    }
  } catch {
    // No payouts recorded yet
  }

  return [...collaborators.values()].map((entry) => ({
    address: entry.address,
    status: entry.status,
    earnings: entry.earnings.toString(),
  }));
}
