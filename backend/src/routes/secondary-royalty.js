import { Router } from "express";
import {
  buildTx,
  retryBuildTx,
  addressToScVal,
  i128ToScVal,
  u32ToScVal,
  getRoyaltyRateFromContract,
  server,
} from "../stellar.js";
import logger from "../logger.js";
import {
  db,
  recordTransaction,
  recordSecondarySale,
  getSecondarySales,
  getSecondaryRoyaltyDistributions,
  getRoyaltyStatistics,
  countSecondarySales,
  addAuditLog,
  applyLargestRemainder,
  commitSecondaryDistributionAtomic,
  addToRetryQueue,
  getRetryQueueStats,
  getDeadLetterQueueStats,
  getDeadLetterItems,
} from "../database/index.js";
import { idempotencyMiddleware } from "../idempotency.js";
import { assertValidXdr } from "./_shared.js";
import {
  validate,
  recordSecondarySaleSchema,
  setRoyaltyRateSchema,
  distributeSecondarySchema,
  validateContractId,
  validateContractIdMiddleware,
  parsePagination,
} from "../validation.js";
import { sendError } from "../error-response.js";

export const secondaryRoyaltyRouter = Router();

/**
 * NEW: GET /api/secondary-royalty/pool/:contractId
 * Returns the current secondary royalty pool balance for a contract
 */
