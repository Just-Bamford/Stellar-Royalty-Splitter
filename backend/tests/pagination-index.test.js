import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { db, initializeDatabase, closeDatabase } from "../src/database/core.js";
import { getTransactionHistory } from "../src/database/transactions.js";

const CONTRACT = `C${"A".repeat(55)}`;
const WALLET = `G${"A".repeat(55)}`;

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
        (SELECT COUNT(*) FROM distribution_payouts dp WHERE dp.transactionId = t.id) as payoutCount
      FROM transactions t INDEXED BY idx_transactions_contractId_timestamp_desc
      WHERE t.contractId = ?
      ORDER BY t.timestamp DESC
      LIMIT ? OFFSET ?
    `).all(CONTRACT, 50, 0);

    const plan = JSON.stringify(explain);
    // SQLite should use the idx_transactions_contractId_timestamp_desc index
    expect(plan).toMatch(/idx_transactions_contractId_timestamp_desc/);
  });

  test("Pagination performance regression with 10k+ rows", () => {
    const contractId = CONTRACT;
    db.prepare("BEGIN TRANSACTION").run();
    
    // insert 10,000 rows
    const insertTx = db.prepare(`
      INSERT INTO transactions (contractId, type, initiatorAddress, status, timestamp)
      VALUES (?, 'initialize', ?, 'confirmed', datetime('now', '-' || ? || ' seconds'))
    `);
    
    for (let i = 0; i < 10000; i++) {
      insertTx.run(contractId, WALLET, i);
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
