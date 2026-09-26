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
  const payload = Buffer.from(JSON.stringify({ magic: MAGIC, operations: normalized }), "utf8");
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
  return parsed.operations;
}

export function compressionSavings(envelope) {
  if (!envelope || envelope.originalBytes <= 0) return 0;
  return Number((1 - envelope.compressedBytes / envelope.originalBytes).toFixed(4));
}
