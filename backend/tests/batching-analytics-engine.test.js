import { describe, expect, test } from "@jest/globals";
import { compressXdrBatch, decompressXdrBatch, compressionSavings } from "../src/services/xdr-compressor.js";
import { createBatchPlan, groupBatchOperations, shouldBatch } from "../src/services/tx-batcher.js";
import { detectAnalyticsAnomalies } from "../src/services/anomaly-detection.js";

describe("transaction batching and analytics primitives", () => {
  test("compression is lossless and reports savings", () => {
    const operations = Array.from({ length: 20 }, (_, i) => ({ type: "distribute", contractId: `C${i}`, xdr: "AAAA".repeat(120) }));
    const envelope = compressXdrBatch(operations);
    expect(decompressXdrBatch(envelope)).toEqual(operations.map((operation) => ({ ...operation, metadata: null })));
    expect(compressionSavings(envelope)).toBeGreaterThan(0);
  });

  test("groups operations by type and plans optional rollout", () => {
    const operations = [
      { type: "distribute", contractId: "a", xdr: "x" },
      { type: "secondary", contractId: "b", xdr: "y" },
      { type: "distribute", contractId: "c", xdr: "z" },
    ];
    expect(groupBatchOperations(operations).map((group) => [group.type, group.operations.length])).toEqual([["distribute", 2], ["secondary", 1]]);
    expect(shouldBatch({ requested: true, operationCount: 3, stage: "optional" })).toBe(true);
    expect(createBatchPlan(operations, { requested: true }).batches).toHaveLength(2);
  });

  test("detects volume, error-rate, and zero-earnings anomalies", () => {
    const history = [1, 1, 1].map((count, i) => ({ bucket: `2025-01-0${i + 1}`, distributionCount: count, failedCount: 0, collaboratorEarnings: 10 }));
    const anomalies = detectAnalyticsAnomalies([...history, { bucket: "2025-01-04", distributionCount: 5, failedCount: 1, collaboratorEarnings: 0 }]);
    expect(anomalies.map((anomaly) => anomaly.type)).toEqual(expect.arrayContaining(["volume_spike", "error_rate_spike", "zero_collaborator_earnings"]));
  });
});
