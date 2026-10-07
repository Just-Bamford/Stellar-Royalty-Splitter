/** Central RBAC vocabulary and SQLite persistence helpers. */
import { db } from "../database/core.js";

export const PERMISSIONS = Object.freeze({
  SETTINGS_READ: "settings:read", SETTINGS_UPDATE: "settings:update",
  COLLABORATORS_READ: "collaborators:read", COLLABORATORS_MANAGE: "collaborators:manage",
  FINANCIALS_READ: "financials:read", FINANCIALS_EXPORT: "financials:export",
  DISPUTES_READ: "disputes:read", DISPUTES_APPROVE: "disputes:approve",
  REPORTS_READ: "reports:read", REPORTS_EXPORT: "reports:export",
  PERMISSIONS_READ: "permissions:read", PERMISSIONS_MANAGE: "permissions:manage",
  AUDIT_READ: "audit:read",
});

export const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));
export const ROLE_PERMISSIONS = Object.freeze({
  admin: ALL_PERMISSIONS,
  editor: [PERMISSIONS.SETTINGS_READ, PERMISSIONS.SETTINGS_UPDATE, PERMISSIONS.COLLABORATORS_READ, PERMISSIONS.COLLABORATORS_MANAGE, PERMISSIONS.DISPUTES_READ, PERMISSIONS.REPORTS_READ],
  accountant: [PERMISSIONS.FINANCIALS_READ, PERMISSIONS.FINANCIALS_EXPORT, PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT],
  viewer: [PERMISSIONS.SETTINGS_READ, PERMISSIONS.COLLABORATORS_READ, PERMISSIONS.DISPUTES_READ, PERMISSIONS.REPORTS_READ],
  approver: [PERMISSIONS.DISPUTES_READ, PERMISSIONS.DISPUTES_APPROVE],
});
export const ROLES = Object.freeze(Object.keys(ROLE_PERMISSIONS));

// Existing rows continue to work without a broad migration of the users table.
const LEGACY_ROLE_MAP = Object.freeze({ collaborator: "editor", operator: "approver" });
export function normalizeRole(role) {
  if (typeof role !== "string") return null;
  const normalized = LEGACY_ROLE_MAP[role] ?? role;
  return ROLES.includes(normalized) ? normalized : null;
}
export function isKnownPermission(permission) { return ALL_PERMISSIONS.includes(permission); }
export function isValidExpiration(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now;
}

export function getActiveRoles(userId, legacyRole = null) {
  if (!Number.isInteger(Number(userId))) return [];
  const assigned = db.prepare("SELECT role FROM user_roles WHERE userId = ?").all(userId)
    .map(({ role }) => normalizeRole(role)).filter(Boolean);
  const legacy = normalizeRole(legacyRole);
  return [...new Set(legacy ? [...assigned, legacy] : assigned)];
}

export function getEffectivePermissions(user) {
  if (!user?.id) return new Set();
  const roles = getActiveRoles(user.id, user.role);
  const temporary = db.prepare(
    "SELECT permission FROM temporary_permissions WHERE userId = ? AND revokedAt IS NULL AND datetime(expiresAt) > CURRENT_TIMESTAMP"
  ).all(user.id);
  return resolveEffectivePermissions(roles, temporary);
}

export function resolveEffectivePermissions(roles, temporaryPermissions = [], now = Date.now()) {
  const result = new Set();
  for (const role of Array.isArray(roles) ? roles : []) {
    const normalized = normalizeRole(role);
    if (normalized) for (const permission of ROLE_PERMISSIONS[normalized]) result.add(permission);
  }
  for (const grant of Array.isArray(temporaryPermissions) ? temporaryPermissions : []) {
    if (isKnownPermission(grant?.permission) && !grant?.revokedAt && Date.parse(grant.expiresAt) > now) result.add(grant.permission);
  }
  return result;
}

export function hasPermission(user, permission) {
  return isKnownPermission(permission) && getEffectivePermissions(user).has(permission);
}

/** Records expiry once without making authorization depend on this cleanup. */
export function expireTemporaryPermissions() {
  const expired = db.prepare("SELECT id, userId, permission, expiresAt FROM temporary_permissions WHERE revokedAt IS NULL AND datetime(expiresAt) <= CURRENT_TIMESTAMP").all();
  const revoke = db.prepare("UPDATE temporary_permissions SET revokedAt = CURRENT_TIMESTAMP WHERE id = ? AND revokedAt IS NULL");
  for (const grant of expired) {
    if (!revoke.run(grant.id).changes) continue;
    auditPermissionChange({ affectedUserId: grant.userId, action: "temporary_permission_expired", previousState: { permission: grant.permission }, newState: null, expiresAt: grant.expiresAt });
  }
  return expired.length;
}

export function auditPermissionChange({ actorUserId, affectedUserId, action, previousState = null, newState = null, expiresAt = null, revertedAuditId = null, requestId = null }) {
  return db.prepare(`INSERT INTO rbac_audit_events
    (actorUserId, affectedUserId, action, previousState, newState, expiresAt, revertedAuditId, requestId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(actorUserId, affectedUserId, action, JSON.stringify(previousState), JSON.stringify(newState), expiresAt, revertedAuditId, requestId).lastInsertRowid;
}

export function getRbacUsers() {
  return db.prepare("SELECT id, walletAddress, role, active, createdAt FROM users WHERE active = 1 ORDER BY id").all()
    .map((user) => ({ ...user, roles: getActiveRoles(user.id, user.role), permissions: [...getEffectivePermissions(user)] }));
}
