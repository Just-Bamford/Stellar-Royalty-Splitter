/**
 * Validation tests for form schemas and helpers.
 * Tests the Zod schemas and validation utilities.
 */

import { describe, expect, it } from "vitest";
import { isValidPercentage, isValidShare, isValidStellarAddress } from "../lib/validation";
import { collaboratorSchema, distributeFormSchema, initializeFormSchema } from "../schemas/royaltySchemas";

describe("isValidStellarAddress", () => {
  it("returns true for a valid Stellar public key (G...)", () => {
    const validAddress = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    expect(isValidStellarAddress(validAddress)).toBe(true);
  });

  it("returns false for an address not starting with G", () => {
    const invalidAddress = "CAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    expect(isValidStellarAddress(invalidAddress)).toBe(false);
  });

  it("returns false for an address with wrong length", () => {
    const invalidAddress = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCW"; // 55 chars total
    expect(isValidStellarAddress(invalidAddress)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidStellarAddress("")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isValidStellarAddress(null as any)).toBe(false);
    expect(isValidStellarAddress(undefined as any)).toBe(false);
    expect(isValidStellarAddress(123 as any)).toBe(false);
  });
});

describe("isValidPercentage", () => {
  it("returns true for valid percentages", () => {
    expect(isValidPercentage(50)).toBe(true);
    expect(isValidPercentage(100)).toBe(true);
    expect(isValidPercentage(0.01)).toBe(true);
  });

  it("returns false for zero", () => {
    expect(isValidPercentage(0)).toBe(false);
  });

  it("returns false for negative numbers", () => {
    expect(isValidPercentage(-10)).toBe(false);
  });

  it("returns false for numbers over 100", () => {
    expect(isValidPercentage(101)).toBe(false);
  });
});

describe("isValidShare", () => {
  it("returns true for valid shares", () => {
    expect(isValidShare(50)).toBe(true);
    expect(isValidShare(100)).toBe(true);
    expect(isValidShare(0.01)).toBe(true);
  });

  it("returns false for zero or negative shares", () => {
    expect(isValidShare(0)).toBe(false);
    expect(isValidShare(-10)).toBe(false);
  });

  it("returns false for shares over 100", () => {
    expect(isValidShare(101)).toBe(false);
  });
});

describe("collaboratorSchema", () => {
  it("validates a valid collaborator", async () => {
    const validCollaborator = {
      address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      basisPoints: 50,
    };
    const result = await collaboratorSchema.safeParseAsync(validCollaborator);
    expect(result.success).toBe(true);
  });

  it("rejects empty address", async () => {
    const invalidCollaborator = {
      address: "",
      basisPoints: 50,
    };
    const result = await collaboratorSchema.safeParseAsync(invalidCollaborator);
    expect(result.success).toBe(false);
  });

  it("rejects invalid Stellar address", async () => {
    const invalidCollaborator = {
      address: "INVALID_ADDRESS",
      basisPoints: 50,
    };
    const result = await collaboratorSchema.safeParseAsync(invalidCollaborator);
    expect(result.success).toBe(false);
  });

  it("rejects share of 0", async () => {
    const invalidCollaborator = {
      address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      basisPoints: 0,
    };
    const result = await collaboratorSchema.safeParseAsync(invalidCollaborator);
    expect(result.success).toBe(false);
  });

  it("rejects share greater than 100", async () => {
    const invalidCollaborator = {
      address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      basisPoints: 101,
    };
    const result = await collaboratorSchema.safeParseAsync(invalidCollaborator);
    expect(result.success).toBe(false);
  });

  it("accepts string percentages and converts to numbers", async () => {
    const collaborator = {
      address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      basisPoints: "50.5",
    };
    const result = await collaboratorSchema.safeParseAsync(collaborator);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.basisPoints).toBe(50.5);
    }
  });
});

