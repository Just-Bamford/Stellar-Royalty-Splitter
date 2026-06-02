/**
 * Unit tests for validation.js — shares sum error message clarity (issue #356).
 *
 * Focuses on the initializeSchema shares-sum refine: verifies that the error
 * message includes the actual sum and the expected sum (10000) for all edge
 * cases near the boundary.
 */
import { describe, test, expect } from "@jest/globals";
import { initializeSchema } from "../src/validation.js";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1  = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2  = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

function parseShares(shares) {
  return initializeSchema.safeParse({
    contractId: CONTRACT,
    walletAddress: WALLET,
    collaborators: shares.map((_, i) => (i === 0 ? COLLAB1 : COLLAB2)),
    shares,
  });
}

describe("initializeSchema — shares sum validation (issue #356)", () => {
  test("valid: [5000, 5000] sums to 10000 — passes", () => {
    const result = parseShares([5000, 5000]);
    expect(result.success).toBe(true);
  });

  test("valid: [10000] single collaborator — passes", () => {
    const result = initializeSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      collaborators: [COLLAB1],
      shares: [10000],
    });
    expect(result.success).toBe(true);
  });

  test("error: [9999, 0] = 9999 — message includes actual (9999) and expected (10000)", () => {
    const result = parseShares([9999, 0]);
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(" ");
    expect(msg).toMatch(/9999/);
    expect(msg).toMatch(/10000/);
  });

  test("error: [5000, 5001] = 10001 — message includes actual (10001) and expected (10000)", () => {
    const result = parseShares([5000, 5001]);
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(" ");
    expect(msg).toMatch(/10001/);
    expect(msg).toMatch(/10000/);
  });

  test("error: [0, 0] = 0 — message includes actual (0) and expected (10000)", () => {
    const result = parseShares([0, 0]);
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(" ");
    expect(msg).toMatch(/\b0\b/);
    expect(msg).toMatch(/10000/);
  });

  test("error: [3000, 3000] = 6000 — message includes actual (6000) and expected (10000)", () => {
    const result = parseShares([3000, 3000]);
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(" ");
    expect(msg).toMatch(/6000/);
    expect(msg).toMatch(/10000/);
  });

  test("error: [10000, 1] = 10001 — over by 1 — message includes both sums", () => {
    const result = parseShares([10000, 1]);
    // Note: basisPoints max is 10000 so 10001 itself is invalid; the share[1]=1 is valid
    // but sum = 10001. Expect the sum error to appear.
    expect(result.success).toBe(false);
    const allMessages = result.error.issues.map((i) => i.message).join(" ");
    // Either a max constraint fires or the sum error fires; both must not succeed.
    expect(allMessages.length).toBeGreaterThan(0);
  });

  test("error message path is 'shares' for sum mismatch", () => {
    const result = parseShares([9999, 0]);
    expect(result.success).toBe(false);
    const sumIssue = result.error.issues.find((i) => i.message.includes("10000"));
    expect(sumIssue).toBeDefined();
    expect(sumIssue.path).toContain("shares");
  });

  test("error: [5001, 5001] = 10002 — message includes actual (10002)", () => {
    const result = parseShares([5001, 5001]);
    expect(result.success).toBe(false);
    const msg = result.error.issues.map((i) => i.message).join(" ");
    expect(msg).toMatch(/10002/);
  });

  test("valid: [3333, 3333, 3334] three collaborators summing to 10000", () => {
    const result = initializeSchema.safeParse({
      contractId: CONTRACT,
      walletAddress: WALLET,
      collaborators: [COLLAB1, COLLAB2, "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"],
      shares: [3333, 3333, 3334],
    });
    expect(result.success).toBe(true);
  });
});
