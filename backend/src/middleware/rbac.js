import { dbGetUserRole } from "../database/roles.js";
import { getContractAdmin } from "../stellar.js";
import { sendError } from "../error-response.js";
import { verifyRequestSignatureMiddleware } from "../request-signing.js";

const ROLE_LEVELS = {
  viewer: 1,
  operator: 2,
  admin: 3
};

/**
 * Middleware wrapper to force request signature verification.
 */
export function requireRequestSignature(req, res, next) {
  const walletAddress = req.get("X-Wallet-Address");
  const signature = req.get("X-Signature");
  if (!walletAddress || !signature) {
    return sendError(
      res,
      401,
      "missing_signature",
      "Request signature headers are required for administrative actions: X-Wallet-Address, X-Timestamp, X-Nonce, X-Signature"
    );
  }
  return verifyRequestSignatureMiddleware(req, res, next);
}

/**
 * Middleware that checks if the caller has the required role.
 * @param {string} requiredRole - 'viewer', 'operator', or 'admin'
 */
export function requireRole(requiredRole) {
  return async (req, res, next) => {
    const caller = req.signedWalletAddress;
    if (!caller) {
      return sendError(res, 401, "unauthorized", "Caller identity not verified");
    }

    // Try to extract contractId from params, body, or query
    const contractId = req.params?.contractId || req.body?.contractId || req.query?.contractId || null;

    try {
      // 1. Check if there is an explicit role in DB
      let role = dbGetUserRole(contractId, caller);

      // 2. If no role in DB, check if caller is the on-chain admin
      if (!role && contractId) {
        try {
          const onChainAdmin = await getContractAdmin(contractId);
          if (onChainAdmin && onChainAdmin === caller) {
            role = "admin";
          }
        } catch (err) {
          // If contract read fails (e.g. invalid contractId or not initialized), ignore
        }
      }

      // 3. Verify role level
      const callerLevel = ROLE_LEVELS[role] || 0;
      const requiredLevel = ROLE_LEVELS[requiredRole] || 0;

      if (callerLevel < requiredLevel) {
        return sendError(
          res,
          403,
          "forbidden",
          `Access denied: required role ${requiredRole}, caller has role ${role || "none"}`
        );
      }

      req.userRole = role;
      next();
    } catch (err) {
      next(err);
    }
  };
}
