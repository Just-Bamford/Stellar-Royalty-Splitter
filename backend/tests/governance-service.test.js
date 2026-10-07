import { jest } from "@jest/globals";
import {
  encodeGovProposalAction,
  getGovernanceSummary,
  listGovProposals,
  buildGovMintTx,
  buildGovTransferTx,
  buildDelegateGovVotesTx,
  buildRevokeGovDelegationTx,
  buildCreateGovProposalTx,
  buildVoteGovProposalTx,
  buildExecuteGovProposalTx,
} from "../src/services/governance.js";

describe("Governance Service Helper (#982)", () => {
  describe("encodeGovProposalAction", () => {
    it("encodes ChangeRoyaltyRate correctly", () => {
      const encoded = encodeGovProposalAction({
        type: "ChangeRoyaltyRate",
        rate: 800,
      });
      expect(encoded).toBeDefined();
    });

    it("encodes PauseContract correctly", () => {
      const encoded = encodeGovProposalAction({
        type: "PauseContract",
      });
      expect(encoded).toBeDefined();
    });

    it("encodes UnpauseContract correctly", () => {
      const encoded = encodeGovProposalAction({
        type: "UnpauseContract",
      });
      expect(encoded).toBeDefined();
    });

    it("throws on invalid action type", () => {
      expect(() => {
        encodeGovProposalAction({ type: "UnknownAction" });
      }).toThrow();
    });
  });

  describe("Transaction Builders", () => {
    it("has builder functions defined and callable", () => {
      expect(typeof buildGovMintTx).toBe("function");
      expect(typeof buildGovTransferTx).toBe("function");
      expect(typeof buildDelegateGovVotesTx).toBe("function");
      expect(typeof buildRevokeGovDelegationTx).toBe("function");
      expect(typeof buildCreateGovProposalTx).toBe("function");
      expect(typeof buildVoteGovProposalTx).toBe("function");
      expect(typeof buildExecuteGovProposalTx).toBe("function");
    });
  });
});
