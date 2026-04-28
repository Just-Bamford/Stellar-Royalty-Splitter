import { Router } from "express";
import {
  buildTx,
  addressToScVal,
  i128ToScVal,
  u32ToScVal,
  getRoyaltyRateFromContract,
  server, // <-- ensure server is imported from your stellar.js or wherever it's defined
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
import { validate, recordSecondarySaleSchema, setRoyaltyRateSchema } from "../validation.js";

export const secondaryRoyaltyRouter = Router();

/**
 * NEW: GET /api/secondary-royalty/pool/:contractId
 * Returns the current secondary royalty pool balance for a contract
 */
secondaryRoyaltyRouter.get("/pool/:contractId", async (req, res, next) => {
  try {
    const { contractId } = req.params;

    if (!contractId) {
      return res.status(400).json({ error: "Contract ID is required." });
    }

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

    // Fetch on-chain royalty rate
    const onChainRate = await getRoyaltyRateFromContract(contractId);

    // Calculate royalty amount
    const royaltyAmount = Math.floor((salePrice * onChainRate) / 10000);

    if (royaltyAmount <= 0) {
      return res.status(400).json({ error: "Calculated royalty amount is zero." });
    }

    const transactionId = recordTransaction(
      contractId,
      "secondary_royalty",
      walletAddress,
      { salePrice: salePrice.toString(), nftId, saleToken, royaltyRate: onChainRate }
    );

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

    const txXdr = await buildTx(walletAddress, contractId, "record_secondary_royalty", [
      i128ToScVal(salePrice),
    ]);

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
