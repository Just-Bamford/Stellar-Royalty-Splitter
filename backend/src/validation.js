import { z } from "zod";
import { sendError, sendValidationError } from "./error-response.js";
import { isValidStellarAccountAddress } from "../../shared/stellar-address.js";

// ── Size limits ──────────────────────────────────────────────────────────────
// Soroban instance storage limit is 64 KB. These caps prevent single large
// requests from bloating on-chain storage or exhausting backend processing.
export const MAX_COLLABORATORS = 10;
export const MAX_NFT_ID_LENGTH = 256; // raised to 256 in a later migration
export const MAX_BODY_BYTES = 8_192; // 8 KB hard cap on any JSON request body
export const MAX_SALE_PRICE = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

export const stellarAddress = z
  .string("Validation failed: walletAddress must be a string")
  .refine(isValidStellarAccountAddress, "Validation failed: Invalid Stellar address");

export function isValidStellarAddress(addr) {
  return isValidStellarAccountAddress(addr);
}

export const contractAddress = z
  .string("Validation failed: contractId must be a string")
  .regex(/^C[A-Z2-7]{55}$/, "Validation failed: Invalid contract address");

export const basisPoints = z.number().int().min(0).max(10000);

export const initializeSchema = z
  .object({
    contractId: contractAddress,
    walletAddress: stellarAddress,
    collaborators: z
      .array(stellarAddress)
      .min(1, "at least one collaborator required")
      .max(MAX_COLLABORATORS, `maximum ${MAX_COLLABORATORS} collaborators allowed`),
    shares: z
      .array(basisPoints)
      .min(1, "at least one share required")
      .max(MAX_COLLABORATORS, `maximum ${MAX_COLLABORATORS} shares allowed`),
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

// Named size limits — kept in sync with on-chain MAX_COLLABORATORS / MAX_RECIPIENTS constants.
export const MAX_COLLABORATORS_BACKEND = 20;

// `.finite()` is load-bearing, not defensive: z.number().positive() is a plain
// `> 0` test, and Infinity satisfies it. Without this the schema accepts
// Infinity as a distribution amount, which then reaches BigInt() in
// i128ToScVal and throws deep in transaction construction rather than being
// rejected at the API boundary. Found by the property-based fuzz suite (#866).
export const amountSchema = z.union([
  z
    .number()
    .finite("Distribution amount must be a finite number")
    .positive("Distribution amount must be positive"),
  z.string().regex(/^[1-9]\d*$/, "Distribution amount must be a positive integer"),
]);

export const distributeSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  tokenId: contractAddress,
  amount: amountSchema.optional(),
});

// Soroban simulation footprint limits the practical size of a single ledger
// entry write set — 50 operations per batch keeps each request well within
// that limit (#759).
export const MAX_BATCH_OPERATIONS = 50;

export const batchDistributeSchema = z.object({
  walletAddress: stellarAddress,
  operations: z
    .array(
      z.object({
        contractId: contractAddress,
        tokenId: contractAddress,
        amount: amountSchema.optional(),
      })
    )
    .min(1, "operations array must be non-empty")
    .max(
      MAX_BATCH_OPERATIONS,
      `operations array must not exceed ${MAX_BATCH_OPERATIONS} entries`
    ),
});

export const setRoyaltyRateSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  royaltyRate: basisPoints,
});

export const setSecondaryPoolLimitSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  maxPoolSize: z.number().int().positive(),
});

export const recordSecondarySaleSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  nftId: z
    .string()
    .min(1, "nftId is required")
    .max(MAX_NFT_ID_LENGTH, `nftId must be at most ${MAX_NFT_ID_LENGTH} characters`),
  previousOwner: stellarAddress,
  newOwner: stellarAddress,
  salePrice: z
    .number()
    .int("salePrice must be an integer")
    .positive("salePrice must be positive")
    .max(MAX_SALE_PRICE, "salePrice exceeds maximum safe integer"),
  saleToken: contractAddress,
  royaltyRate: basisPoints,
});

export const distributeSecondarySchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  tokenId: contractAddress,
  amount: amountSchema.optional(),
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

/**
 * The complete, closed set of audit actions the app itself ever emits via
 * addAuditLog(). Keep in sync with the auditAction/action values passed at
 * each call site (routes/initialize.js, routes/distribute.js,
 * routes/secondary-royalty.js). Used to reject forged/unknown audit entries
 * on the public read-only-adjacent surface.
 */
export const AUDIT_ACTIONS = [
  "contract_initialized",
  "distribution_initiated",
  "secondary_sale_recorded",
  "royalty_rate_set",
  "secondary_distribution_initiated",
];

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
  // Guard on the type before the regex: RegExp.test() coerces its argument to
  // a string, and that coercion throws a TypeError for a symbol. Any throw
  // here would surface as a 500 for what is really a malformed request (#866).
  if (typeof contractId !== "string" || !/^C[A-Z2-7]{55}$/.test(contractId)) {
    return sendError(res, 400, "invalid_contract_id", "Invalid contract ID format");
  }
  next();
}

