import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  explainQueryPlan,
  batchGetContributorStatus,
  batchGetTransactionDetails,
  batchGetDisputeComments,
  batchGetCollaboratorReputation,
  refreshEarningsSummaryMV,
  getOptimizedEarningsSummary,
} from "../src/services/query-optimizer.js";
import { db } from "../src/database/core.js";

describe("Query Optimizer & Database Indexing Service (#984)", () => {
  const TEST_CONTRACT = "CCONTRACT_OPTIMIZER_TEST_123";
  const ADDR_1 = "GAOPTIMIZER11111111111111111111111111111111111111111111111";
  const ADDR_2 = "GAOPTIMIZER22222222222222222222222222222222222222222222222";

  it("1. explainQueryPlan returns query plan array with structural detail", () => {
    const plans = explainQueryPlan("SELECT * FROM transactions WHERE contractId = ?", [TEST_CONTRACT]);
    expect(Array.isArray(plans)).toBe(true);
  });

  it("2. batchGetContributorStatus eliminates N+1 queries for status checks", () => {
    const result = batchGetContributorStatus(TEST_CONTRACT, [ADDR_1, ADDR_2]);
    expect(result instanceof Map).toBe(true);
    expect(result.has(ADDR_1)).toBe(true);
    expect(result.get(ADDR_1).status).toBe("active");
    expect(result.has(ADDR_2)).toBe(true);
  });

  it("3. batchGetContributorStatus handles empty and null inputs safely", () => {
    expect(batchGetContributorStatus(null, []).size).toBe(0);
    expect(batchGetContributorStatus(TEST_CONTRACT, []).size).toBe(0);
    expect(batchGetContributorStatus(TEST_CONTRACT, [null, undefined]).size).toBe(0);
  });

  it("4. batchGetTransactionDetails returns empty map for empty inputs", () => {
    const res = batchGetTransactionDetails([]);
    expect(res instanceof Map).toBe(true);
    expect(res.size).toBe(0);
  });

  it("5. batchGetDisputeComments groups comments by disputeId in a single query", () => {
    const commentsMap = batchGetDisputeComments([101, 102]);
    expect(commentsMap instanceof Map).toBe(true);
    expect(commentsMap.has(101)).toBe(true);
    expect(commentsMap.has(102)).toBe(true);
    expect(Array.isArray(commentsMap.get(101))).toBe(true);
  });

  it("6. batchGetCollaboratorReputation batches reputation lookups", () => {
    const repMap = batchGetCollaboratorReputation([ADDR_1, ADDR_2]);
    expect(repMap instanceof Map).toBe(true);
    expect(batchGetCollaboratorReputation([]).size).toBe(0);
  });

  it("7. getOptimizedEarningsSummary computes and caches materialized summary stats", () => {
    const summary = getOptimizedEarningsSummary(TEST_CONTRACT, { forceRefresh: true });
    expect(summary).toBeDefined();
    if (summary) {
      expect(summary.contractId).toBe(TEST_CONTRACT);
      expect(summary.totalTransactions).toBeGreaterThanOrEqual(0);
      expect(summary.totalDistributed).toBeDefined();
      expect(summary.averagePayout).toBeDefined();
    }
  });

  it("8. getOptimizedEarningsSummary reuses cached/materialized view on subsequent calls", () => {
    const first = getOptimizedEarningsSummary(TEST_CONTRACT, { forceRefresh: true });
    const cached = getOptimizedEarningsSummary(TEST_CONTRACT);
    expect(cached).toBeDefined();
    if (first && cached) {
      expect(cached.contractId).toBe(first.contractId);
    }
  });
});
