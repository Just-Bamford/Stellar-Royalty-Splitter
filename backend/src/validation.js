import { z } from "zod";
import { sendError, sendValidationError } from "./error-response.js";

export const stellarAddress = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

export const contractAddress = z
  .string()
  .regex(/^C[A-Z2-7]{55}$/, "Invalid contract address");

export const basisPoints = z.number().int().min(0).max(10000);

export const initializeSchema = z
  .object({
    contractId: contractAddress,
    walletAddress: stellarAddress,
    collaborators: z.array(stellarAddress).min(1).max(20),
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

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return sendValidationError(res, result.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })));
    }
    req.body = result.data;
    next();
  };
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
 * Parse and validate limit/offset query params.
 * Returns { limit, offset } on success, or sends a 400 and returns null.
 * @param {object} query - req.query
 * @param {object} res   - express response
 * @param {number} defaultLimit
 * @param {number} maxLimit
 */
export function parsePagination(query, res, defaultLimit = 50, maxLimit = 100) {
  if (query.limit !== undefined && isNaN(parseInt(query.limit))) {
    sendError(res, 400, "invalid_query_parameter", "limit must be a number");
    return null;
  }
  if (query.offset !== undefined && isNaN(parseInt(query.offset))) {
    sendError(res, 400, "invalid_query_parameter", "offset must be a number");
    return null;
  }
  const limit = Math.min(Math.max(parseInt(query.limit) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(query.offset) || 0, 0);
  return { limit, offset };
}
