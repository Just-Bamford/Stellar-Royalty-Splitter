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

function calculateFeeBreakdown(sim) {
  const totalFee = readSimulationFee(sim);
  const resourceFee = sim.minResourceFee ?? 0;
  const baseFee = BASE_FEE;
  const priorityFee = Math.max(0, totalFee - baseFee - resourceFee);
  
  return {
    base_fee: baseFee,
    priority_fee: priorityFee,
    resource_fee: resourceFee,
    total: totalFee,
  };
}

function calculatePerRecipientEffectiveFee(totalFee, recipientCount) {
  if (recipientCount === 0) return 0;
  return totalFee / recipientCount;
}

function calculateFeeScalingComparison(baseFee, recipientCount) {
  const collaboratorCounts = [2, 5, 10, 20];
  return collaboratorCounts
    .filter(count => count >= recipientCount)
    .map(count => ({
      collaborators: count,
      estimated_total_fee: baseFee * (1 + (count - 1) * 0.1), // Simplified scaling model
    }));
}

function readContractError(sim) {
  const error = sim.error ?? sim.message;
  if (typeof error === "string") return error;
  return nativeToString(error) ?? "Simulation failed";
}

function readResourceSummary(sim) {
  const authEntries = sim.result?.auth ?? sim.auth ?? [];
  return {
    minResourceFee: readSimulationFee(sim),
    latestLedger: sim.latestLedger ?? null,
    authEntries: Array.isArray(authEntries) ? authEntries.length : 0,
    hasTransactionData: Boolean(sim.transactionData),
  };
}

function isDistributionTopic(topicValues) {
  return topicValues.includes("dist") || topicValues.includes("sec_pay");
}

function readRecipientAmounts(events = []) {
  const recipientAmounts = [];

  for (const event of events) {
    const payload = getEventPayload(event);
    const type = readEventField(payload, "type") ?? event?.type;
    const topics = readEventField(payload, "topics") ?? [];
    const topicValues = Array.from(topics).map(scValToString);

    if (typeof type === "string" && type !== "contract") continue;
    if (!isDistributionTopic(topicValues)) continue;

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
 * Returns: { fee, recipientAmounts, contractError, feeBreakdown, perRecipientEffectiveFee, feeScalingComparison }
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
      const feeBreakdown = calculateFeeBreakdown(sim);
      return res.status(200).json({
        fee: readSimulationFee(sim),
        recipientAmounts: [],
        resourceSummary: readResourceSummary(sim),
        contractError: readContractError(sim),
        feeBreakdown,
        perRecipientEffectiveFee: 0,
        feeScalingComparison: calculateFeeScalingComparison(feeBreakdown.total, 0),
      });
    }

    const recipientAmounts = readRecipientAmounts(sim.events);
    const feeBreakdown = calculateFeeBreakdown(sim);
    const perRecipientEffectiveFee = calculatePerRecipientEffectiveFee(feeBreakdown.total, recipientAmounts.length);
    const feeScalingComparison = calculateFeeScalingComparison(feeBreakdown.total, recipientAmounts.length);

    res.json({
      fee: readSimulationFee(sim),
      recipientAmounts,
      resourceSummary: readResourceSummary(sim),
      contractError: null,
      feeBreakdown,
      perRecipientEffectiveFee,
      feeScalingComparison,
    });
  } catch (err) {
    next(err);
  }
});
