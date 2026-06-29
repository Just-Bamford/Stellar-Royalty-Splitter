import { z } from "zod";
import { sendError, sendValidationError } from "./error-response.js";

export const stellarAddress = z
  .string("Validation failed: walletAddress must be a string")
  .regex(/^G[A-Z2-7]{55}$/, "Validation failed: Invalid Stellar address");

export const contractAddress = z
  .string("Validation failed: contractId must be a string")
  .regex(/^C[A-Z2-7]{55}$/, "Validation failed: Invalid contract address");

export const basisPoints = z.number().int().min(0).max(10000);

export const initializeSchema = z
  .object({
    contractId: contractAddress,
    walletAddress: stellarAddress,
    collaborators: z.array(stellarAddress).min(1, "Collaborators array must be non-empty").max(20),
    shares: z.array(basisPoints).min(1).max(20),
    // Issue #421: optional UUID for permanent per-contract request dedup.
    nonce: z.string().uuid("nonce must be a valid UUID").optional(),
  })
  .refine((d) => d.collaborators.length === d.shares.length, {
    message: "collaborators and shares must be the same length",
  })
  .superRefine((d, ctx) => {
    const actual = d.shares.reduce((a, b) => a + b, 0);
    if (actual !== 10000) {
      ctx.addIssue({
        code: "custom",
        path: ["shares"],
        message: `shares must sum to 10000 basis points (got ${actual}, expected 10000)`,
      });
    }
  });

const bytes32Hex = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be a 32-byte hex string (64 hex chars)");

export const commitInitializeSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  collaboratorsHash: bytes32Hex,
  sharesHash: bytes32Hex,
  nonce: bytes32Hex,
});

export const revealInitializeSchema = initializeSchema.extend({
  salt: bytes32Hex,
});

export const INITIALIZE_PAYLOAD_LIMIT_BYTES = 10 * 1024;
export const INITIALIZE_COLLABORATORS_PAYLOAD_LIMIT_BYTES = 8 * 1024;

export const distributeSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  tokenId: contractAddress,
});

export const setRoyaltyRateSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  royaltyRate: basisPoints,
});

export const recordSecondarySaleSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  nftId: z.string().min(1),
  previousOwner: stellarAddress,
  newOwner: stellarAddress,
  salePrice: z.number().int().positive(),
  saleToken: contractAddress,
  royaltyRate: basisPoints,
});

export const distributeSecondarySchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  tokenId: contractAddress,
});

export const webhookRegisterSchema = z.object({
  url: z
    .string()
    .url("Invalid webhook URL")
    .refine((value) => value.startsWith("https://"), {
      message: "Webhook URL must use HTTPS",
    }),
});

export const transactionConfirmSchema = z.object({
  transactionId: z.number().int().positive().optional(),
  blockTime: z.string().optional(),
  errorMessage: z.string().optional(),
  status: z.enum(["pending", "confirmed", "failed"]).optional(),
});

/** Pagination constraints (issue #394): limit 1–100 (default 10), offset >= 0 */
export const PAGINATION_DEFAULT_LIMIT = 10;
export const PAGINATION_MAX_LIMIT = 100;
export const PAGINATION_MAX_OFFSET = 1_000_000;

const paginationLimitSchema = z.coerce
  .number()
  .int("limit must be an integer")
  .min(1, "limit must be at least 1")
  .max(PAGINATION_MAX_LIMIT, `limit must not exceed ${PAGINATION_MAX_LIMIT}`)
  .default(PAGINATION_DEFAULT_LIMIT);

const paginationOffsetSchema = z.coerce
  .number()
  .int("offset must be an integer")
  .min(0, "offset must be >= 0")
  .max(PAGINATION_MAX_OFFSET, `offset must not exceed ${PAGINATION_MAX_OFFSET}`)
  .default(0);

export const paginationQuerySchema = z.object({
  limit: paginationLimitSchema,
  offset: paginationOffsetSchema,
});

