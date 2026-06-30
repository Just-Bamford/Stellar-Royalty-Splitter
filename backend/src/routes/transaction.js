import express from "express";
import { getRequestTracking } from "../database/index.js";
import { sendError } from "../error-response.js";
import { isValidTransactionId } from "../transaction-tracking.js";

export const transactionRouter = express.Router();

transactionRouter.get("/:id", (req, res) => {
  const { id } = req.params;

  if (!isValidTransactionId(id)) {
    return sendError(
      res,
      400,
      "invalid_transaction_id",
      "Transaction ID must be a valid UUID v4"
    );
  }

  const record = getRequestTracking(id);

  if (!record) {
    return sendError(
      res,
      404,
      "transaction_not_found",
      "Transaction not found"
    );
  }

  // Parse bodies back if they are stored as JSON strings
  let requestBody = record.requestBody;
  if (requestBody) {
    try {
      requestBody = JSON.parse(requestBody);
    } catch {
      // not JSON, keep as is
    }
  }

  let responseBody = record.responseBody;
  if (responseBody) {
    try {
      responseBody = JSON.parse(responseBody);
    } catch {
      // not JSON, keep as is
    }
  }

  res.json({
    transactionId: record.transactionId,
    correlationId: record.correlationId,
    method: record.method,
    path: record.path,
    requestBody,
    responseStatus: record.responseStatus,
    responseBody,
    timestamp: record.timestamp,
  });
});
