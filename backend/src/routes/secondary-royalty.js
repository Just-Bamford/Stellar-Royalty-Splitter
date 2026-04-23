import { Router } from "express";
import {
  buildTx,
  addressToScVal,
  i128ToScVal,
  u32ToScVal,
  getRoyaltyRateFromContract,
} from "../stellar.js";
import {
  recordTransaction,
  recordSecondarySale,
  recordSecondaryRoyaltyDistribution,
  getSecondarySales,
  getSecondaryRoyaltyDistributions,
  getRoyaltyStatistics,
  updateTransactionHash,
  addAuditLog,
} from "../database.js";
import { validate, recordSecondarySaleSchema, setRoyaltyRateSchema, validateContractId, parsePagination } from "../validation.js";

export const secondaryRoyaltyRouter = Router();

/**
 * POST /api/secondary-royalty
 * Body: { contractId, walletAddress, nftId, previousOwner, newOwner, salePrice, saleToken, royaltyRate }
 * Returns: { xdr, transactionId, royaltyAmount } — transaction to record royalty + calculated royalty
 */
secondaryRoyaltyRouter.post("/", validate(recordSecondarySaleSchema), async (req, res, next) => {
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
      return res.status(400).json({ error: "Missing required fields." });
    }

    if (salePrice <= 0) {
      return res.status(400).json({ error: "Sale price must be positive." });
    }

    if (royaltyRate < 0 || royaltyRate > 10000) {
      return res
        .status(400)
        .json({ error: "Royalty rate must be between 0 and 10000 basis points." });
    }

    // Fetch on-chain royalty rate instead of trusting client-supplied value
    const onChainRate = await getRoyaltyRateFromContract(contractId);

    // Calculate royalty amount using on-chain rate
    const royaltyAmount = Math.floor((salePrice * onChainRate) / 10000);

    if (royaltyAmount <= 0) {
      return res.status(400).json({ error: "Calculated royalty amount is zero." });
    }

    // Record transaction in database
    const transactionId = recordTransaction(
      contractId,
      "secondary_royalty",
      walletAddress,
      { salePrice: salePrice.toString(), nftId, saleToken, royaltyRate: onChainRate }
    );

    // Record the secondary sale (unique constraint prevents duplicates)
    try {
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
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return res.status(409).json({ error: "This sale has already been recorded." });
      }
      throw err;
    }

    // Build transaction to record royalty in contract
    const txXdr = await buildTx(walletAddress, contractId, "record_secondary_royalty", [
      i128ToScVal(salePrice),
    ]);

    // Log the secondary sale
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

/**
 * POST /api/secondary-royalty/set-rate
 * Body: { contractId, walletAddress, royaltyRate }
 * Returns: { xdr, transactionId } — unsigned transaction to set royalty rate
 */
secondaryRoyaltyRouter.post("/set-rate", validate(setRoyaltyRateSchema), async (req, res, next) => {
  try {
    const { contractId, walletAddress, royaltyRate } = req.body;

    if (!contractId || !walletAddress || royaltyRate == null) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    if (royaltyRate < 0 || royaltyRate > 10000) {
      return res
        .status(400)
        .json({ error: "Royalty rate must be between 0 and 10000 basis points." });
    }

    // Record transaction
    const transactionId = recordTransaction(
      contractId,
      "secondary_royalty",
      walletAddress,
      { royaltyRate }
    );

    // Build transaction to set royalty rate
    const txXdr = await buildTx(walletAddress, contractId, "set_royalty_rate", [
      u32ToScVal(royaltyRate),
    ]);

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
 * POST /api/secondary-royalty/distribute
 * Body: { contractId, walletAddress, tokenId }
 * Returns: { xdr, transactionId } — unsigned transaction to distribute secondary royalties
 */
secondaryRoyaltyRouter.post("/distribute", async (req, res, next) => {
  try {
    const { contractId, walletAddress, tokenId } = req.body;

    if (!contractId || !walletAddress || !tokenId) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Get pending secondary sales
    const pendingSales = getSecondarySales(contractId);

    if (pendingSales.length === 0) {
      return res.status(400).json({ error: "No pending secondary royalties to distribute." });
    }

    // Calculate total royalties
    const totalRoyalties = pendingSales.reduce((sum, sale) => {
      return sum + BigInt(sale.royaltyAmount);
    }, 0n);

    const transactionId = recordTransaction(
      contractId,
      "secondary_distribute",
      walletAddress,
      { totalRoyalties: totalRoyalties.toString(), numberOfSales: pendingSales.length }
    );

    // Build transaction to distribute secondary royalties
    const txXdr = await buildTx(walletAddress, contractId, "distribute_secondary_royalties", [
      addressToScVal(tokenId),
    ]);

    addAuditLog(contractId, "secondary_distribution_initiated", walletAddress, {
      transactionId,
      numberOfSales: pendingSales.length,
      totalRoyalties: totalRoyalties.toString(),
    });

    res.json({
      xdr: txXdr,
      transactionId,
      numberOfSales: pendingSales.length,
      totalRoyalties: totalRoyalties.toString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/secondary-royalty/stats/:contractId
 * Returns royalty statistics for a contract.
 * Results are cached in-memory for 60 seconds to avoid hammering the DB.
 */
const statsCache = new Map(); // key: contractId, value: { data, expiresAt }

secondaryRoyaltyRouter.get("/stats/:contractId", (req, res, next) => {
  try {
    const { contractId } = req.params;

    if (!contractId) {
      return res.status(400).json({ error: "Contract ID is required." });
    }

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
 * Query params: limit, offset, nftId
 * Returns paginated list of secondary sales
 */
secondaryRoyaltyRouter.get("/sales/:contractId", (req, res, next) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const pagination = parsePagination(req.query, res, 50, 100);
    if (!pagination) return;
    const { limit, offset } = pagination;

    const { nftId } = req.query;
    const sales = getSecondarySales(contractId, limit, offset, nftId);

    res.json({ sales, total: sales.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/secondary-royalty/distributions/:contractId
 * Query params: limit, offset
 * Returns paginated list of secondary royalty distributions
 */
secondaryRoyaltyRouter.get("/distributions/:contractId", (req, res, next) => {
  try {
    const { contractId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    if (!contractId) {
      return res.status(400).json({ error: "Contract ID is required." });
    }

    const distributions = getSecondaryRoyaltyDistributions(
      contractId,
      parseInt(limit),
      parseInt(offset)
    );

    res.json({ distributions });
  } catch (err) {
    next(err);
  }
});