/** Analytics query bounds (issue #394) */
export const analyticsQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  collaboratorLimit: z.coerce
    .number()
    .int("collaboratorLimit must be an integer")
    .min(1, "collaboratorLimit must be at least 1")
    .max(PAGINATION_MAX_LIMIT, `collaboratorLimit must not exceed ${PAGINATION_MAX_LIMIT}`)
    .default(PAGINATION_DEFAULT_LIMIT)
    .optional(),
});

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return sendValidationError(
        res,
        result.error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }))
      );
    }
    req.body = result.data;
    next();
  };
}

function getJsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value ?? ""), "utf8");
}

export function validateInitializePayloadSize(req, res, next) {
  const totalBodyBytes = getJsonByteLength(req.body);

  if (totalBodyBytes > INITIALIZE_PAYLOAD_LIMIT_BYTES) {
    return sendError(res, 413, "payload_too_large", "Payload too large");
  }

  if (Array.isArray(req.body?.collaborators)) {
    const collaboratorsBytes = getJsonByteLength(req.body.collaborators);

    if (collaboratorsBytes > INITIALIZE_COLLABORATORS_PAYLOAD_LIMIT_BYTES) {
      return sendError(res, 413, "payload_too_large", "Collaborators payload too large");
    }
  }

  next();
}

/**
 * Express middleware that validates :contractId route param.
 * Returns 400 { error: "Invalid contract ID format" } if invalid.
 */
export function validateContractIdMiddleware(req, res, next) {
  const contractId = req.params.contractId;
  if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
    return sendError(res, 400, "invalid_contract_id", "Invalid contract ID format");
  }
  next();
}

/**
 * Validate a Stellar contract ID path param.
 * Returns true if valid, otherwise sends a 400 and returns false.
 */
export function validateContractId(contractId, res) {
  if (!/^C[A-Z2-7]{55}$/.test(contractId)) {
    sendError(res, 400, "invalid_contract_id", "Invalid contract ID format");
    return false;
  }
  return true;
}

/**
 * Validate a Stellar public key (G...) address.
 * Returns true if valid, otherwise sends a 400 and returns false.
 */
export function validateStellarAddress(address, res) {
  if (!address || !/^G[A-Z2-7]{55}$/.test(address)) {
    sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
    return false;
  }
  return true;
}

/**
 * Express middleware that validates query-string pagination params via Zod.
 */
export function validatePaginationQuery(req, res, next) {
  const result = paginationQuerySchema.safeParse(req.query);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({
        field: e.path.join(".") || "query",
        message: e.message,
      }))
    );
  }
  req.pagination = result.data;
  next();
}

/**
 * Parse and validate limit/offset query params.
 * Returns { limit, offset } on success, or sends a 400 and returns null.
 * Rejects out-of-range values with 400 (issue #394).
 * @param {object} query - req.query
 * @param {object} res   - express response
 */
export function parsePagination(query, res) {
  const result = paginationQuerySchema.safeParse(query);
  if (!result.success) {
    sendValidationError(
      res,
      result.error.issues.map((e) => ({
        field: e.path.join(".") || "query",
        message: e.message,
      }))
    );
    return null;
  }
  return result.data;
}

/**
 * Royalty split payload schema & middleware (#228)
 * Validates Stellar public keys and percentage sums before hitting contract layer.
 */
export const royaltySplitItemSchema = z.object({
  address: stellarAddress,
  percentage: z.number().min(0).max(100).optional(),
  share: basisPoints.optional(),
});

