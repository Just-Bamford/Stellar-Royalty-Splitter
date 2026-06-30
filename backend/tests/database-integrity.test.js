/**
 * Issue #395: Database Write-Ahead Logging & Integrity Verification Tests
 * Tests for audit log hash chain integrity verification
 */

import { describe, it, beforeEach, afterEach } from "@jest/globals";
import assert from "node:assert";
import { db, initializeDatabase, verifyAuditLogIntegrity, computeAuditEntryHash } from "../src/database/core.js";
import { addAuditLog, getAuditLog } from "../src/database/audit.js";

const CONTRACT = `C${"A".repeat(55)}`;
const OTHER_CONTRACT = `C${"B".repeat(55)}`;

describe("Database Integrity Verification (Issue #395)", () => {
  beforeEach(() => {
    initializeDatabase();
    db.prepare("DELETE FROM audit_log").run();
  });

  afterEach(() => {
    db.prepare("DELETE FROM audit_log").run();
  });

  describe("Hash Computation", () => {
    it("should compute consistent hash for same input", () => {
      const hash1 = computeAuditEntryHash(
        "contract123",
        "distribute",
        "user1",
        '{"amount": "100"}',
        "2024-01-01T00:00:00.000Z",
        null
      );
      const hash2 = computeAuditEntryHash(
        "contract123",
        "distribute",
        "user1",
        '{"amount": "100"}',
        "2024-01-01T00:00:00.000Z",
        null
      );
      assert.strictEqual(hash1, hash2);
    });

    it("should compute different hashes for different inputs", () => {
      const hash1 = computeAuditEntryHash(
        "contract123",
        "distribute",
        "user1",
        '{"amount": "100"}',
        "2024-01-01T00:00:00.000Z",
        null
      );
      const hash2 = computeAuditEntryHash(
        "contract123",
        "distribute",
        "user2",
        '{"amount": "100"}',
        "2024-01-01T00:00:00.000Z",
        null
      );
      assert.notStrictEqual(hash1, hash2);
    });

    it("should include prev_hash in hash computation", () => {
      const hash1 = computeAuditEntryHash(
        "contract123",
        "distribute",
        "user1",
        '{"amount": "100"}',
        "2024-01-01T00:00:00.000Z",
        null
      );
      const hash2 = computeAuditEntryHash(
        "contract123",
        "distribute",
        "user1",
        '{"amount": "100"}',
        "2024-01-01T00:00:00.000Z",
        "abc123"
      );
      assert.notStrictEqual(hash1, hash2);
    });
  });

  describe("Audit Log Hash Chain", () => {
    it("should create first entry with null prev_hash", () => {
      addAuditLog(CONTRACT, "initialize", "admin", { collaborators: ["user1", "user2"] });
      
      const logs = getAuditLog(CONTRACT);
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0].prev_hash, null);
      assert.strictEqual(typeof logs[0].entry_hash, "string");
      assert.strictEqual(logs[0].entry_hash.length, 64); // SHA-256 hex string
    });

    it("should chain subsequent entries with prev_hash", () => {
      addAuditLog(CONTRACT, "initialize", "admin", { collaborators: ["user1", "user2"] });
      addAuditLog(CONTRACT, "distribute", "user1", { amount: "100" });
      
      const logs = getAuditLog(CONTRACT);
      assert.strictEqual(logs.length, 2);
      
      // First entry should have null prev_hash
      assert.strictEqual(logs[1].prev_hash, null);
      
      // Second entry should have prev_hash matching first entry's entry_hash
      assert.strictEqual(logs[0].prev_hash, logs[1].entry_hash);
    });

    it("should maintain hash chain across multiple entries", () => {
      const actions = ["initialize", "distribute", "distribute", "secondary_royalty"];
      
      actions.forEach((action, i) => {
        addAuditLog(CONTRACT, action, "user1", { step: i });
      });
      
      const logs = getAuditLog(CONTRACT);
      assert.strictEqual(logs.length, 4);
      
      // Verify chain: each entry's prev_hash should match previous entry's entry_hash
      for (let i = 0; i < logs.length - 1; i++) {
        assert.strictEqual(logs[i].prev_hash, logs[i + 1].entry_hash);
      }
    });
  });

  describe("Integrity Verification", () => {
    it("should pass verification for valid audit log", () => {
      addAuditLog(CONTRACT, "initialize", "admin", { collaborators: ["user1"] });
      addAuditLog(CONTRACT, "distribute", "user1", { amount: "100" });
      
      const result = verifyAuditLogIntegrity(CONTRACT);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.brokenAt, null);
      assert.strictEqual(result.error, null);
    });

    it("should pass verification for empty audit log", () => {
      const result = verifyAuditLogIntegrity(CONTRACT);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.brokenAt, null);
      assert.strictEqual(result.error, null);
    });

    it("should detect broken hash chain", () => {
      addAuditLog(CONTRACT, "initialize", "admin", { collaborators: ["user1"] });
      addAuditLog(CONTRACT, "distribute", "user1", { amount: "100" });

      const logs = getAuditLog(CONTRACT);
      const newestLog = logs[0];

      // Manually break the chain by updating prev_hash
      db.prepare("UPDATE audit_log SET prev_hash = ? WHERE id = ?").run("fake_hash", newestLog.id);

      const result = verifyAuditLogIntegrity(CONTRACT);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.brokenAt, newestLog.id);
      assert(result.error.includes("Hash chain broken"));
    });

    it("should detect tampered entry hash", () => {
      addAuditLog(CONTRACT, "initialize", "admin", { collaborators: ["user1"] });
      addAuditLog(CONTRACT, "distribute", "user1", { amount: "100" });

      const logs = getAuditLog(CONTRACT);
      const oldestLog = logs[logs.length - 1];

      // Manually tamper with entry_hash
      db.prepare("UPDATE audit_log SET entry_hash = ? WHERE id = ?").run("tampered_hash", oldestLog.id);

      const result = verifyAuditLogIntegrity(CONTRACT);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.brokenAt, oldestLog.id);
      assert(result.error.includes("Hash mismatch"));
    });

    it("should verify integrity across all contracts when contractId is null", () => {
      addAuditLog(CONTRACT, "initialize", "admin", { collaborators: ["user1"] });
      addAuditLog(OTHER_CONTRACT, "initialize", "admin", { collaborators: ["user2"] });
      addAuditLog(CONTRACT, "distribute", "user1", { amount: "100" });
      
      const result = verifyAuditLogIntegrity(); // No contractId - verify all
      assert.strictEqual(result.valid, true);
    });
  });

  describe("WAL Mode", () => {
    it("should have WAL mode enabled", () => {
      const result = db.pragma("journal_mode", { simple: true });
      assert.strictEqual(result, "wal");
    });

    it("should have synchronous mode set to NORMAL", () => {
      const result = db.pragma("synchronous", { simple: true });
      assert.strictEqual(result, 1); // 1 = NORMAL in SQLite
    });
  });

  describe("Migration", () => {
    it("should apply migration version 4 for hash columns", () => {
      const version = db.prepare("SELECT version FROM schema_migrations WHERE version = 4").get();
      assert.strictEqual(version.version, 4);
    });

    it("should have entry_hash and prev_hash columns in audit_log", () => {
      const columns = db.prepare("PRAGMA table_info(audit_log)").all();
      const columnNames = columns.map(col => col.name);
      assert(columnNames.includes("entry_hash"));
      assert(columnNames.includes("prev_hash"));
    });
  });
});
