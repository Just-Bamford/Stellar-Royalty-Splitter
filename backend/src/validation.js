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
    return res.status(413).json({ error: "Payload too large" });
  }

  if (Array.isArray(req.body?.collaborators)) {
    const collaboratorsBytes = getJsonByteLength(req.body.collaborators);

    if (collaboratorsBytes > INITIALIZE_COLLABORATORS_PAYLOAD_LIMIT_BYTES) {
      return res.status(413).json({ error: "Collaborators payload too large" });
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
