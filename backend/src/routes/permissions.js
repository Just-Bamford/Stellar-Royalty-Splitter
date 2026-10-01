import { Router } from "express";
import { z } from "zod";
import { db } from "../database/core.js";
import { validate } from "../validation.js";
import { sendError } from "../error-response.js";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, getActiveRoles, getEffectivePermissions, getRbacUsers, isValidExpiration, auditPermissionChange } from "../models/rbac.js";
import { requirePermission } from "../middleware/rbac-check.js";

export const permissionsRouter = Router();
const roleSchema = z.object({ role: z.enum(ROLES) });
const temporarySchema = z.object({ permission: z.enum(Object.values(PERMISSIONS)), expiresAt: z.string().refine((value) => isValidExpiration(value), "expiresAt must be a future UTC timestamp") });
permissionsRouter.use(requirePermission(PERMISSIONS.PERMISSIONS_READ));

function target(id, res) {
  const user = db.prepare("SELECT id, walletAddress, role, active FROM users WHERE id = ? AND active = 1").get(id);
  if (!user) { sendError(res, 404, "not_found", "User not found"); return null; }
  return user;
}
function requestId(req) { return req.get("x-request-id") ?? null; }
function assertManager(req, res) {
  if (req.user && req.user.id === Number(req.params.userId)) { sendError(res, 403, "forbidden", "Permission changes require another authorized administrator"); return false; }
  return true;
}

permissionsRouter.get("/matrix", (_req, res) => res.json({ roles: ROLES, permissions: PERMISSIONS, matrix: ROLE_PERMISSIONS }));
permissionsRouter.get("/users", (_req, res) => res.json({ users: getRbacUsers() }));
permissionsRouter.get("/users/:userId", (req, res) => { const user = target(Number(req.params.userId), res); if (user) res.json({ user: { ...user, roles: getActiveRoles(user.id, user.role), permissions: [...getEffectivePermissions(user)], temporaryPermissions: db.prepare("SELECT id, permission, grantedByUserId, grantedAt, expiresAt FROM temporary_permissions WHERE userId = ? AND revokedAt IS NULL ORDER BY expiresAt").all(user.id) } }); });

permissionsRouter.put("/users/:userId/roles", requirePermission(PERMISSIONS.PERMISSIONS_MANAGE), validate(roleSchema), (req, res) => {
  if (!assertManager(req, res)) return; const user = target(Number(req.params.userId), res); if (!user) return;
  const before = getActiveRoles(user.id, user.role); db.prepare("INSERT OR IGNORE INTO user_roles (userId, role, assignedByUserId) VALUES (?, ?, ?)").run(user.id, req.body.role, req.user?.id ?? null);
  const after = getActiveRoles(user.id, user.role); auditPermissionChange({ actorUserId: req.user?.id ?? null, affectedUserId: user.id, action: "role_assigned", previousState: { roles: before }, newState: { roles: after }, requestId: requestId(req) }); res.status(201).json({ roles: after });
});
permissionsRouter.delete("/users/:userId/roles/:role", requirePermission(PERMISSIONS.PERMISSIONS_MANAGE), (req, res) => {
  if (!assertManager(req, res) || !ROLES.includes(req.params.role)) return sendError(res, 400, "invalid_role", "Unknown role"); const user = target(Number(req.params.userId), res); if (!user) return;
  const before = getActiveRoles(user.id, user.role); db.prepare("DELETE FROM user_roles WHERE userId = ? AND role = ?").run(user.id, req.params.role); const after = getActiveRoles(user.id, user.role);
  auditPermissionChange({ actorUserId: req.user?.id ?? null, affectedUserId: user.id, action: "role_removed", previousState: { roles: before }, newState: { roles: after }, requestId: requestId(req) }); res.status(204).end();
});
permissionsRouter.post("/users/:userId/temporary-permissions", requirePermission(PERMISSIONS.PERMISSIONS_MANAGE), validate(temporarySchema), (req, res) => {
  if (!assertManager(req, res)) return; const user = target(Number(req.params.userId), res); if (!user) return;
  const expiresAt = new Date(req.body.expiresAt).toISOString(); const result = db.prepare("INSERT INTO temporary_permissions (userId, permission, grantedByUserId, expiresAt) VALUES (?, ?, ?, ?)").run(user.id, req.body.permission, req.user?.id ?? null, expiresAt);
  auditPermissionChange({ actorUserId: req.user?.id ?? null, affectedUserId: user.id, action: "temporary_permission_granted", previousState: null, newState: { temporaryPermissionId: Number(result.lastInsertRowid), permission: req.body.permission }, expiresAt, requestId: requestId(req) }); res.status(201).json({ id: Number(result.lastInsertRowid), permission: req.body.permission, expiresAt });
});
permissionsRouter.delete("/users/:userId/temporary-permissions/:permissionId", requirePermission(PERMISSIONS.PERMISSIONS_MANAGE), (req, res) => {
  if (!assertManager(req, res)) return; const user = target(Number(req.params.userId), res); if (!user) return; const grant = db.prepare("SELECT * FROM temporary_permissions WHERE id = ? AND userId = ? AND revokedAt IS NULL").get(req.params.permissionId, user.id); if (!grant) return sendError(res, 404, "not_found", "Temporary permission not found");
  db.prepare("UPDATE temporary_permissions SET revokedAt = CURRENT_TIMESTAMP, revokedByUserId = ? WHERE id = ?").run(req.user?.id ?? null, grant.id); auditPermissionChange({ actorUserId: req.user?.id ?? null, affectedUserId: user.id, action: "temporary_permission_revoked", previousState: { permission: grant.permission, expiresAt: grant.expiresAt }, newState: null, expiresAt: grant.expiresAt, requestId: requestId(req) }); res.status(204).end();
});
permissionsRouter.get("/audit", requirePermission(PERMISSIONS.AUDIT_READ), (_req, res) => res.json({ events: db.prepare("SELECT * FROM rbac_audit_events ORDER BY id DESC LIMIT 200").all() }));
permissionsRouter.post("/audit/:auditId/rollback", requirePermission(PERMISSIONS.PERMISSIONS_MANAGE), (req, res) => {
  const event = db.prepare("SELECT * FROM rbac_audit_events WHERE id = ?").get(req.params.auditId); if (!event) return sendError(res, 404, "not_found", "Audit event not found"); if (!req.user || event.affectedUserId === req.user.id) return sendError(res, 403, "forbidden", "Rollback is not permitted");
  const state = JSON.parse(event.previousState ?? "null"); if (event.action === "role_assigned") db.prepare("DELETE FROM user_roles WHERE userId = ? AND role = ?").run(event.affectedUserId, JSON.parse(event.newState).roles.find((role) => !(state?.roles ?? []).includes(role)));
  else if (event.action === "role_removed") for (const role of state?.roles ?? []) db.prepare("INSERT OR IGNORE INTO user_roles (userId, role, assignedByUserId) VALUES (?, ?, ?)").run(event.affectedUserId, role, req.user.id);
  else return sendError(res, 400, "not_rollbackable", "This audit event cannot be rolled back automatically");
  auditPermissionChange({ actorUserId: req.user.id, affectedUserId: event.affectedUserId, action: "permission_rollback", previousState: JSON.parse(event.newState ?? "null"), newState: state, revertedAuditId: event.id, requestId: requestId(req) }); res.json({ rolledBack: event.id });
});
