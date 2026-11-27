import { describe, it, expect } from "vitest";
import {
  validateGovernanceProposal,
  type GovernanceProposalFields,
} from "../governanceProposalValidation";

const TOKEN = `C${"A".repeat(55)}`;
const ACCOUNT = `G${"B".repeat(55)}`;

const base: GovernanceProposalFields = {
  title: "Adjust rate",
  description: "Because reasons",
  actionType: "ChangeRoyaltyRate",
  newRate: "500",
  tokenAddress: "",
  feeBps: "200",
  collabAddress: "",
  budgetRecipient: "",
  budgetAmount: "",
};

const withFields = (patch: Partial<GovernanceProposalFields>): GovernanceProposalFields => ({
  ...base,
  ...patch,
});

describe("validateGovernanceProposal", () => {
  describe("title and description", () => {
    it("requires a non-blank title", () => {
      expect(validateGovernanceProposal(withFields({ title: "   " }))).toBe("Title is required.");
    });

    it("requires a non-blank description", () => {
      expect(validateGovernanceProposal(withFields({ description: "" }))).toBe(
        "Description is required.",
      );
    });
  });

  describe("ChangeRoyaltyRate", () => {
    it.each(["1", "500", "10000", " 250 "])("accepts a rate of %s", (newRate) => {
      expect(validateGovernanceProposal(withFields({ newRate }))).toBeNull();
    });

    it.each(["0", "-5", "10001", "1.5", "abc", "", "1e3", "NaN", "99999999999999999999"])(
      "rejects a rate of %j",
      (newRate) => {
        expect(validateGovernanceProposal(withFields({ newRate }))).toMatch(/between 1 and 10000/);
      },
    );
  });

  describe("SetTokenFeeOverride", () => {
    const fields = (patch: Partial<GovernanceProposalFields>) =>
      withFields({ actionType: "SetTokenFeeOverride", tokenAddress: TOKEN, feeBps: "200", ...patch });

    it("accepts a contract address and fee in range, including the 0 and 10000 bounds", () => {
      expect(validateGovernanceProposal(fields({}))).toBeNull();
      expect(validateGovernanceProposal(fields({ feeBps: "0" }))).toBeNull();
      expect(validateGovernanceProposal(fields({ feeBps: "10000" }))).toBeNull();
    });

    it.each([
      ["empty", ""],
      ["an account address", ACCOUNT],
      ["too short", "CABC"],
      ["lowercase", TOKEN.toLowerCase()],
      ["a bad alphabet", `C${"1".repeat(55)}`],
    ])("rejects a token address that is %s", (_name, tokenAddress) => {
      expect(validateGovernanceProposal(fields({ tokenAddress }))).toMatch(/contract address/);
    });

    it.each(["-1", "10001", "2.5", "abc", ""])("rejects a fee of %j", (feeBps) => {
      expect(validateGovernanceProposal(fields({ feeBps }))).toMatch(/between 0 and 10000/);
    });
  });

  describe("RemoveCollaborator", () => {
    const fields = (collabAddress: string) =>
      withFields({ actionType: "RemoveCollaborator", collabAddress });

    it("accepts a valid account address", () => {
      expect(validateGovernanceProposal(fields(ACCOUNT))).toBeNull();
    });

    it.each([["empty", ""], ["a contract address", TOKEN], ["garbage", "not-an-address"]])(
      "rejects %s",
      (_name, address) => {
        expect(validateGovernanceProposal(fields(address))).toMatch(/Collaborator address/);
      },
    );
  });

  describe("AllocateBudget", () => {
    const fields = (patch: Partial<GovernanceProposalFields>) =>
      withFields({
        actionType: "AllocateBudget",
        tokenAddress: TOKEN,
        budgetRecipient: ACCOUNT,
        budgetAmount: "1000",
        ...patch,
      });

    it("accepts valid addresses and a positive whole amount", () => {
      expect(validateGovernanceProposal(fields({}))).toBeNull();
    });

    it("rejects an invalid token address", () => {
      expect(validateGovernanceProposal(fields({ tokenAddress: ACCOUNT }))).toMatch(/contract address/);
    });

    it.each(["", "not-an-address", TOKEN])("rejects recipient %j", (budgetRecipient) => {
      expect(validateGovernanceProposal(fields({ budgetRecipient }))).toMatch(/Recipient/);
    });

    it.each(["", "0", "-10", "1.5", "abc", "1e3", "0x10"])("rejects amount %j", (budgetAmount) => {
      expect(validateGovernanceProposal(fields({ budgetAmount }))).toMatch(/positive whole number/);
    });

    it("rejects an amount that does not fit a 128-bit contract value", () => {
      const tooBig = (2n ** 127n).toString();
      expect(validateGovernanceProposal(fields({ budgetAmount: tooBig }))).toBe(
        "Budget amount is too large.",
      );
      expect(validateGovernanceProposal(fields({ budgetAmount: (2n ** 127n - 1n).toString() }))).toBeNull();
    });
  });

  describe("actions without extra fields", () => {
    it.each(["PauseContract", "UnpauseContract"] as const)(
      "%s needs nothing beyond the title and description",
      (actionType) => {
        expect(validateGovernanceProposal(withFields({ actionType, newRate: "garbage" }))).toBeNull();
      },
    );
  });

  it("only validates the fields of the selected action", () => {
    const stale = withFields({
      actionType: "ChangeRoyaltyRate",
      tokenAddress: "garbage",
      collabAddress: "garbage",
      budgetAmount: "-1",
    });
    expect(validateGovernanceProposal(stale)).toBeNull();
  });
});
