import { Router } from "express";
import StellarSdk from "@stellar/stellar-sdk";
import { server, networkPassphrase, addressToScVal } from "../stellar.js";
import { validate, distributeSchema } from "../validation.js";

const {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Account,
  scValToNative,
} = StellarSdk;

export const simulateRouter = Router();

function invokeIfFunction(value) {
  return typeof value === "function" ? value() : value;
}

function readEventField(event, field) {
  const value = event?.[field];
  return invokeIfFunction(value);
}

function getEventPayload(event) {
  return invokeIfFunction(event?.event) ?? event?.value ?? event;
}

function nativeToString(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  if (typeof value?.symbol === "string") return value.symbol;

  const stringValue = value?.toString?.();
  return stringValue && stringValue !== "[object Object]" ? stringValue : null;
}

function scValToString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  if (typeof value === "bigint") return value.toString();

  try {
    return nativeToString(scValToNative(value));
  } catch {
    return nativeToString(value);
  }
}

function scValTupleToNative(value) {
  if (Array.isArray(value)) return value;

  try {
    const native = scValToNative(value);
    return Array.isArray(native) ? native : [native];
  } catch {
    return [value];
  }
}

function readSimulationFee(sim) {
  const fee = sim.minResourceFee ?? sim.fee ?? BASE_FEE;
  const numericFee = Number(fee);
  return Number.isNaN(numericFee) ? fee.toString() : numericFee;
}

function readContractError(sim) {
  const error = sim.error ?? sim.message;
  if (typeof error === "string") return error;
  return nativeToString(error) ?? "Simulation failed";
}

function readRecipientAmounts(events = []) {
  const recipientAmounts = [];

  for (const event of events) {
    const payload = getEventPayload(event);
    const type = readEventField(payload, "type") ?? event?.type;
    const topics = readEventField(payload, "topics") ?? [];
    const topicValues = Array.from(topics).map(scValToString);

    if (typeof type === "string" && type !== "contract") continue;
    if (topicValues[0] !== "dist") continue;

    const data = readEventField(payload, "data");
    const [address, amount] = scValTupleToNative(data);

    recipientAmounts.push({
      address: scValToString(address),
      amount: scValToString(amount),
    });
  }

  return recipientAmounts.filter(({ address, amount }) => address && amount !== null);
}

/**
 * POST /api/simulate
 * Body: { contractId, walletAddress, tokenId }
 * Returns: { fee, recipientAmounts, contractError }
 *
 * Simulates the distribute call and returns expected fee, recipient amounts, and any contract errors.
 */
simulateRouter.post("/", validate(distributeSchema), async (req, res, next) => {
  try {
    const { contractId, walletAddress, tokenId } = req.body;
    const contract = new Contract(contractId);
    const dummyAccount = new Account(walletAddress, "0");
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("distribute", addressToScVal(tokenId)))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return res.status(200).json({
        fee: readSimulationFee(sim),
        recipientAmounts: [],
        contractError: readContractError(sim),
      });
    }

    res.json({
      fee: readSimulationFee(sim),
      recipientAmounts: readRecipientAmounts(sim.events),
      contractError: null,
    });
  } catch (err) {
    next(err);
  }
});