secondaryRoyaltyRouter.get("/pool/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;

    // Call the contract method to fetch pool balance
    const result = await server.simulateTransaction({
      contractId,
      function: "get_secondary_royalty_pool",
    });

    res.json({ poolBalance: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/secondary-royalty
 * Body: { contractId, walletAddress, nftId, previousOwner, newOwner, salePrice, saleToken, royaltyRate }
 * Returns: { xdr, transactionId, royaltyAmount }
 */
secondaryRoyaltyRouter.post("/", idempotencyMiddleware, validate(recordSecondarySaleSchema), async (req, res, next) => {
  try {
    const {
      contractId,
      walletAddress,
      nftId,
      previousOwner,
      newOwner,
      salePrice,
      saleToken,
      royaltyRate,
    } = req.body;

    if (
      !contractId ||
      !walletAddress ||
      !nftId ||
      !previousOwner ||
      !newOwner ||
      salePrice == null ||
      !saleToken ||
      royaltyRate == null
    ) {
      return sendError(res, 400, "bad_request", "Missing required fields.");
    }

    if (salePrice <= 0) {
      return sendError(res, 400, "invalid_sale_price", "Sale price must be positive.");
    }

    if (royaltyRate < 0 || royaltyRate > 10000) {
      return sendError(
        res,
        400,
        "invalid_royalty_rate",
        "Royalty rate must be between 0 and 10000 basis points."
      );
    }

    // Fetch on-chain royalty rate
    const onChainRate = await getRoyaltyRateFromContract(contractId);

    // Calculate royalty amount
    const royaltyAmount = Math.floor((salePrice * onChainRate) / 10000);

    if (royaltyAmount <= 0) {
      return sendError(res, 400, "bad_request", "Calculated royalty amount is zero.");
    }

    let transactionId;
    try {
      const insertRecord = db.transaction(() => {
        transactionId = recordTransaction(contractId, "secondary_royalty", walletAddress, {
          salePrice: salePrice.toString(),
          nftId,
          saleToken,
          royaltyRate: onChainRate,
        });
        recordSecondarySale(
          contractId,
          nftId,
          previousOwner,
          newOwner,
          salePrice,
          saleToken,
          royaltyAmount,
          onChainRate
        );
      });
      insertRecord();
    } catch (err) {
      if (err.code && err.code.startsWith("SQLITE_CONSTRAINT")) {
        logger.warn("SQLite constraint violation recording secondary sale", {
          code: err.code,
          contractId,
          nftId,
        });
        return sendError(res, 409, "conflict", "This sale has already been recorded.");
      }
      throw err;
    }

    const txXdr = await buildTx(walletAddress, contractId, "record_secondary_royalty", [
      i128ToScVal(salePrice),
    ]);

    // Reject invalid XDR before it ever reaches the client (#XDR validation).
    assertValidXdr(txXdr);

    addAuditLog(contractId, "secondary_sale_recorded", walletAddress, {
      transactionId,
      nftId,
      salePrice: salePrice.toString(),
      royaltyAmount: royaltyAmount.toString(),
      royaltyRateUsed: onChainRate,
    });

    res.json({
      xdr: txXdr,
      transactionId,
      royaltyAmount,
      royaltyRateUsed: onChainRate,
    });
  } catch (err) {
    next(err);
  }
});

// ... (rest of your existing routes remain unchanged)
/**
 * POST /api/secondary-royalty/set-rate
 * Body: { contractId, walletAddress, royaltyRate }
 * Returns: { xdr, transactionId } — unsigned transaction to set royalty rate
 */
secondaryRoyaltyRouter.post("/set-rate", validate(setRoyaltyRateSchema), async (req, res, next) => {
  try {
    const { contractId, walletAddress, royaltyRate } = req.body;

    if (!contractId || !walletAddress || royaltyRate == null) {
      return sendError(res, 400, "bad_request", "Missing required fields.");
    }

    if (!Number.isInteger(royaltyRate) || royaltyRate < 0 || royaltyRate > 10000) {
      return sendError(
        res,
        400,
        "invalid_royalty_rate",
        "Royalty rate must be between 0 and 10000 basis points."
      );
    }

    // Record transaction
    const transactionId = recordTransaction(contractId, "secondary_royalty", walletAddress, {
      royaltyRate,
    });

    // Build transaction to set royalty rate
    const txXdr = await buildTx(walletAddress, contractId, "set_royalty_rate", [
      u32ToScVal(royaltyRate),
    ]);

    // Reject invalid XDR before it ever reaches the client (#XDR validation).
    assertValidXdr(txXdr);

    addAuditLog(contractId, "royalty_rate_set", walletAddress, {
      transactionId,
      royaltyRate,
    });

    res.json({ xdr: txXdr, transactionId });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/secondary-royalty/rate/:contractId
 * Returns the current on-chain royalty rate for the contract.
 */
secondaryRoyaltyRouter.get("/rate/:contractId", async (req, res, next) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const rate = await getRoyaltyRateFromContract(contractId);
    res.json({ contractId, royaltyRate: rate });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/secondary-royalty/distribute
 * Body: { contractId, walletAddress, tokenId, collaborators? }
 * `collaborators` is an optional array of { address, basisPoints } objects.
 * When provided, the total royalty pool is split using the largest-remainder
 * algorithm (#427) so that every lamport is accounted for and dust is
 * deterministically allocated to collaborators with the largest fractional share.
 * Returns: { xdr, transactionId } — unsigned transaction to distribute secondary royalties
 */
secondaryRoyaltyRouter.post(
  "/distribute",
  idempotencyMiddleware,
  validate(distributeSecondarySchema),
  async (req, res, next) => {
    try {
      const { contractId, walletAddress, tokenId, collaborators } = req.body;

      // Get pending (undistributed) secondary sales
      const pendingSales = getSecondarySales(contractId, 1000, 0, null, true);

      if (pendingSales.length === 0) {
        return sendError(res, 400, "bad_request", "No pending secondary royalties to distribute.");
      }

      // Calculate total royalties (BigInt for precision)
      const totalRoyalties = pendingSales.reduce((sum, sale) => {
        return sum + BigInt(sale.royaltyAmount);
      }, 0n);

      // ---------------------------------------------------------------------------
      // #427: Apply largest-remainder rounding when collaborator shares are provided
      // ---------------------------------------------------------------------------
      let roundingAllocations = null;
      let totalDustAllocated = 0n;
      let dustAuditData = null;

      if (Array.isArray(collaborators) && collaborators.length > 0) {
        const bpSum = collaborators.reduce((s, c) => s + (c.basisPoints ?? 0), 0);
        if (bpSum !== 10000) {
          return sendError(
            res,
            400,
            "invalid_collaborators",
            `collaborators basisPoints must sum to 10000, got ${bpSum}.`
          );
        }

        roundingAllocations = applyLargestRemainder(totalRoyalties, collaborators);
        totalDustAllocated = roundingAllocations.reduce((s, a) => s + a.dustReceived, 0n);

        if (totalDustAllocated > 0n) {
          dustAuditData = {
            totalDust: totalDustAllocated.toString(),
            dustRecipients: roundingAllocations
              .filter((a) => a.dustReceived > 0n)
              .map((a) => ({ address: a.address, dust: a.dustReceived.toString() })),
          };
        }
      }

      // Build the Stellar XDR *before* any DB writes so that a Stellar failure
      // never leaves sales in an inconsistent state (#471).
      let txXdr;
      try {
        txXdr = await buildTx(walletAddress, contractId, "distribute_secondary_royalties", [
          addressToScVal(tokenId),
        ]);
      } catch (buildError) {
        // Token validation or contract call failed - add to retry queue
        const errorMessage = buildError.message || String(buildError);
        addToRetryQueue({
          contractId,
          walletAddress,
          tokenId,
          collaborators,
          totalRoyalties,
          numberOfSales: pendingSales.length,
          pendingSaleIds: pendingSales.map((s) => s.id),
          totalDustAllocated,
          dustAuditData,
          errorMessage,
        });
        
        logger.error("Secondary royalty distribution failed, added to retry queue", {
          contractId,
          tokenId,
          error: errorMessage,
        });

        return sendError(
          res,
          503,
          "distribution_failed_retry_queued",
          `Distribution failed and queued for retry: ${errorMessage}`
        );
      }

      // Reject invalid XDR before committing any DB state or returning it to
      // the client. An invalid envelope is a deterministic failure, so it is
      // surfaced as an error rather than queued for retry.
      assertValidXdr(txXdr);

      // All DB writes are atomic: if any step fails, the transaction rolls back
      // and pending sales remain undistributed (#471).
      const transactionId = commitSecondaryDistributionAtomic({
        contractId,
        walletAddress,
        totalRoyalties,
        numberOfSales: pendingSales.length,
        pendingSaleIds: pendingSales.map((s) => s.id),
        totalDustAllocated,
        dustAuditData,
      });

      res.json({
        xdr: txXdr,
        transactionId,
        numberOfSales: pendingSales.length,
        totalRoyalties: totalRoyalties.toString(),
        dustAllocated: totalDustAllocated.toString(),
        ...(roundingAllocations && {
          allocations: roundingAllocations.map((a) => ({
            address: a.address,
            amount: a.amount.toString(),
            dustReceived: a.dustReceived.toString(),
          })),
        }),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/secondary-royalty/stats/:contractId
 * Returns royalty statistics for a contract.
 * Results are cached in-memory for 60 seconds to avoid hammering the DB.
 */
const statsCache = new Map(); // key: contractId, value: { data, expiresAt }

secondaryRoyaltyRouter.get("/stats/:contractId", validateContractIdMiddleware, (req, res, next) => {
  try {
    const { contractId } = req.params;
    const cached = statsCache.get(contractId);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.data);
    }

    const stats = getRoyaltyStatistics(contractId);
    statsCache.set(contractId, { data: stats, expiresAt: Date.now() + 60_000 });

    res.json(stats);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/secondary-royalty/sales/:contractId
 * Query params: limit, offset, nftId, startDate, endDate
 * Returns paginated list of secondary sales with optional date range filtering.
 * startDate and endDate are ISO 8601 strings (e.g. "2024-01-01T00:00:00Z").
 * Returns 400 if startDate > endDate.
 */
secondaryRoyaltyRouter.get("/sales/:contractId", (req, res, next) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const pagination = parsePagination(req.query, res);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const { nftId, startDate, endDate } = req.query;

    // Validate date range when either bound is supplied
    if (startDate || endDate) {
      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;

      if (start && isNaN(start.getTime())) {
        return sendError(res, 400, "invalid_query_parameter", "Invalid startDate.");
      }
      if (end && isNaN(end.getTime())) {
        return sendError(res, 400, "invalid_query_parameter", "Invalid endDate.");
      }
      if (start && end && start > end) {
        return sendError(res, 400, "invalid_query_parameter", "startDate must be before or equal to endDate.");
      }
    }

    const sales = getSecondarySales(contractId, limit, offset, nftId, false, startDate, endDate);
    const total = countSecondarySales(contractId, nftId, startDate, endDate);

    res.json({ sales, total });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/secondary-royalty/distributions/:contractId
 * Query params: limit, offset
 * Returns paginated list of secondary royalty distributions
 */
secondaryRoyaltyRouter.get(
  "/distributions/:contractId",
  validateContractIdMiddleware,
  (req, res, next) => {
    try {
      const { contractId } = req.params;
      const pagination = parsePagination(req.query, res);
      if (!pagination) return;
      const { limit, offset } = pagination;

      const distributions = getSecondaryRoyaltyDistributions(
        contractId,
        limit,
        offset
      );

      res.json({ distributions, pagination });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/secondary-royalty/retry-stats
 * Returns statistics about the retry queue
 */
secondaryRoyaltyRouter.get("/retry-stats", (req, res, next) => {
  try {
    const stats = getRetryQueueStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/secondary-royalty/dlq-stats
 * Returns statistics about the dead-letter queue
 */
secondaryRoyaltyRouter.get("/dlq-stats", (req, res, next) => {
  try {
    const stats = getDeadLetterQueueStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/secondary-royalty/dlq/:contractId
 * Query params: limit, offset
 * Returns paginated list of dead-letter queue items for a contract
 */
secondaryRoyaltyRouter.get(
  "/dlq/:contractId",
  validateContractIdMiddleware,
  (req, res, next) => {
    try {
      const { contractId } = req.params;
      const pagination = parsePagination(req.query, res);
      if (!pagination) return;
      const { limit, offset } = pagination;

      const dlqItems = getDeadLetterItems(contractId, limit, offset);

      res.json({ items: dlqItems, pagination });
    } catch (err) {
      next(err);
    }
  }
);
