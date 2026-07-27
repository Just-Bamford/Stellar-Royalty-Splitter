import { Router } from "express";
import { z } from "zod";
import logger from "../logger.js";
import { validate } from "../validation.js";
import { sendError } from "../error-response.js";
import {
  isAdminRotateTokenValid,
  reloadSigningKeyFromSecretsFile,
  reloadSigningKeyFromSecretsProvider,
  rotateSigningKey,
  getSigningKeyStatus,
} from "../signing-key.js";
import { requireAdminBearerOrRole, createUser } from "../middleware/rbac.js";
import { addAuditLog } from "../database/index.js";

export const adminRouter = Router();

const rotateKeySchema = z
  .object({
    secretKey: z
      .string()
      .regex(/^S[A-Z2-7]{55}$/, "Invalid Stellar secret key")
      .optional(),
    reloadFromFile: z.boolean().optional(),
  })
  .refine((body) => Boolean(body.secretKey) || body.reloadFromFile === true, {
    message: "Provide secretKey or set reloadFromFile to true",
  });

/**
 * Legacy bearer-token guard kept for backward compatibility.
 * New deployments should prefer RBAC API keys (requireAdminBearerOrRole).
 */
function requireAdminRotateToken(req, res, next) {
  if (!process.env.ADMIN_ROTATE_TOKEN) {
    logger.warn("Admin rotate-key rejected: ADMIN_ROTATE_TOKEN not configured", {
      event: "signing_key_rotate_denied",
      reason: "token_not_configured",
    });
    return sendError(res, 503, "service_unavailable", "Key rotation is not configured on this server");
  }

  const header = req.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (!isAdminRotateTokenValid(token)) {
    logger.warn("Admin rotate-key rejected: invalid token", {
      event: "signing_key_rotate_denied",
      reason: "invalid_token",
    });
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }

  next();
}

/**
 * GET /admin/key-status
 * Returns current signing key status (public key, last rotation, provider).
 * Requires admin privilege.
 */
adminRouter.get(
  "/key-status",
  requireAdminBearerOrRole("admin"),
  (_req, res) => {
    res.json(getSigningKeyStatus());
  },
);

/**
 * POST /admin/rotate-key
 * Body: { secretKey?: string, reloadFromFile?: boolean, reloadFromProvider?: boolean }
 * Header: Authorization: Bearer <ADMIN_ROTATE_TOKEN>  (legacy) or x-api-key (RBAC)
 */
const rotateKeySchemaExtended = z
  .object({
    secretKey: z
      .string()
      .regex(/^S[A-Z2-7]{55}$/, "Invalid Stellar secret key")
      .optional(),
    reloadFromFile: z.boolean().optional(),
    reloadFromProvider: z.boolean().optional(),
  })
  .refine(
    (body) =>
      Boolean(body.secretKey) ||
      body.reloadFromFile === true ||
      body.reloadFromProvider === true,
    { message: "Provide secretKey, reloadFromFile, or reloadFromProvider" },
  );

adminRouter.post(
  "/rotate-key",
  requireAdminRotateToken,
  validate(rotateKeySchemaExtended),
  async (req, res, next) => {
    try {
      let result;
      if (req.body.reloadFromProvider) {
        result = await reloadSigningKeyFromSecretsProvider();
      } else if (req.body.reloadFromFile) {
        result = reloadSigningKeyFromSecretsFile();
      } else {
        result = rotateSigningKey(req.body.secretKey, { source: "api" });
      }

      // Audit trail — contractId omitted for global admin actions
      try {
        addAuditLog("__global__", "signing_key_rotated", null, {
          source: result.source,
          publicKey: result.publicKey,
        });
      } catch (_) { /* non-fatal */ }

      res.json({
        publicKey: result.publicKey,
        rotatedAt: result.rotatedAt,
        source: result.source,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /admin/users
 * Create a user with a role. Requires admin privilege (bearer token or RBAC).
 * Body: { walletAddress, role }
 * Returns: { userId }
 */
const createUserSchema = z.object({
  walletAddress: z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address"),
  role: z.enum(["viewer", "collaborator", "operator", "admin"]),
});

adminRouter.post(
  "/users",
  requireAdminBearerOrRole("admin"),
  validate(createUserSchema),
  (req, res, next) => {
    try {
      const userId = createUser(req.body.walletAddress, req.body.role);
      logger.info("Admin: created user", { userId, role: req.body.role });
      res.status(201).json({ userId });
    } catch (err) {
      next(err);
    }
  },
);
