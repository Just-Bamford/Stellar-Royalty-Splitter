/**
 * Unit tests for the pure M-of-N logic in multisig-manager (#1042).
 *
 * Only the I/O-free helpers are exercised here, so no database is required and
 * the tests run deterministically. DB-backed validation throws are tested on
 * the `createMultisigProposal` guard path (it rejects before touching the DB).
 */

import { describe, it, expect } from "@jest/globals";
import {
  isCriticalOperation,
  CRITICAL_OPERATIONS,
  verifySignatures,
  isThresholdMet,
  missingSigners,
  createMultisigProposal,
  resolveThreshold,
  DEFAULT_THRESHOLD,
} from "../src/services/multisig-manager.js";

describe("multisig-manager: isCriticalOperation", () => {
  it.each(["pause_contract", "change_royalty_rate", "remove_collaborator", "upgrade_contract", "change_admin_list"])(
    "flags %s as critical",
    (op) => {
      expect(isCriticalOperation(op)).toBe(true);
    },
  );

  it.each(["distribute", "update_share", "withdraw", "claim_vested_shares"])(
    "flags %s as non-critical",
    (op) => {
      expect(isCriticalOperation(op)).toBe(false);
    },
  );

  it("exposes the full critical-operations set", () => {
    expect(CRITICAL_OPERATIONS.size).toBe(5);
  });
});

describe("multisig-manager: verifySignatures", () => {
  const signers = ["admin-1", "admin-2", "admin-3"];

  it("counts distinct valid signatures", () => {
    const result = verifySignatures(signers, [
      { signer: "admin-1", signature: "s1" },
      { signer: "admin-2", signature: "s2" },
    ]);
    expect(result.validSignatureCount).toBe(2);
    expect(result.signers).toEqual(["admin-1", "admin-2"]);
  });

  it("rejects signatures from unknown signers", () => {
    const result = verifySignatures(signers, [
      { signer: "admin-1", signature: "s1" },
      { signer: "rogue", signature: "sX" },
    ]);
    expect(result.validSignatureCount).toBe(1);
    expect(result.signers).toEqual(["admin-1"]);
  });

  it("collapses duplicate signatures from the same signer", () => {
    const result = verifySignatures(signers, [
      { signer: "admin-1", signature: "s1a" },
      { signer: "admin-1", signature: "s1b" },
      { signer: "admin-2", signature: "s2" },
    ]);
    expect(result.validSignatureCount).toBe(2);
  });

  it("returns zero for empty inputs", () => {
    expect(verifySignatures([], []).validSignatureCount).toBe(0);
    expect(verifySignatures(null, null).validSignatureCount).toBe(0);
  });
});

describe("multisig-manager: isThresholdMet", () => {
  it("requires at least M distinct signatures", () => {
    expect(isThresholdMet(2, 1)).toBe(false);
    expect(isThresholdMet(2, 2)).toBe(true);
    expect(isThresholdMet(3, 3)).toBe(true);
  });

  it("never blocks when threshold is 1", () => {
    expect(isThresholdMet(1, 0)).toBe(false);
    expect(isThresholdMet(1, 1)).toBe(true);
  });

  it("treats a missing threshold as 0 (no valid threshold set)", () => {
    expect(isThresholdMet(undefined, 0)).toBe(false);
    expect(isThresholdMet(null, 5)).toBe(false);
  });
});

describe("multisig-manager: missingSigners", () => {
  it("lists authorized signers who have not yet signed", () => {
    const result = missingSigners(["a", "b", "c"], [{ signer: "b" }]);
    expect(result.sort()).toEqual(["a", "c"]);
  });

  it("returns an empty list once the threshold is satisfied", () => {
    const required = ["a", "b", "c"];
    const sigs = [{ signer: "a" }, { signer: "b" }, { signer: "c" }];
    expect(missingSigners(required, sigs)).toEqual([]);
  });
});

describe("multisig-manager: createMultisigProposal validation", () => {
  it("throws when operation is missing", () => {
    expect(() => createMultisigProposal({ requiredSigners: ["a"] })).toThrow(
      "operation is required",
    );
  });

  it("throws when no required signers are supplied", () => {
    expect(() => createMultisigProposal({ operation: "pause_contract" })).toThrow(
      "requiredSigners must be a non-empty array",
    );
    expect(() =>
      createMultisigProposal({ operation: "pause_contract", requiredSigners: [] }),
    ).toThrow("requiredSigners must be a non-empty array");
  });

  it("throws when the threshold exceeds the signer count", () => {
    expect(() =>
      createMultisigProposal({
        operation: "change_admin_list",
        requiredSigners: ["a", "b"],
        threshold: 5,
      }),
    ).toThrow("threshold must be between 1 and 2");
  });

  it("throws when the threshold is below 1", () => {
    expect(() =>
      createMultisigProposal({
        operation: "pause_contract",
        requiredSigners: ["a", "b"],
        threshold: 0,
      }),
    ).toThrow("threshold must be between 1 and 2");
  });

  it("resolveThreshold defaults to min(DEFAULT_THRESHOLD, N) when omitted", () => {
    expect(resolveThreshold(undefined, 5)).toBe(Math.min(DEFAULT_THRESHOLD, 5));
    expect(resolveThreshold(null, 3)).toBe(Math.min(DEFAULT_THRESHOLD, 3));
  });

  it("resolveThreshold enforces 1 <= threshold <= N", () => {
    expect(() => resolveThreshold(0, 3)).toThrow("threshold must be between 1 and 3");
    expect(() => resolveThreshold(5, 3)).toThrow("threshold must be between 1 and 3");
    expect(resolveThreshold(2, 3)).toBe(2);
  });
});
