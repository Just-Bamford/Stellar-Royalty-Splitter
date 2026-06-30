/**
 * Tests for the largest-remainder rounding algorithm (#427).
 *
 * Verifies:
 *  - Total distributed always equals amount sent (no fund loss)
 *  - Dust allocated deterministically to highest-fractional collaborators
 *  - Edge cases: 1 lamport, 2 lamports, extreme amounts, uneven splits
 */

import { describe, test, expect } from "@jest/globals";
import { applyLargestRemainder } from "../src/database/secondary-royalties.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sum of all allocated amounts must equal totalAmount */
function assertNoFundLoss(allocations, totalAmount) {
  const sum = allocations.reduce((acc, a) => acc + a.amount, 0n);
  expect(sum).toBe(BigInt(totalAmount));
}

/** Build 3-collaborator config with equal 1/3 each (basisPoints rounds to 3333 + 3333 + 3334) */
const THREE_EQUAL = [
  { address: "ADDR_A", basisPoints: 3334 },
  { address: "ADDR_B", basisPoints: 3333 },
  { address: "ADDR_C", basisPoints: 3333 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyLargestRemainder (#427)", () => {
  // 1. Classic 100 ÷ 3 case — the motivating example from the issue
  test("100 lamports ÷ 3 collaborators: no fund loss, dust to largest fraction", () => {
    const result = applyLargestRemainder(100n, THREE_EQUAL);

    assertNoFundLoss(result, 100n);
    // ADDR_A gets 34 (3334/10000 * 100 = 33.34, floor=33, frac=0.34)
    // ADDR_B gets 33 (3333/10000 * 100 = 33.33, floor=33, frac=0.33)
    // ADDR_C gets 33
    // Dust = 1 → goes to ADDR_A (largest fractional part 0.34)
    const a = result.find((r) => r.address === "ADDR_A");
    const b = result.find((r) => r.address === "ADDR_B");
    const c = result.find((r) => r.address === "ADDR_C");

    expect(a.dustReceived).toBe(1n);
    expect(b.dustReceived).toBe(0n);
    expect(c.dustReceived).toBe(0n);
    expect(a.amount + b.amount + c.amount).toBe(100n);
  });

  // 2. 1 lamport across 3 collaborators
  test("1 lamport ÷ 3 collaborators: entire amount goes to first recipient", () => {
    const result = applyLargestRemainder(1n, THREE_EQUAL);
    assertNoFundLoss(result, 1n);
    // All floors = 0; dust = 1 → to highest fractional (ADDR_A, bp=3334)
    const a = result.find((r) => r.address === "ADDR_A");
    expect(a.amount).toBe(1n);
    expect(a.dustReceived).toBe(1n);
  });

  // 3. 2 lamports across 3 collaborators
  test("2 lamports ÷ 3 collaborators: dust to top 2 fractional recipients", () => {
    const result = applyLargestRemainder(2n, THREE_EQUAL);
    assertNoFundLoss(result, 2n);
    // floors all 0; dust = 2 → goes to ADDR_A (3334) and ADDR_B (3333)
    const a = result.find((r) => r.address === "ADDR_A");
    const b = result.find((r) => r.address === "ADDR_B");
    const c = result.find((r) => r.address === "ADDR_C");
    expect(a.amount).toBe(1n);
    expect(b.amount).toBe(1n);
    expect(c.amount).toBe(0n);
  });

  // 4. Perfectly divisible amount — no dust at all
  test("perfectly divisible amount produces zero dust", () => {
    const collabs = [
      { address: "ADDR_A", basisPoints: 5000 },
      { address: "ADDR_B", basisPoints: 5000 },
    ];
    const result = applyLargestRemainder(1000n, collabs);
    assertNoFundLoss(result, 1000n);
    result.forEach((r) => expect(r.dustReceived).toBe(0n));
    result.forEach((r) => expect(r.amount).toBe(500n));
  });

  // 5. Extreme large amount (10 million) ÷ 3
  test("10_000_000 lamports ÷ 3: no fund loss", () => {
    const result = applyLargestRemainder(10_000_000n, THREE_EQUAL);
    assertNoFundLoss(result, 10_000_000n);
  });

  // 6. Single collaborator gets everything
  test("single collaborator receives 100% of amount", () => {
    const result = applyLargestRemainder(999n, [{ address: "SOLE", basisPoints: 10000 }]);
    assertNoFundLoss(result, 999n);
    expect(result[0].amount).toBe(999n);
    expect(result[0].dustReceived).toBe(0n);
  });

  // 7. Empty collaborators list returns empty array
  test("empty collaborators list returns empty array", () => {
    const result = applyLargestRemainder(500n, []);
    expect(result).toHaveLength(0);
  });

  // 8. Asymmetric shares (10/30/60 split) with indivisible total
  test("10/30/60 split with 7 lamports: no fund loss, correct dust allocation", () => {
    const collabs = [
      { address: "TEN",   basisPoints: 1000 }, // 10%
      { address: "THIRTY", basisPoints: 3000 }, // 30%
      { address: "SIXTY", basisPoints: 6000 }, // 60%
    ];
    // 7 * 0.10 = 0.7 → floor=0, frac=7000 (scaled)
    // 7 * 0.30 = 2.1 → floor=2, frac=1000 (scaled)
    // 7 * 0.60 = 4.2 → floor=4, frac=2000 (scaled)
    // sum floors = 6; dust = 1 → TEN has largest frac (7000) → gets +1
    const result = applyLargestRemainder(7n, collabs);
    assertNoFundLoss(result, 7n);
    const ten   = result.find((r) => r.address === "TEN");
    const sixty = result.find((r) => r.address === "SIXTY");
    expect(ten.amount).toBe(1n);
    expect(ten.dustReceived).toBe(1n);
    expect(sixty.amount).toBe(4n);
    expect(sixty.dustReceived).toBe(0n);
  });

  // 9. All collaborators with equal tiny shares and 1 unit of dust
  test("4 equal 25% collaborators with amount=5 distributes dust to exactly one", () => {
    const collabs = [
      { address: "A", basisPoints: 2500 },
      { address: "B", basisPoints: 2500 },
      { address: "C", basisPoints: 2500 },
      { address: "D", basisPoints: 2500 },
    ];
    const result = applyLargestRemainder(5n, collabs);
    assertNoFundLoss(result, 5n);
    const dustTotal = result.reduce((s, r) => s + r.dustReceived, 0n);
    expect(dustTotal).toBe(1n); // exactly 1 unit of dust
    // Each gets 1, plus one extra unit to the first in original order (tie-breaking)
    const dustRecipients = result.filter((r) => r.dustReceived > 0n);
    expect(dustRecipients).toHaveLength(1);
  });

  // 10. Verify determinism: same inputs always produce same output
  test("algorithm is deterministic for same inputs", () => {
    const collabs = [
      { address: "ADDR_A", basisPoints: 3334 },
      { address: "ADDR_B", basisPoints: 3333 },
      { address: "ADDR_C", basisPoints: 3333 },
    ];
    const r1 = applyLargestRemainder(100n, collabs);
    const r2 = applyLargestRemainder(100n, collabs);

    expect(r1.map((r) => ({ address: r.address, amount: r.amount.toString() }))).toEqual(
      r2.map((r) => ({ address: r.address, amount: r.amount.toString() })),
    );
  });

  // 11. Zero total amount distributes nothing
  test("zero total amount distributes 0 to all collaborators", () => {
    const result = applyLargestRemainder(0n, THREE_EQUAL);
    assertNoFundLoss(result, 0n);
    result.forEach((r) => expect(r.amount).toBe(0n));
  });
});
