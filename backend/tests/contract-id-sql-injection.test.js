import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { db, initializeDatabase } from "../src/database/core.js";
import { assertValidContractId } from "../src/contract-id.js";
import {
  addDistributionPayout,
  getTransactionCount,
  getTransactionHistory,
  recordTransaction,
} from "../src/database/transactions.js";
import { addAuditLog, exportAuditLogs, getAuditLog } from "../src/database/audit.js";
import {
  countSecondarySales,
  getSecondarySales,
  recordSecondarySale,
} from "../src/database/secondary-royalties.js";
import { listWebhooks, registerWebhook } from "../src/database/webhooks.js";
import { recordNonceIfNew } from "../src/database/request-nonces.js";
import { searchIndexedEvents } from "../src/routes/eventDatabase.js";

const CONTRACT = `C${"A".repeat(55)}`;
const OTHER_CONTRACT = `C${"B".repeat(55)}`;
const WALLET = `G${"A".repeat(55)}`;
const COLLABORATOR = `G${"B".repeat(55)}`;
const TOKEN = `C${"C".repeat(55)}`;

const INJECTION_ATTEMPTS = [
  `${CONTRACT}' OR '1'='1`,
  `${CONTRACT}'; DROP TABLE transactions; --`,
  `${CONTRACT}" UNION SELECT * FROM audit_log --`,
  `${CONTRACT}) OR 1=1 --`,
  `${CONTRACT}\nOR contractId = '${OTHER_CONTRACT}'`,
  "C'; DELETE FROM secondary_sales; --",
];

function resetTables() {
  db.prepare("DELETE FROM indexed_events").run();
  db.prepare("DELETE FROM request_nonces").run();
  db.prepare("DELETE FROM webhook_dead_letters").run();
  db.prepare("DELETE FROM webhooks").run();
  db.prepare("DELETE FROM secondary_royalty_distributions").run();
  db.prepare("DELETE FROM secondary_sales").run();
  db.prepare("DELETE FROM distribution_payouts").run();
  db.prepare("DELETE FROM transactions").run();
  db.prepare("DELETE FROM audit_log").run();
}

function seedRows() {
  const txId = recordTransaction(CONTRACT, "distribute", WALLET, {
    requestedAmount: "100",
    tokenId: TOKEN,
  });
  addDistributionPayout(txId, CONTRACT, COLLABORATOR, "100");
  addAuditLog(CONTRACT, "contract_initialized", WALLET, { collaborators: [COLLABORATOR] });
  recordSecondarySale(CONTRACT, "nft-1", WALLET, COLLABORATOR, 1000, TOKEN, 50, 500);
  registerWebhook(CONTRACT, "https://example.com/hook");
  recordNonceIfNew(CONTRACT, "9a7a4ec5-7c52-4a95-b24e-87d41dbbefcc");
  db.prepare(`
    INSERT INTO indexed_events (event_id, ledger_sequence, transaction_hash, event_index, timestamp, contract_id, event_type, event_data, raw_event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("evt-1", 1, "a".repeat(64), 0, "2026-06-30T00:00:00.000Z", CONTRACT, "distribute", "{}", "{}");
}

describe("contract ID SQL injection defenses (#507)", () => {
  beforeEach(() => {
    initializeDatabase();
    resetTables();
    seedRows();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetTables();
  });

  test("accepts a strict Stellar contract ID", () => {
    expect(assertValidContractId(CONTRACT)).toBe(CONTRACT);
  });

  test.each(INJECTION_ATTEMPTS)("rejects injected contract ID before preparing SQL: %s", (payload) => {
    const prepareSpy = jest.spyOn(db, "prepare");

    expect(() => getTransactionHistory(payload)).toThrow("Invalid contract ID format");
    expect(() => getTransactionCount(payload)).toThrow("Invalid contract ID format");
    expect(() => getAuditLog(payload)).toThrow("Invalid contract ID format");
    expect(() => exportAuditLogs({ contractId: payload })).toThrow("Invalid contract ID format");
    expect(() => getSecondarySales(payload)).toThrow("Invalid contract ID format");
    expect(() => countSecondarySales(payload)).toThrow("Invalid contract ID format");
    expect(() => listWebhooks(payload)).toThrow("Invalid contract ID format");
    expect(() => searchIndexedEvents(payload)).toThrow("Invalid contract ID format");

    expect(prepareSpy).not.toHaveBeenCalled();
  });

  test.each(INJECTION_ATTEMPTS)("rejects injected contract ID on writes without mutating data: %s", (payload) => {
    expect(() => recordTransaction(payload, "distribute", WALLET, { requestedAmount: "1", tokenId: TOKEN })).toThrow(
      "Invalid contract ID format"
    );
    expect(() => addDistributionPayout(1, payload, COLLABORATOR, "1")).toThrow("Invalid contract ID format");
    expect(() => addAuditLog(payload, "injected", WALLET, {})).toThrow("Invalid contract ID format");
    expect(() => recordSecondarySale(payload, "nft-2", WALLET, COLLABORATOR, 1000, TOKEN, 50, 500)).toThrow(
      "Invalid contract ID format"
    );
    expect(() => registerWebhook(payload, "https://example.com/injected")).toThrow("Invalid contract ID format");
    expect(() => recordNonceIfNew(payload, "63bbca73-2e48-41ec-ab85-c18cd998577f")).toThrow(
      "Invalid contract ID format"
    );

    expect(db.prepare("SELECT COUNT(*) AS total FROM transactions").get().total).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS total FROM audit_log").get().total).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS total FROM secondary_sales").get().total).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS total FROM webhooks").get().total).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS total FROM request_nonces").get().total).toBe(1);
  });
});