/**
 * Validate a Stellar contract ID path param.
 * Returns true if valid, otherwise sends a 400 and returns false.
 */
export function validateContractId(contractId, res) {
  // Same type guard as validateContractIdMiddleware — the two must agree, or
  // whichever route uses the looser one becomes a validation bypass (#866).
  if (typeof contractId !== "string" || !/^C[A-Z2-7]{55}$/.test(contractId)) {
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
  if (typeof address !== "string" || !isValidStellarAccountAddress(address)) {
    sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
    return false;
  }
  return true;
}

/**
 * Zod schema for paginated query params.
 * limit: integer 1–100, defaults to 10.
 * offset: non-negative integer, defaults to 0.
 *
 * Query strings arrive as plain strings, so coerce with z.coerce.number().
 */
export const paginationSchema = z.object({
  limit: z.coerce
    .number({ invalid_type_error: "limit must be a number" })
    .int("limit must be an integer")
    .min(1, "limit must be at least 1")
    .max(100, "limit must be at most 100")
    .default(10),
  offset: z.coerce
    .number({ invalid_type_error: "offset must be a number" })
    .int("offset must be an integer")
    .min(0, "offset must be >= 0")
    .default(0),
});

/**
 * Zod schema for analytics date-range query params.
 * start / end: optional ISO 8601 date strings.
 * topLimit: integer 1–100, defaults to 10 (caps the topEarners list).
 */
export const analyticsQuerySchema = z
  .object({
    start: z.string().optional(),
    end: z.string().optional(),
    topLimit: z.coerce
      .number({ invalid_type_error: "topLimit must be a number" })
      .int("topLimit must be an integer")
      .min(1, "topLimit must be at least 1")
      .max(100, "topLimit must be at most 100")
      .default(10),
  })
  .superRefine((d, ctx) => {
    if (d.start) {
      const t = new Date(d.start).getTime();
      if (isNaN(t)) {
        ctx.addIssue({ code: "custom", path: ["start"], message: "Invalid start date. Use ISO 8601 format." });
      }
    }
    if (d.end) {
      const t = new Date(d.end).getTime();
      if (isNaN(t)) {
        ctx.addIssue({ code: "custom", path: ["end"], message: "Invalid end date. Use ISO 8601 format." });
      }
    }
    if (d.start && d.end) {
      const s = new Date(d.start).getTime();
      const e = new Date(d.end).getTime();
      if (!isNaN(s) && !isNaN(e) && s > e) {
        ctx.addIssue({ code: "custom", path: ["start"], message: "start date must be before end date." });
      }
    }
  });

/**
 * Express middleware that validates query params against a Zod schema.
 * On success, req.query is replaced with the parsed (coerced + defaulted) value.
 * On failure, responds 400 with the standard validation-error shape.
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return sendValidationError(
        res,
        result.error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }))
      );
    }
    req.query = result.data;
    next();
  };
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

/**
 * Parse cursor-based pagination params.
 * Accepts `cursor` (base64-encoded JSON {timestamp, id}) and `limit`.
 * Returns { limit, cursor: {timestamp, id} | null } or sends 400 and returns null.
 */
export function parseCursorPagination(query, res, defaultLimit = 50, maxLimit = 100) {
  if (query.limit !== undefined && isNaN(parseInt(query.limit))) {
    sendError(res, 400, "invalid_query_parameter", "limit must be a number");
    return null;
  }
  const limit = Math.min(Math.max(parseInt(query.limit) || defaultLimit, 1), maxLimit);

  let cursor = null;
  if (query.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(query.cursor, "base64").toString("utf8"));
      if (!decoded.timestamp || !decoded.id) {
        sendError(res, 400, "invalid_query_parameter", "Invalid cursor format");
        return null;
      }
      cursor = { timestamp: decoded.timestamp, id: decoded.id };
    } catch {
      sendError(res, 400, "invalid_query_parameter", "Invalid cursor format");
      return null;
    }
  }

  return { limit, cursor };
}

/**
 * Encode a cursor value from timestamp and id for the next page.
 */
export function encodeCursor(timestamp, id) {
  return Buffer.from(JSON.stringify({ timestamp, id })).toString("base64");
}

// ── Request Complexity Budgeting (#892) ──────────────────────────────────────
export {
  calculateComplexity,
  DEFAULT_COMPLEXITY_LIMIT,
  DEFAULT_COMPLEXITY_METHODS,
  getComplexityLimit,
  requestComplexityMiddleware,
} from "./request-complexity.js";
