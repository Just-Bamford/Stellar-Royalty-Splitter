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
import { addAuditLog, listAlertRules, createAlertRule, updateAlertRule, deleteAlertRule } from "../database/index.js";

export const adminRouter = Router();

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
    return sendError(
      res,
      503,
      "service_unavailable",
      "Key rotation is not configured on this server"
    );
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
adminRouter.get("/key-status", requireAdminBearerOrRole("admin"), (_req, res) => {
  res.json(getSigningKeyStatus());
});

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
      Boolean(body.secretKey) || body.reloadFromFile === true || body.reloadFromProvider === true,
    { message: "Provide secretKey, reloadFromFile, or reloadFromProvider" }
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
      } catch (_) {
        /* non-fatal */
      }

      res.json({
        publicKey: result.publicKey,
        rotatedAt: result.rotatedAt,
        source: result.source,
      });
    } catch (err) {
      next(err);
    }
  }
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
  }
);

/**
 * GET /admin/roles/me
 * #658 ℒ Returns the resolved role for the current API key caller.
 * Unauthenticated requests resolve to "viewer".
 * Returns: { role: "viewer" | "collaborator" | "operator" | "admin" }
 */
adminRouter.get("/roles/me", (req, res) => {
  res.json({ role: req.role ?? "viewer" });
});

/**
 * GET /admin/roles
 * #658 ℒ Returns the full role hierarchy so the frontend can use it for
 * UI permission checks without hard-coding the order.
 * Returns: { roles: string[], hierarchy: Record<string, number> }
 */
import { ROLES } from "../middleware/rbac.js";

adminRouter.get("/roles", (_req, res) => {
  const hierarchy = Object.fromEntries(ROLES.map((r, i) => [r, i]));
  res.json({ roles: ROLES, hierarchy });
});

// Alert rules schema and endpoints
const alertRuleSchema = z.object({
  contractId: z.string().min(1, "Contract ID is required"),
  metric: z.enum(["error_rate", "large_distribution", "unusual_token", "high_latency"]),
  threshold: z.number().positive(),
  windowMinutes: z.number().int().positive().default(60),
  action: z.object({
    type: z.enum(["webhook", "email"]),
    target: z.string().url().or(z.string().email()).optional(),
  }),
  enabled: z.boolean().default(true),
}).refine((data) => {
  if (data.action.type === "webhook") {
    return z.string().url().safeParse(data.action.target).success;
  }
  if (data.action.type === "email") {
    return z.string().email().safeParse(data.action.target).success;
  }
  return false;
}, { message: "Invalid action target for the selected type" });

adminRouter.get("/alert-rules", requireAdminBearerOrRole("admin"), async (_req, res, next) => {
  try {
    const rules = await listAlertRules();
    res.json({ rules });
  } catch (err) {
    next(err);
  }
});

adminRouter.post(
  "/alert-rules",
  requireAdminBearerOrRole("admin"),
  validate(alertRuleSchema),
  async (req, res, next) => {
    try {
      const rule = await createAlertRule(req.body);
      logger.info("Admin: created alert rule", { ruleId: rule.id, contractId: req.body.contractId });
      res.status(201).json({ rule });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.put(
  "/alert-rules/:Id",
  requireAdminBearerOrRole("admin"),
  validate(alertRuleSchema.partial()),
  async (req, res, next) => {
    try {
      const rule = await updateAlertRule(req.params.id, req.body);
      if (!rule) {
        return sendError(res, 404, "not_found", "Alert rule not found");
      }
      logger.info("Admin: updated alert rule", { ruleId: rule.id });
      res.json({ rule });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.delete(
  "/alert-rules/:Id",
  requireAdminBearerOrRole("admin"),
  async (req, res, next) => {
    try {
      await deleteAlertRule(req.params.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);
