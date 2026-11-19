/**
 * Shared admin Bearer-token authentication middleware.
 *
 * Usage:
 *   import { requireAdminBearerToken } from "../middleware/admin-auth.js";
 *   router.post("/admin/something", requireAdminBearerToken, handler);
 *
 * The token is read from process.env.ADMIN_ROTATE_TOKEN and must be supplied
 * by callers as:  Authorization: Bearer <token>
 */

import { sendError } from "../error-response.js";

/**
 * Extract a Bearer token from the Authorization header.
 * Returns null when the header is absent or not in Bearer format.
 *
 * @param {import("express").Request} req
 * @returns {string|null}
 */
export function extractBearerToken(req) {
  const header = req.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

/**
 * Express middleware that rejects requests lacking a valid admin token.
 *
 * - 503 when ADMIN_ROTATE_TOKEN is not set in the environment (admin
 *   operations deliberately disabled / not yet configured).
 * - 401 when the token is missing or does not match ADMIN_ROTATE_TOKEN.
 *
 * @type {import("express").RequestHandler}
 */
export function requireAdminBearerToken(req, res, next) {
  const envToken = process.env.ADMIN_ROTATE_TOKEN;
  if (!envToken) {
    return sendError(res, 503, "service_unavailable", "Admin operations are not configured on this server");
  }
  const token = extractBearerToken(req);
  if (!token || token !== envToken) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  next();
}
