import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptField, encryptField, fieldBlindIndex } from "../src/crypto/encryption.js";
import { KeyManager, KEY_ROTATION_INTERVAL_MS } from "../src/services/key-manager.js";

const CONTRACT_ID = "C123456789";
const FIELD = "distribution_payouts.amountReceived";

describe("field encryption", () => {
  test("uses authenticated AES-GCM ciphertext scoped to a contract and field", () => {
    const ciphertext = encryptField("21.5000000", CONTRACT_ID, FIELD);

    expect(ciphertext).not.toContain("21.5000000");
    expect(decryptField(ciphertext, CONTRACT_ID, FIELD)).toBe("21.5000000");
    expect(() => decryptField(ciphertext, "C987654321", FIELD)).toThrow();
    expect(() => decryptField(ciphertext, CONTRACT_ID, "another.field")).toThrow();

    const envelope = JSON.parse(Buffer.from(ciphertext.slice("enc:v1:".length), "base64url").toString());
    const tamperedBytes = Buffer.from(envelope.data, "base64url");
    tamperedBytes[0] ^= 1;
    envelope.data = tamperedBytes.toString("base64url");
    const tampered = `enc:v1:${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
    expect(() => decryptField(tampered, CONTRACT_ID, FIELD)).toThrow(/authentication failed/);
  });

  test("creates contract-scoped equality indexes", () => {
    const index = fieldBlindIndex("21.5000000", CONTRACT_ID, FIELD);
    expect(index).toBe(fieldBlindIndex("21.5000000", CONTRACT_ID, FIELD));
    expect(index).not.toBe(fieldBlindIndex("21.5000000", "C987654321", FIELD));
    expect(index).not.toBe(fieldBlindIndex("21.5000001", CONTRACT_ID, FIELD));
  });

  test("rotates Vault keys every 90 days without re-encrypting old fields", async () => {
    let now = Date.UTC(2025, 0, 1);
    let keyring = null;
    let casVersion = 0;
    const fetchImpl = async (_url, options = {}) => {
      if (!options.method) {
        return keyring
          ? { ok: true, status: 200, json: async () => ({ data: { data: keyring, metadata: { version: casVersion } } }) }
          : { ok: false, status: 404 };
      }
      const request = JSON.parse(options.body);
      if (request.options.cas !== casVersion) return { ok: false, status: 409 };
      keyring = request.data;
      casVersion += 1;
      return { ok: true, status: 200, json: async () => ({ data: { version: casVersion } }) };
    };
    const manager = new KeyManager({
      env: {
        NODE_ENV: "test",
        VAULT_ADDR: "https://vault.example.test",
        VAULT_TOKEN: "test-token",
        FIELD_ENCRYPTION_VAULT_PATH: "secret/data/stellar/field-encryption",
      },
      fetchImpl,
      now: () => now,
    });

    await manager.initialize();
    const oldCiphertext = encryptField("10.25", CONTRACT_ID, FIELD, manager);
    const oldIndex = fieldBlindIndex("10.25", CONTRACT_ID, FIELD, manager);
    now += KEY_ROTATION_INTERVAL_MS + 1;
    await manager.rotateIfDue();
    const newCiphertext = encryptField("11.75", CONTRACT_ID, FIELD, manager);

    expect(manager.getCurrentVersion()).toBe(2);
    expect(decryptField(oldCiphertext, CONTRACT_ID, FIELD, manager)).toBe("10.25");
    expect(decryptField(newCiphertext, CONTRACT_ID, FIELD, manager)).toBe("11.75");
    expect(fieldBlindIndex("10.25", CONTRACT_ID, FIELD, manager)).toBe(oldIndex);
  });
});

describe("encrypted payout storage", () => {
  let databaseDirectory;
  let databaseResult;

  beforeAll(() => {
    databaseDirectory = mkdtempSync(path.join(tmpdir(), "srs-encrypted-payouts-"));
    const databasePath = path.join(databaseDirectory, "test.sqlite");
    const script = `
      import Database from "better-sqlite3";
      process.env.NODE_ENV = "test";
      const legacyDb = new Database(process.env.DATABASE_PATH);
      legacyDb.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); " +
        "CREATE TABLE transactions (id INTEGER PRIMARY KEY, contractId TEXT NOT NULL); " +
        "CREATE TABLE distribution_payouts (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, transactionId INTEGER NOT NULL, " +
        "contractId TEXT NOT NULL DEFAULT '', collaboratorAddress TEXT NOT NULL, " +
        "amountReceived TEXT NOT NULL, FOREIGN KEY(transactionId) " +
        "REFERENCES transactions(id) ON DELETE CASCADE)"
      );
      const markApplied = legacyDb.prepare("INSERT INTO schema_migrations(version) VALUES (?)");
      for (let version = 1; version <= 24; version += 1) markApplied.run(version);
      legacyDb.prepare("INSERT INTO transactions(id, contractId) VALUES (1, ?)").run("${CONTRACT_ID}");
      legacyDb.prepare(
        "INSERT INTO distribution_payouts(transactionId, contractId, collaboratorAddress, amountReceived) " +
        "VALUES (1, ?, ?, ?)"
      ).run("", "GABC", "12.345");
      legacyDb.close();

      const { db, initializeDatabase } = await import("./src/database/core.js");
      initializeDatabase();
      const { findPayoutsByAmount } = await import("./src/database/transactions.js");
      const stored = db.prepare(
        "SELECT amountReceived, amountReceivedHash FROM distribution_payouts_encrypted WHERE id = 1"
      ).get();
      const visible = db.prepare(
        "SELECT amountReceived, contractId FROM distribution_payouts WHERE id = 1"
      ).get();
      db.prepare(
        "INSERT INTO distribution_payouts(transactionId, contractId, collaboratorAddress, amountReceived) " +
        "VALUES (1, ?, ?, ?)"
      ).run("${CONTRACT_ID}", "GDEF", "2.655");
      const total = db.prepare(
        "SELECT SUM(CAST(amountReceived AS REAL)) AS total FROM distribution_payouts"
      ).get().total;
      const indexed = db.prepare(
        "SELECT id FROM distribution_payouts_encrypted WHERE contractId = ? AND amountReceivedHash = ?"
      ).get("${CONTRACT_ID}", "${fieldBlindIndex("2.655", CONTRACT_ID, FIELD)}");
      const lookedUp = findPayoutsByAmount("${CONTRACT_ID}", "2.655");
      db.close();
      console.log(JSON.stringify({
        storedCiphertext: stored.amountReceived,
        storedHash: stored.amountReceivedHash,
        visibleAmount: visible.amountReceived,
        visibleContractId: visible.contractId,
        total,
        indexed: Boolean(indexed),
        lookedUpAmount: lookedUp[0]?.amountReceived,
      }));
    `;
    const backendDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: backendDirectory,
      env: { ...process.env, NODE_ENV: "test", DATABASE_PATH: databasePath },
      encoding: "utf8",
    });
    databaseResult = JSON.parse(output.trim());
  });

  afterAll(() => {
    if (databaseDirectory) rmSync(databaseDirectory, { recursive: true, force: true });
  });

  test("encrypts legacy and new payout values while preserving reads and aggregates", () => {
    expect(databaseResult.storedCiphertext).not.toBe("12.345");
    expect(databaseResult.storedHash).toBe(fieldBlindIndex("12.345", CONTRACT_ID, FIELD));
    expect(databaseResult.visibleAmount).toBe("12.345");
    expect(databaseResult.visibleContractId).toBe("");
    expect(databaseResult.total).toBeCloseTo(15);
    expect(databaseResult.indexed).toBe(true);
    expect(databaseResult.lookedUpAmount).toBe("2.655");
  });
});