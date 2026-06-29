import { Router } from "express";
import { addressToScVal, i128ToScVal } from "../stellar.js";
import { validate } from "../validation.js";
import { stellarAddress, contractAddress } from "../validation.js";
import { z } from "zod";
import { buildAndRecordTransaction } from "./_shared.js";
import { recordLoanLiquidation } from "../database/index.js";
import { sendError } from "../error-response.js";
import StellarSdk from "@stellar/stellar-sdk";

const { nativeToScVal } = StellarSdk;

export const liquidateRouter = Router();

const liquidateSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  borrower: stellarAddress,
  liquidator: stellarAddress,
  loanId: z.string().min(1),
  repayAmount: z.number().int().positive(),
  collateralSeized: z.number().int().positive(),
});

/**
 * POST /api/v1/liquidate
 * Body: { contractId, walletAddress, borrower, liquidator, loanId, repayAmount, collateralSeized }
 *
 * Builds unsigned XDR for the contract's `liquidate` call and records the
 * liquidation in the DB (loan_liquidations table, status = 'liquidated').
 * Returns: { xdr, transactionId, liquidationId }
 */
liquidateRouter.post("/", validate(liquidateSchema), async (req, res, next) => {
  try {
    const { contractId, walletAddress, borrower, liquidator, loanId, repayAmount, collateralSeized } =
      req.body;

    // Build XDR and record transaction
    const { xdr, transactionId } = await buildAndRecordTransaction({
      contractId,
      walletAddress,
      transactionType: "distribute", // reuse existing allowed type for tracking
      scvlArgs: [
        addressToScVal(borrower),
        addressToScVal(liquidator),
        nativeToScVal(loanId, { type: "string" }),
        i128ToScVal(repayAmount),
        i128ToScVal(collateralSeized),
      ],
      auditAction: "loan_liquidation_initiated",
      auditMetadata: { borrower, liquidator, loanId },
      transactionMetadata: {},
    });

    // Process event: record liquidation in DB
    const liquidationId = recordLoanLiquidation(
      contractId,
      loanId,
      borrower,
      liquidator,
      String(repayAmount),
      String(collateralSeized),
      null
    );

    res.json({ xdr, transactionId, liquidationId });
  } catch (err) {
    if (err.status) {
      return sendError(res, err.status, undefined, err.message);
    }
    next(err);
  }
});
