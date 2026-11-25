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

const _memoryUsers = new Map();
const _memoryApiKeys = new Map();
let _nextUserId = 1;

export function clearMemoryRbac() {
  _memoryUsers.clear();
  _memoryApiKeys.clear();
  _nextUserId = 1;
}

function hashApiKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Resolve the role for an incoming request.
 * Checks `x-api-key` header against the api_keys table.
 * Returns null when no valid key is present.
 */
export function resolveUser(req) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return null;

  const hashed = hashApiKey(String(apiKey));
  if (db.open) {
    try {
      const row = db
        .prepare(
          `SELECT u.id, u.walletAddress, u.role FROM api_keys ak
           JOIN users u ON u.id = ak.userId
           WHERE ak.keyHash = ?
             AND (ak.expiresAt IS NULL OR ak.expiresAt > CURRENT_TIMESTAMP)
             AND u.active = 1`
        )
        .get(hashed);

      if (row) return row;
    } catch {
      // Mocked DB fallback
    }
  }

  const keyEntry = _memoryApiKeys.get(hashed);
  if (keyEntry) {
    const user = _memoryUsers.get(keyEntry.userId);
    if (user && user.active === 1) {
      return { id: user.id, walletAddress: user.walletAddress, role: user.role };
    }
  }

  return null;
}

/**
 * Attach req.role to every request (non-blocking — does not reject).
 */
export function attachRole(req, _res, next) {
  req.user = req.user ?? resolveUser(req);
  req.role = req.role ?? (req.user?.role ?? "viewer");
  next();
}

/**
 * Express middleware that requires the caller to be authenticated (rejects with 401).
 */
export function requireAuth(req, res, next) {
  if (req.user) {
    req.role = req.role ?? req.user.role;
    return next();
  }

  // Legacy admin bearer token
  const authHeader = req.get ? req.get("Authorization") : req.headers?.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    const configured = process.env.ADMIN_ROTATE_TOKEN;
    if (configured) {
      try {
        const a = Buffer.from(token);
        const b = Buffer.from(configured);
        if (a.length === b.length && timingSafeEqual(a, b)) {
          req.role = "admin";
          req.user = { id: 0, walletAddress: "admin", role: "admin" };
          return next();
        }
      } catch {
        // fall through
      }
    }
  }

  const user = resolveUser(req);
  if (user) {
    req.user = user;
    req.role = user.role;
    return next();
  }

  return sendError(res, 401, "unauthorized", "Authentication required");
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
  let insertId;
  if (db.open) {
    try {
      const result = db
        .prepare(
          `INSERT INTO api_keys (keyHash, userId, expiresAt) VALUES (?, ?, ?)`
        )
        .run(hashed, userId, expiresAt);
      insertId = result?.lastInsertRowid;
    } catch {
      // Mocked DB fallback
    }
  }
  _memoryApiKeys.set(hashed, { keyHash: hashed, userId, expiresAt });
  return insertId || 1;
}

/**
 * Create a user with the given walletAddress and role.
 * Returns the new user row id.
 */
export function createUser(walletAddress, role = "collaborator") {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
  let insertId;
  if (db.open) {
    try {
      const existing = db.prepare(`SELECT id FROM users WHERE walletAddress = ?`).get(walletAddress);
      if (existing) {
        db.prepare(`UPDATE users SET role = ?, active = 1 WHERE id = ?`).run(role, existing.id);
        insertId = existing.id;
      } else {
        const result = db
          .prepare(
            `INSERT INTO users (walletAddress, role) VALUES (?, ?)`
          )
          .run(walletAddress, role);
        insertId = result?.lastInsertRowid;
      }
    } catch {
      // Mocked DB fallback
    }
  }

  for (const [id, u] of _memoryUsers.entries()) {
    if (u.walletAddress === walletAddress) {
      u.role = role;
      u.active = 1;
      return id;
    }
  }

  if (!insertId) {
    insertId = _nextUserId++;
  }
  _memoryUsers.set(insertId, { id: insertId, walletAddress, role, active: 1 });
  return insertId;
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