describe("initializeFormSchema", () => {
  it("passes when shares sum to exactly 100%", async () => {
    const validForm = {
      collaborators: [
        {
          address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          basisPoints: 60,
        },
        {
          address: "GBBD47UZM2HO7M7F53EGU3GEIQRXVKSOQGIWIK5I27LOMNQ7P7JG6VSZ",
          basisPoints: 40,
        },
      ],
    };
    const result = await initializeFormSchema.safeParseAsync(validForm);
    expect(result.success).toBe(true);
  });

  it("fails when shares sum to less than 100% (e.g., 60 + 30 = 90)", async () => {
    const invalidForm = {
      collaborators: [
        {
          address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          basisPoints: 60,
        },
        {
          address: "GBBD47UZM2HO7M7F53EGU3GEIQRXVKSOQGIWIK5I27LOMNQ7P7JG6VSZ",
          basisPoints: 30,
        },
      ],
    };
    const result = await initializeFormSchema.safeParseAsync(invalidForm);
    expect(result.success).toBe(false);
  });

  it("fails when shares sum to more than 100% (e.g., 60 + 60 = 120)", async () => {
    const invalidForm = {
      collaborators: [
        {
          address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          basisPoints: 60,
        },
        {
          address: "GBBD47UZM2HO7M7F53EGU3GEIQRXVKSOQGIWIK5I27LOMNQ7P7JG6VSZ",
          basisPoints: 60,
        },
      ],
    };
    const result = await initializeFormSchema.safeParseAsync(invalidForm);
    expect(result.success).toBe(false);
  });

  it("requires at least one collaborator", async () => {
    const invalidForm = {
      collaborators: [],
    };
    const result = await initializeFormSchema.safeParseAsync(invalidForm);
    expect(result.success).toBe(false);
  });

  it("allows floating point percentages that sum to 100", async () => {
    const validForm = {
      collaborators: [
        {
          address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          basisPoints: 33.33,
        },
        {
          address: "GBBD47UZM2HO7M7F53EGU3GEIQRXVKSOQGIWIK5I27LOMNQ7P7JG6VSZ",
          basisPoints: 33.33,
        },
        {
          address: "GC4R36Y4IOSJCLE226UTXHRJDBYCSL6CEYL37RCMA76IUHXFJRVYC4OV",
          basisPoints: 33.34,
        },
      ],
    };
    const result = await initializeFormSchema.safeParseAsync(validForm);
    expect(result.success).toBe(true);
  });
});

describe("distributeFormSchema", () => {
  it("validates a valid distribution form", async () => {
    const validForm = {
      tokenId: "CBQHYTLMSQBTGSRRLATUJPXWVXQYHZCWXEFYEPVRP54CXXVVNYPESRXQ",
      amount: 100.5,
    };
    const result = await distributeFormSchema.safeParseAsync(validForm);
    expect(result.success).toBe(true);
  });

  it("rejects empty tokenId", async () => {
    const invalidForm = {
      tokenId: "",
      amount: 100.5,
    };
    const result = await distributeFormSchema.safeParseAsync(invalidForm);
    expect(result.success).toBe(false);
  });

  it("rejects invalid contract address (not starting with C)", async () => {
    const invalidForm = {
      tokenId: "GBBD47UZM2HO7M7F53EGU3GEIQRXVKSOQGIWIK5I27LOMNQ7P7JG6VSZ",
      amount: 100.5,
    };
    const result = await distributeFormSchema.safeParseAsync(invalidForm);
    expect(result.success).toBe(false);
  });

  it("rejects zero amount", async () => {
    const invalidForm = {
      tokenId: "CBQHYTLMSQBTGSRRLATUJPXWVXQYHZCWXEFYEPVRP54CXXVVNYPESRXQ",
      amount: 0,
    };
    const result = await distributeFormSchema.safeParseAsync(invalidForm);
    expect(result.success).toBe(false);
  });

  it("rejects negative amount", async () => {
    const invalidForm = {
      tokenId: "CBQHYTLMSQBTGSRRLATUJPXWVXQYHZCWXEFYEPVRP54CXXVVNYPESRXQ",
      amount: -50,
    };
    const result = await distributeFormSchema.safeParseAsync(invalidForm);
    expect(result.success).toBe(false);
  });

  it("accepts string amounts and converts to numbers", async () => {
    const form = {
      tokenId: "CBQHYTLMSQBTGSRRLATUJPXWVXQYHZCWXEFYEPVRP54CXXVVNYPESRXQ",
      amount: "123.45",
    };
    const result = await distributeFormSchema.safeParseAsync(form);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(123.45);
    }
  });

  it("rejects invalid contract address with wrong length", async () => {
    const invalidForm = {
      tokenId: "CBQHYTLMSQBTGSRRLATUJPXWVXQYHZCWXEFYEPVRP54CXXVVNYPESRX", // 55 chars
      amount: 100.5,
    };
    const result = await distributeFormSchema.safeParseAsync(invalidForm);
    expect(result.success).toBe(false);
  });
});
