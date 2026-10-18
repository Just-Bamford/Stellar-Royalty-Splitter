import { timingSafeEqual } from "crypto";
import { sendError } from "../error-response.js";
import { expireTemporaryPermissions, getEffectivePermissions, hasPermission, isKnownPermission } from "../models/rbac.js";

function hasLegacyAdminToken(req) {
  const authorization = typeof req.get === "function" ? req.get("Authorization") : req.headers?.authorization;
  const token = authorization?.replace(/^Bearer\s+/i, "");
  const expected = process.env.ADMIN_ROTATE_TOKEN;
  if (!token || !expected) return false;
  const a = Buffer.from(token); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function attachRbacIdentity(req, _res, next) {
  expireTemporaryPermissions();
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return next();
  // The existing middleware has already validated the key and set req.user when available.
  if (!req.user) return next();
  req.permissions = getEffectivePermissions(req.user);
  next();
}

export function requirePermission(required, { any = false } = {}) {
  const permissions = Array.isArray(required) ? required : [required];
  if (!permissions.length || permissions.some((permission) => !isKnownPermission(permission))) {
    throw new Error("Unknown RBAC permission");
  }
  return (req, res, next) => {
    if (hasLegacyAdminToken(req)) return next();
    if (!req.user) return sendError(res, 401, "unauthorized", "Authentication required");
    const allowed = any
      ? permissions.some((permission) => hasPermission(req.user, permission))
      : permissions.every((permission) => hasPermission(req.user, permission));
    if (!allowed) return sendError(res, 403, "forbidden", "Insufficient permissions");
    return next();
  };
}

export function requireAnyPermission(permissions) { return requirePermission(permissions, { any: true }); }