export function validateRoyaltySplitMiddleware(req, res, next) {
  const body = req.body || {};

  let items = [];

  if (Array.isArray(body.recipients) && typeof body.recipients[0] === "object" && body.recipients[0] !== null) {
    items = body.recipients.map((r, idx) => ({
      address: r.address ?? r.recipient ?? r.walletAddress ?? "",
      percentage: typeof r.percentage === "number" ? r.percentage : (typeof r.share === "number" ? r.share / 100 : null),
      share: typeof r.share === "number" ? r.share : (typeof r.percentage === "number" ? Math.round(r.percentage * 100) : null),
      path: `recipients.${idx}`,
    }));
  } else if (Array.isArray(body.recipients) && typeof body.recipients[0] === "string") {
    const shares = body.shares ?? body.percentages?.map((p) => Math.round(p * 100)) ?? [];
    const percentages = body.percentages ?? body.shares?.map((s) => s / 100) ?? [];
    if (body.recipients.length !== (body.percentages ?? body.shares ?? []).length) {
      return sendError(res, 400, "validation_error", "Validation failed: recipients and percentages/shares arrays must be the same length");
    }
    items = body.recipients.map((addr, idx) => ({
      address: addr,
      percentage: percentages[idx],
      share: shares[idx],
      path: `recipients.${idx}`,
    }));
  } else if (Array.isArray(body.collaborators)) {
    const shares = body.shares ?? body.percentages?.map((p) => Math.round(p * 100)) ?? [];
    const percentages = body.percentages ?? body.shares?.map((s) => s / 100) ?? [];
    if (body.collaborators.length !== (body.shares ?? body.percentages ?? []).length) {
      return sendError(res, 400, "validation_error", "Validation failed: collaborators and shares/percentages arrays must be the same length");
    }
    items = body.collaborators.map((addr, idx) => ({
      address: addr,
      percentage: percentages[idx],
      share: shares[idx],
      path: `collaborators.${idx}`,
    }));
  } else {
    return sendError(res, 400, "validation_error", "Validation failed: Missing royalty split payload (expected recipients or collaborators list)");
  }

  if (items.length === 0) {
    const collectionName = Array.isArray(body.collaborators) ? "Collaborators" : "Recipients";
    return sendError(res, 400, "validation_error", `Validation failed: ${collectionName} array must be non-empty`);
  }

  if (items.length > 20) {
    return sendError(res, 400, "validation_error", "Validation failed: Too many recipients (max 20)");
  }

  const issues = [];
  for (const item of items) {
    if (!item.address || typeof item.address !== "string" || !/^G[A-Z2-7]{55}$/.test(item.address)) {
      issues.push({
        field: `${item.path}.address`,
        message: `Validation failed: Invalid Stellar address (${item.address || "empty"})`,
      });
    }
    if (item.share === null || item.percentage === null || Number.isNaN(item.share) || item.share <= 0) {
      issues.push({
        field: `${item.path}.share`,
        message: "Validation failed: Percentage or share must be a positive number",
      });
    }
  }

  if (issues.length > 0) {
    return sendValidationError(res, issues);
  }

  const totalShares = items.reduce((acc, it) => acc + (it.share ?? 0), 0);
  if (totalShares !== 10000) {
    const actualPct = totalShares / 100;
    return sendValidationError(res, [{
      field: "shares",
      message: `Validation failed: percentages must sum to exactly 100 (got ${actualPct}% / ${totalShares} basis points, expected 100% / 10000 basis points)`,
    }]);
  }

  req.body = {
    ...body,
    collaborators: items.map((i) => i.address),
    shares: items.map((i) => i.share),
    recipients: items.map((i) => ({ address: i.address, share: i.share, percentage: i.percentage })),
  };

  next();
}

export const validateRoyaltySplitPayload = validateRoyaltySplitMiddleware;
export const validateRoyaltySplit = validateRoyaltySplitMiddleware;

export const assignRoleSchema = z.object({
  contractId: contractAddress.nullable().optional(),
  walletAddress: stellarAddress,
  role: z.enum(["viewer", "operator", "admin"]),
});

export const batchDistributeSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  tokenIds: z.array(contractAddress).min(1, "At least one token is required").max(10, "Cannot batch more than 10 tokens"),
});

