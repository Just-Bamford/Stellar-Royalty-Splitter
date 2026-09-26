import { compressXdrBatch, compressionSavings } from "./xdr-compressor.js";

export const ROLLOUT_STAGES = Object.freeze({ OPTIONAL: "optional", DEFAULT: "default", ALWAYS: "always" });
const VALID_STAGES = new Set(Object.values(ROLLOUT_STAGES));

export function rolloutStage(value = process.env.TX_BATCH_ROLLOUT_STAGE ?? ROLLOUT_STAGES.OPTIONAL) {
  return VALID_STAGES.has(value) ? value : ROLLOUT_STAGES.OPTIONAL;
}

export function shouldBatch({ requested = false, operationCount = 0, stage = rolloutStage() } = {}) {
  if (operationCount < 2) return false;
  if (stage === ROLLOUT_STAGES.ALWAYS || stage === ROLLOUT_STAGES.DEFAULT) return true;
  return requested;
}

export function groupBatchOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) throw new TypeError("operations must be a non-empty array");
  const groups = new Map();
  for (const operation of operations) {
    const type = String(operation.type ?? operation.method ?? "distribute");
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push({ ...operation, type });
  }
  return [...groups.entries()].map(([type, grouped]) => ({ type, operations: grouped }));
}

/** Build a transport batch; signing remains at the wallet boundary. */
export function createBatchPlan(operations, options = {}) {
  const stage = rolloutStage(options.stage);
  const groups = groupBatchOperations(operations);
  const batches = groups.map(({ type, operations: grouped }) => {
    const envelope = compressXdrBatch(grouped);
    return { type, count: grouped.length, envelope, savings: compressionSavings(envelope) };
  });
  return {
    enabled: shouldBatch({ requested: options.requested, operationCount: operations.length, stage }),
    stage,
    operationCount: operations.length,
    batches,
    totalOriginalBytes: batches.reduce((sum, batch) => sum + batch.envelope.originalBytes, 0),
    totalCompressedBytes: batches.reduce((sum, batch) => sum + batch.envelope.compressedBytes, 0),
  };
}
