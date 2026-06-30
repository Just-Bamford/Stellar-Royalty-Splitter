import StellarSdk from "@stellar/stellar-sdk";

const MIN_FEE = 100;
const MAX_FEE = 100_000;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export function validateXdrStructure(xdrString, networkPassphrase) {
  const errors = [];

  let transaction;
  try {
    transaction = new StellarSdk.Transaction(xdrString, networkPassphrase);
  } catch (e) {
    return { valid: false, errors: [`Invalid XDR: ${e.message}`] };
  }

  const source = transaction.source;
  if (!source || typeof source !== "string") {
    errors.push("Transaction missing source account");
  } else if (!STELLAR_ADDRESS_REGEX.test(source)) {
    errors.push(`Invalid source account address: ${source}`);
  }

  const fee = parseInt(transaction.fee, 10);
  if (isNaN(fee)) {
    errors.push("Transaction fee is not a valid number");
  } else {
    if (fee < MIN_FEE) {
      errors.push(`Fee too low: ${fee} stroops (minimum ${MIN_FEE})`);
    }
    if (fee > MAX_FEE) {
      errors.push(`Fee too high: ${fee} stroops (maximum ${MAX_FEE})`);
    }
  }

  const operations = transaction.operations;
  if (!operations || operations.length === 0) {
    errors.push("Transaction must contain at least one operation");
  }

  const seq = transaction.sequence;
  if (!seq || typeof seq !== "string" || seq.length === 0) {
    errors.push("Transaction missing sequence number");
  }

  const timeBounds = transaction.timeBounds;
  if (!timeBounds) {
    errors.push("Transaction missing time bounds");
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}
