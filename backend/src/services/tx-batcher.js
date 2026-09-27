import { compressXdrBatch, compressionSavings, calculateOptimalBatchSize } from "./xdr-compressor.js";

export const ROLLOUT_STAGES = Object.freeze({ OPTIONAL: "optional", DEFAULT: "default", ALWAYS: "always" });
export const BATCH_PRIORITIES = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 });
const VALID_STAGES = new Set(Object.values(ROLLOUT_STAGES));

export function rolloutStage(value = process.env.TX_BATCH_ROLLOUT_STAGE ?? ROLLOUT_STAGES.OPTIONAL) {
  return VALID_STAGES.has(value) ? value : ROLLOUT_STAGES.OPTIONAL;
}

export function shouldBatch({ requested = false, operationCount = 0, stage = rolloutStage() } = {}) {
  if (operationCount < 2) return false;
  if (stage === ROLLOUT_STAGES.ALWAYS || stage === ROLLOUT_STAGES.DEFAULT) return true;
  return requested;
}

/**
 * Group operations by type and priority for optimal packing.
 * Higher priority operations are batched first to ensure faster processing.
 */
export function groupBatchOperations(operations, options = {}) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError("operations must be a non-empty array");
  }
  
  const prioritizeByType = options.prioritize !== false;
  const groups = new Map();
  
  // Define operation type priorities
  const typePriority = {
    'distribute': BATCH_PRIORITIES.HIGH,
    'secondary_royalty': BATCH_PRIORITIES.HIGH,
    'secondary_distribute': BATCH_PRIORITIES.HIGH,
    'admin_suspend': BATCH_PRIORITIES.CRITICAL,
    'admin_resume': BATCH_PRIORITIES.CRITICAL,
    'admin_pause': BATCH_PRIORITIES.CRITICAL,
    'admin_tier_change': BATCH_PRIORITIES.MEDIUM,
    'initialize': BATCH_PRIORITIES.LOW,
  };
  
  for (const operation of operations) {
    const type = String(operation.type ?? operation.method ?? "distribute");
    const priority = operation.priority ?? typePriority[type] ?? BATCH_PRIORITIES.MEDIUM;
    const key = `${type}:${priority}`;
    
    if (!groups.has(key)) {
      groups.set(key, { type, priority, operations: [] });
    }
    groups.get(key).operations.push({ ...operation, type, priority });
  }
  
  // Sort groups by priority (critical first) if prioritization is enabled
  const groupArray = [...groups.values()];
  if (prioritizeByType) {
    groupArray.sort((a, b) => b.priority - a.priority);
  }
  
  return groupArray.map(({ type, priority, operations }) => ({ type, priority, operations }));
}

/**
 * Build optimized transaction batches with advanced compression and grouping.
 * Supports multiple operation types, priority-based ordering, and adaptive batch sizing.
 */
export function createBatchPlan(operations, options = {}) {
  const stage = rolloutStage(options.stage);
  const groups = groupBatchOperations(operations, options);
  const optimalSize = calculateOptimalBatchSize(operations, options.maxBatchSize);
  
  const batches = [];
  
  for (const { type, priority, operations: grouped } of groups) {
    // Split large groups into multiple batches based on optimal size
    for (let i = 0; i < grouped.length; i += optimalSize) {
      const chunk = grouped.slice(i, i + optimalSize);
      const envelope = compressXdrBatch(chunk);
      
      batches.push({ 
        type, 
        priority,
        count: chunk.length, 
        envelope, 
        savings: compressionSavings(envelope),
        batchIndex: Math.floor(i / optimalSize),
        totalBatches: Math.ceil(grouped.length / optimalSize)
      });
    }
  }
  
  const totalOriginalBytes = batches.reduce((sum, batch) => sum + batch.envelope.originalBytes, 0);
  const totalCompressedBytes = batches.reduce((sum, batch) => sum + batch.envelope.compressedBytes, 0);
  
  return {
    enabled: shouldBatch({ requested: options.requested, operationCount: operations.length, stage }),
    stage,
    operationCount: operations.length,
    batches,
    totalOriginalBytes,
    totalCompressedBytes,
    overallSavings: totalOriginalBytes > 0 
      ? Number((1 - totalCompressedBytes / totalOriginalBytes).toFixed(4))
      : 0,
    optimalBatchSize: optimalSize,
    statistics: {
      batchCount: batches.length,
      avgBatchSize: batches.length > 0 ? Math.round(operations.length / batches.length) : 0,
      avgCompressionRatio: batches.length > 0 
        ? batches.reduce((sum, b) => sum + b.envelope.ratio, 0) / batches.length 
        : 0,
      priorityDistribution: calculatePriorityDistribution(batches)
    }
  };
}

function calculatePriorityDistribution(batches) {
  const distribution = { critical: 0, high: 0, medium: 0, low: 0 };
  
  for (const batch of batches) {
    switch (batch.priority) {
      case BATCH_PRIORITIES.CRITICAL: distribution.critical += batch.count; break;
      case BATCH_PRIORITIES.HIGH: distribution.high += batch.count; break;
      case BATCH_PRIORITIES.MEDIUM: distribution.medium += batch.count; break;
      case BATCH_PRIORITIES.LOW: distribution.low += batch.count; break;
    }
  }
  
  return distribution;
}
