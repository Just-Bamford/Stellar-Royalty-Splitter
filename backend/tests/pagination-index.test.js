import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { db, initializeDatabase, closeDatabase } from "../src/database/core.js";
import { getTransactionHistory } from "../src/database/transactions.js";

describe("Pagination Composite Index (#461)", () => {
  beforeAll(() => {
    // ensure DB is initialized
    initializeDatabase();
  });

  afterAll(() => {
    closeDatabase();
  });

  test("EXPLAIN QUERY PLAN shows index usage for pagination query", () => {
    const explain = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT 
        t.id, t.txHash, t.contractId, t.type, t.initiatorAddress, t.requestedAmount, t.tokenId, t.timestamp, t.blockTime, t.status, t.errorMessage,
        COUNT(dp.id) as payoutCount
      FROM transactions t
      LEFT JOIN distribution_payouts dp ON t.id = dp.transactionId
      WHERE t.contractId = ?
      GROUP BY t.id
      ORDER BY t.timestamp DESC
      LIMIT ? OFFSET ?
    `).all("C123", 50, 0);

    const plan = JSON.stringify(explain);
    // SQLite should use the idx_transactions_contractId_timestamp_desc index
    expect(plan).toMatch(/idx_transactions_contractId_timestamp_desc/);
  });

  test("Pagination performance regression with 10k+ rows", () => {
    const contractId = "CBENCHMARK10K";
    db.prepare("BEGIN TRANSACTION").run();
    
    // insert 10,000 rows
    const insertTx = db.prepare(`
      INSERT INTO transactions (contractId, type, initiatorAddress, status, timestamp) 
      VALUES (?, 'initialize', 'G123', 'confirmed', datetime('now', '-' || ? || ' seconds'))
    `);
    
    for (let i = 0; i < 10000; i++) {
      insertTx.run(contractId, i);
    }
    db.prepare("COMMIT").run();

    const start = performance.now();
    const results = getTransactionHistory(contractId, 50, 9500);
    const end = performance.now();

    const duration = end - start;
    expect(results.length).toBe(50);
    expect(duration).toBeLessThan(100); // ms
  });
});
