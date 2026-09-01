/**
 * Role-Based Access Control middleware (#572).
 *
 * Roles (lowest → highest): viewer, collaborator, operator, admin
 *
 * API keys are stored hashed in the `api_keys` table and linked to a user
 * with an assigned role. Pass the key via the `x-api-key` request header.
 *
 * Admin operations additionally accept the legacy ADMIN_ROTATE_TOKEN bearer
 * token so existing integrations are not broken.
 */
import { createHash, timingSafeEqual } from "crypto";
import { db } from "../database/core.js";
import { sendError } from "../error-response.js";
import logger from "../logger.js";

export const ROLES = ["viewer", "collaborator", "operator", "admin"];

function hashApiKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Resolve the role for an incoming request.
 * Checks `x-api-key` header against the api_keys table.
 * Returns null when no valid key is present.
 */
function resolveRole(req) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return null;

  const hashed = hashApiKey(String(apiKey));
  const row = db
    .prepare(
      `SELECT u.role FROM api_keys ak
       JOIN users u ON u.id = ak.userId
       WHERE ak.keyHash = ?
         AND (ak.expiresAt IS NULL OR ak.expiresAt > CURRENT_TIMESTAMP)
         AND u.active = 1`
    )
    .get(hashed);

  return row?.role ?? null;
}

/**
 * Attach req.role to every request (non-blocking — does not reject).
 */
export function attachRole(req, _res, next) {
  req.role = resolveRole(req) ?? "viewer";
  next();
}

/**
 * Express middleware that requires the caller to have at least `minRole`.
 *
 * Usage:
 *   router.post("/sensitive", requireRole("admin"), handler)
 */
export function requireRole(minRole) {
  const minIndex = ROLES.indexOf(minRole);
  if (minIndex === -1) throw new Error(`Unknown role: ${minRole}`);

  return (req, res, next) => {
    const roleIndex = ROLES.indexOf(req.role ?? "viewer");
    if (roleIndex >= minIndex) return next();

    logger.warn("RBAC: access denied", {
      path: req.originalUrl,
      requiredRole: minRole,
      callerRole: req.role,
      ip: req.ip,
    });
    return sendError(res, 403, "forbidden", "Insufficient permissions");
  };
}

/**
 * Hash a plaintext API key and store it with the given userId and role.
 * Returns the stored row id.
 */
export function createApiKey(plainKey, userId, expiresAt = null) {
  const hashed = hashApiKey(plainKey);
  const result = db
    .prepare(
      `INSERT INTO api_keys (keyHash, userId, expiresAt) VALUES (?, ?, ?)`
    )
    .run(hashed, userId, expiresAt);
  return result.lastInsertRowid;
}

/**
 * Create a user with the given walletAddress and role.
 * Returns the new user row id.
 */
export function createUser(walletAddress, role = "collaborator") {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  const result = db
    .prepare(
      `INSERT INTO users (walletAddress, role) VALUES (?, ?)`
    )
    .run(walletAddress, role);
  return result.lastInsertRowid;
}

/**
 * Constant-time comparison for admin bearer token (legacy support).
 */
export function requireAdminBearerOrRole(minRole = "admin") {
  return (req, res, next) => {
    // Try legacy bearer token first
    const header = req.get("Authorization");
    if (header?.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      const configured = process.env.ADMIN_ROTATE_TOKEN;
      if (configured) {
        try {
          const a = Buffer.from(token);
          const b = Buffer.from(configured);
          if (a.length === b.length && timingSafeEqual(a, b)) return next();
        } catch {
          // fall through to role check
        }
      }
    }

    // Fall back to RBAC role
    const roleIndex = ROLES.indexOf(req.role ?? "viewer");
    const minIndex = ROLES.indexOf(minRole);
    if (roleIndex >= minIndex) return next();

    logger.warn("Admin access denied", {
      path: req.originalUrl,
      ip: req.ip,
      callerRole: req.role,
    });
    return sendError(res, 401, "unauthorized", "Unauthorized");
  };
}
