import { describe, test, expect } from "@jest/globals";
import {
  initializeSchema,
  recordSecondarySaleSchema,
  distributeSchema,
  setRoyaltyRateSchema,
  distributeSecondarySchema,
  MAX_COLLABORATORS,
  MAX_NFT_ID_LENGTH,
  MAX_SALE_PRICE,
} from "../src/validation.js";
import {
  VALID_CONTRACT_ID as CONTRACT,
  VALID_WALLET_A as WALLET,
  VALID_WALLET_B,
  VALID_WALLET_C,
  VALID_TOKEN_ID as TOKEN,
} from "./test-helpers.js";

// ── initializeSchema ─────────────────────────────────────────────────────────

describe("initializeSchema — input size validation", () => {
  const validBase = {
    contractId: CONTRACT,
    walletAddress: WALLET,
    collaborators: [WALLET],
    shares: [10000],
  };

  test("accepts exactly MAX_COLLABORATORS collaborators", () => {
    const testWallets = [WALLET, VALID_WALLET_B, VALID_WALLET_C];
    const collab = Array(MAX_COLLABORATORS)
      .fill(null)
      .map((_, i) => testWallets[i % testWallets.length]);
    const shares = Array(MAX_COLLABORATORS).fill(Math.floor(10000 / MAX_COLLABORATORS));
    // Adjust last share so they sum to 10000
    shares[MAX_COLLABORATORS - 1] += 10000 - shares.reduce((a, b) => a + b, 0);
    const result = initializeSchema.safeParse({
      ...validBase,
      collaborators: collab,
      shares,
    });
    expect(result.success).toBe(true);
  });

  test("rejects more than MAX_COLLABORATORS collaborators", () => {
    const n = MAX_COLLABORATORS + 1;
    const testWallets = [WALLET, VALID_WALLET_B, VALID_WALLET_C];
    const collab = Array(n)
      .fill(null)
      .map((_, i) => testWallets[i % testWallets.length]);
    const shareVal = Math.floor(10000 / n);
    const shares = Array(n).fill(shareVal);
    shares[n - 1] += 10000 - shares.reduce((a, b) => a + b, 0);
    const result = initializeSchema.safeParse({
      ...validBase,
      collaborators: collab,
      shares,
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/maximum/i);
  });

  test("rejects empty collaborators list", () => {
    const result = initializeSchema.safeParse({
      ...validBase,
      collaborators: [],
      shares: [],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/at least one/i);
  });

  test("rejects mismatched collaborators and shares lengths", () => {
    const result = initializeSchema.safeParse({
      ...validBase,
      collaborators: [WALLET, VALID_WALLET_B],
      shares: [10000],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/same length/i);
  });

  test("rejects shares that do not sum to 10000", () => {
    const result = initializeSchema.safeParse({
      ...validBase,
      collaborators: [WALLET],
      shares: [5000],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/sum to 10000/i);
  });

  test("rejects invalid Stellar address in collaborators", () => {
    const result = initializeSchema.safeParse({
      ...validBase,
      collaborators: ["not-a-stellar-address"],
      shares: [10000],
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/Invalid Stellar address/i);
  });

  test("rejects basis point share exceeding 10000", () => {
    const result = initializeSchema.safeParse({
      ...validBase,
      collaborators: [WALLET],
      shares: [10001],
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative share", () => {
    const result = initializeSchema.safeParse({
      ...validBase,
      collaborators: [WALLET],
      shares: [-1],
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid contractId format", () => {
    const result = initializeSchema.safeParse({
      ...validBase,
      contractId: "INVALID",
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/Invalid contract address/i);
  });

  test("rejects invalid walletAddress format", () => {
    const result = initializeSchema.safeParse({
      ...validBase,
      walletAddress: "INVALID",
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/Invalid Stellar address/i);
  });

  test("accepts minimum valid payload", () => {
    const result = initializeSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });
});

// ── recordSecondarySaleSchema ────────────────────────────────────────────────

describe("recordSecondarySaleSchema — input size validation", () => {
  const validBase = {
    contractId: CONTRACT,
    walletAddress: WALLET,
    nftId: "nft-001",
    previousOwner: WALLET,
    newOwner: WALLET,
    salePrice: 1_000_000,
    saleToken: TOKEN,
    royaltyRate: 500,
  };

  test("accepts nftId exactly at MAX_NFT_ID_LENGTH", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      nftId: "x".repeat(MAX_NFT_ID_LENGTH),
    });
    expect(result.success).toBe(true);
  });

  test("rejects nftId longer than MAX_NFT_ID_LENGTH", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      nftId: "x".repeat(MAX_NFT_ID_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/at most/i);
  });

  test("rejects empty nftId", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      nftId: "",
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/required/i);
  });

  test("rejects salePrice of zero", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      salePrice: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/positive/i);
  });

  test("rejects negative salePrice", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      salePrice: -1,
    });
    expect(result.success).toBe(false);
  });

  test("accepts salePrice at MAX_SALE_PRICE", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      salePrice: MAX_SALE_PRICE,
    });
    expect(result.success).toBe(true);
  });

  test("rejects salePrice exceeding MAX_SALE_PRICE", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      salePrice: MAX_SALE_PRICE + 1,
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/maximum safe integer/i);
  });

  test("rejects royaltyRate exceeding 10000", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      royaltyRate: 10001,
    });
    expect(result.success).toBe(false);
  });

  test("accepts royaltyRate of 0 (royalties disabled)", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      royaltyRate: 0,
    });
    expect(result.success).toBe(true);
  });

  test("rejects non-integer salePrice", () => {
    const result = recordSecondarySaleSchema.safeParse({
      ...validBase,
      salePrice: 1000.5,
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/integer/i);
  });

  test("accepts a valid secondary sale payload", () => {
    const result = recordSecondarySaleSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });
});

// ── distributeSchema ─────────────────────────────────────────────────────────

describe("distributeSchema — input size validation", () => {
  test("rejects missing tokenId", () => {
    const result = distributeSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid tokenId format", () => {
    const result = distributeSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      tokenId: "INVALID",
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/Invalid contract address/i);
  });

  test("accepts a valid distribute payload", () => {
    const result = distributeSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      tokenId: TOKEN,
    });
    expect(result.success).toBe(true);
  });
});

// ── setRoyaltyRateSchema ──────────────────────────────────────────────────────

describe("setRoyaltyRateSchema — input size validation", () => {
  test("rejects royaltyRate above 10000", () => {
    const result = setRoyaltyRateSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      royaltyRate: 10001,
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative royaltyRate", () => {
    const result = setRoyaltyRateSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      royaltyRate: -1,
    });
    expect(result.success).toBe(false);
  });

  test("accepts royaltyRate of 0", () => {
    const result = setRoyaltyRateSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      royaltyRate: 0,
    });
    expect(result.success).toBe(true);
  });

  test("accepts royaltyRate of 10000", () => {
    const result = setRoyaltyRateSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      royaltyRate: 10000,
    });
    expect(result.success).toBe(true);
  });
});
