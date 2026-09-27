import { gzipSync, gunzipSync } from "node:zlib";

const MAGIC = "SRS-XDR-BATCH-1";

/**
 * Lossless transport envelope for batches of unsigned XDR operations. Stellar
 * still signs/submits the individual operation payloads; compression is for
 * queued transport and storage, never a substitute for a valid transaction.
 */
export function compressXdrBatch(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError("operations must be a non-empty array");
  }
  const normalized = operations.map((operation) => ({
    type: String(operation.type ?? "distribute"),
    contractId: String(operation.contractId ?? ""),
    xdr: String(operation.xdr ?? ""),
    metadata: operation.metadata ?? null,
  }));
  
  // Advanced compression: extract common fields to reduce redundancy
  const commonContractId = normalized.every(op => op.contractId === normalized[0].contractId) 
    ? normalized[0].contractId 
    : null;
  
  const optimized = normalized.map(op => {
    const optimizedOp = { ...op };
    // Remove common contract ID from individual operations
    if (commonContractId && op.contractId === commonContractId) {
      delete optimizedOp.contractId;
    }
    // Remove null metadata to save space
    if (optimizedOp.metadata === null) {
      delete optimizedOp.metadata;
    }
    return optimizedOp;
  });
  
  const payload = Buffer.from(JSON.stringify({ 
    magic: MAGIC, 
    operations: optimized,
    common: commonContractId ? { contractId: commonContractId } : {}
  }), "utf8");
  
  const compressed = gzipSync(payload, { level: 9, mtime: 0 });
  return {
    encoding: "gzip+json",
    data: compressed.toString("base64"),
    originalBytes: payload.byteLength,
    compressedBytes: compressed.byteLength,
    ratio: Number((compressed.byteLength / payload.byteLength).toFixed(4)),
  };
}

export function decompressXdrBatch(envelope) {
  if (!envelope || envelope.encoding !== "gzip+json" || typeof envelope.data !== "string") {
    throw new TypeError("invalid XDR compression envelope");
  }
  const parsed = JSON.parse(gunzipSync(Buffer.from(envelope.data, "base64")).toString("utf8"));
  if (parsed.magic !== MAGIC || !Array.isArray(parsed.operations)) {
    throw new Error("invalid XDR batch payload");
  }
  
  // Restore common fields
  const commonContractId = parsed.common?.contractId;
  const operations = parsed.operations.map(op => ({
    ...op,
    contractId: op.contractId ?? commonContractId ?? "",
    metadata: op.metadata ?? null
  }));
  
  return operations;
}

export function compressionSavings(envelope) {
  if (!envelope || envelope.originalBytes <= 0) return 0;
  return Number((1 - envelope.compressedBytes / envelope.originalBytes).toFixed(4));
}

/**
 * Calculate optimal batch size based on operation count and estimated XDR size
 */
export function calculateOptimalBatchSize(operations, maxBatchSize = 100) {
  const avgXdrSize = operations.reduce((sum, op) => sum + (op.xdr?.length || 500), 0) / operations.length;
  const estimatedTotalSize = avgXdrSize * operations.length;
  
  // Target batch size: balance between compression efficiency and processing overhead
  // Larger batches = better compression, but longer processing time
  const TARGET_BATCH_SIZE_KB = 50; // 50KB per batch
  const optimalCount = Math.ceil(TARGET_BATCH_SIZE_KB * 1024 / avgXdrSize);
  
  return Math.min(Math.max(optimalCount, 10), maxBatchSize);
}
