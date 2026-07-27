import { z } from "zod";
import { sendError, sendValidationError } from "./error-response.js";

export const stellarAddress = z
  .string("Validation failed: walletAddress must be a string")
  .regex(/^G[A-Z2-7]{55}$/, "Validation failed: Invalid Stellar address");

export function isValidStellarAddress(addr) {
  return typeof addr === "string" && /^G[A-Z2-7]{55}$/.test(addr);
}

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

export const emailDigestSubscribeSchema = z.object({
  walletAddress: stellarAddress,
  email: z.string().email("Invalid email address"),
  timezone: z.string().min(1).max(50).optional().default("UTC"),
  dayOfWeek: z.number().int().min(0).max(6).optional().default(0),
  hourOfDay: z.number().int().min(0).max(23).optional().default(9),
});

export const emailDigestPreferencesSchema = z.object({
  walletAddress: stellarAddress,
  email: z.string().email("Invalid email address").optional(),
  timezone: z.string().min(1).max(50).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  hourOfDay: z.number().int().min(0).max(23).optional(),
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

// ─── Dispute / ticket schemas (#607) ──────────────────────────────────────────

export const DISPUTE_CATEGORIES = ["wrong_amount", "missing_payment", "other"];
export const DISPUTE_STATUSES = ["open", "under_review", "resolved", "closed"];

/** Submitted by a contributor to open a new dispute ticket. */
export const disputeSubmitSchema = z.object({
  walletAddress: stellarAddress,
  contractId: contractAddress.optional(),
  category: z.enum(["wrong_amount", "missing_payment", "other"], {
    errorMap: () => ({
      message: `category must be one of: ${DISPUTE_CATEGORIES.join(", ")}`,
    }),
  }),
  description: z
    .string()
    .min(10, "description must be at least 10 characters")
    .max(2000, "description must not exceed 2000 characters"),
});

/** Submitted by a contributor to append a comment to their own ticket. */
export const disputeContributorCommentSchema = z.object({
  walletAddress: stellarAddress,
  message: z
    .string()
    .min(1, "message must not be empty")
    .max(2000, "message must not exceed 2000 characters"),
});

/** Admin: update the status of a dispute, with an optional note. */
export const disputeAdminReviewSchema = z.object({
  status: z.enum(["open", "under_review", "resolved", "closed"], {
    errorMap: () => ({
      message: `status must be one of: ${DISPUTE_STATUSES.join(", ")}`,
    }),
  }),
  adminNote: z.string().max(2000, "adminNote must not exceed 2000 characters").optional(),
});

/** Admin: post a comment on any dispute. */
export const disputeAdminCommentSchema = z.object({
  message: z
    .string()
    .min(1, "message must not be empty")
    .max(2000, "message must not exceed 2000 characters"),
});

// ─── Referral schemas (#603) ───────────────────────────────────────────────────

/**
 * Referral code format: "REF-" followed by 12 uppercase hex characters.
 * e.g. "REF-3A9F21B04C7E"
 */
export const referralCode = z
  .string()
  .regex(/^REF-[0-9A-F]{12}$/, "Invalid referral code format");

/** Generate (or retrieve) a referral link for a wallet. */
export const referralGenerateLinkSchema = z.object({
  walletAddress: stellarAddress,
});

/** Register a new contributor via a referral code. */
export const referralRegisterSchema = z.object({
  referralCode,
  referredAddress: stellarAddress,
});

/** Activate a referral and award a bonus once the referred contributor qualifies. */
export const referralActivateSchema = z.object({
  referredAddress: stellarAddress,
  bonusAmountStroops: z
    .number()
    .int()
    .positive("bonusAmountStroops must be a positive integer")
    .optional(),
  reason: z.string().min(1).max(500).optional(),
});

/** Admin: manually award an additional bonus to a referrer. */
export const referralAwardBonusSchema = z.object({
  referralId: z.number().int().positive(),
  referrerAddress: stellarAddress,
  bonusAmountStroops: z.number().int().positive("bonusAmountStroops must be a positive integer"),
  reason: z
    .string()
    .min(1, "reason must not be empty")
    .max(500, "reason must not exceed 500 characters"),
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
