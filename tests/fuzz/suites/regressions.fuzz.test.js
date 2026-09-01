/**
 * Deterministic regressions for defects found by the fuzz suite (#866).
 *
 * The issue asks that any discovered validation bypass or crash be isolated
 * into a deterministic regression test. Each case below was found by a
 * property run, then minimised to a fixed input — so these run in
 * milliseconds, always exercise the exact failing value, and stay meaningful
 * even if the generators are later retuned.
 *
 * Every entry records the seed that surfaced it, so the original random case
 * can be replayed from the fuzz report if needed.
 */

import { describe, test, expect } from "@jest/globals";

import {
  amountSchema,
  distributeSchema,
  batchDistributeSchema,
  validateContractId,
  validateContractIdMiddleware,
  validateStellarAddress,
} from "../../../backend/src/validation.js";

const VALID_CONTRACT = "CXE3LTDKJMD63ZKLL2GLBOLPWXJVFJ7ZOFXMA7QHMNEWJSCQTB24OQIJ";
const VALID_ACCOUNT = "GBYUONUD5HU4F6XCMDTNFJHJ6V4NIXW6DYIOYQTCGZN22WJKGH5XCFGS";

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe("regression: non-finite distribution amounts are rejected (#866)", () => {
  // Found by: property "distributeSchema", FUZZ_SEED=1, case 44.
  //
  // `z.number().positive()` is implemented as a `> 0` comparison, and
  // `Infinity > 0` is true — so the amount union accepted Infinity as a
  // distribution amount. It was then normalised through as a number and only
  // failed later, inside `i128ToScVal`, where `BigInt(Infinity)` throws a
  // RangeError during transaction construction. That turned a malformed
  // request into a 500 on a money-moving path instead of a 400 at the edge.
  test.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("amountSchema rejects the number %s", (_label, value) => {
    const result = amountSchema.safeParse(value);
    expect(result.success).toBe(false);
  });

  test("distributeSchema rejects an Infinity amount", () => {
    const result = distributeSchema.safeParse({
      contractId: VALID_CONTRACT,
      walletAddress: VALID_ACCOUNT,
      tokenId: VALID_CONTRACT,
      amount: Number.POSITIVE_INFINITY,
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((issue) => issue.path.includes("amount"))).toBe(true);
  });

  test("batchDistributeSchema rejects an Infinity amount inside an operation", () => {
    const result = batchDistributeSchema.safeParse({
      walletAddress: VALID_ACCOUNT,
      operations: [
        { contractId: VALID_CONTRACT, tokenId: VALID_CONTRACT, amount: 1 },
        {
          contractId: VALID_CONTRACT,
          tokenId: VALID_CONTRACT,
          amount: Number.POSITIVE_INFINITY,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("finite positive amounts are still accepted in both accepted forms", () => {
    // Guards against over-correcting: the fix must not narrow the schema.
    expect(amountSchema.safeParse(1).success).toBe(true);
    expect(amountSchema.safeParse(1.5).success).toBe(true);
    expect(amountSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(amountSchema.safeParse("123").success).toBe(true);
    // The string branch remains integer-only by design.
    expect(amountSchema.safeParse("1.5").success).toBe(false);
    expect(amountSchema.safeParse("0").success).toBe(false);
  });
});

describe("regression: identifier guards are total for non-string input (#866)", () => {
  // Found by: property "identifierGuards", FUZZ_SEED=1.
  //
  // `RegExp.prototype.test` coerces its argument to a string, and that
  // coercion throws a TypeError for a symbol. Both contract-id guards called
  // `.test()` on an unvalidated value, so a non-string reaching them raised
  // instead of returning a 400 — an uncaught throw on the untrusted-input
  // path, which Express reports as a 500.
  const NON_STRINGS = [
    ["symbol", Symbol("fuzz")],
    ["object", {}],
    ["array", []],
    ["number", 123],
    ["null", null],
    ["undefined", undefined],
    ["boolean", true],
  ];

  test.each(NON_STRINGS)("validateContractId returns false for a %s", (_label, value) => {
    const res = makeRes();
    expect(() => validateContractId(value, res)).not.toThrow();
    expect(validateContractId(value, makeRes())).toBe(false);
    expect(res.statusCode).toBe(400);
  });

  test.each(NON_STRINGS)(
    "validateContractIdMiddleware rejects a %s without throwing",
    (_label, value) => {
      const res = makeRes();
      let nextCalled = false;
      expect(() =>
        validateContractIdMiddleware({ params: { contractId: value } }, res, () => {
          nextCalled = true;
        })
      ).not.toThrow();
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(400);
    }
  );

  test.each(NON_STRINGS)("validateStellarAddress returns false for a %s", (_label, value) => {
    const res = makeRes();
    expect(() => validateStellarAddress(value, res)).not.toThrow();
    expect(validateStellarAddress(value, makeRes())).toBe(false);
    expect(res.statusCode).toBe(400);
  });

  test("valid identifiers still pass both guard forms", () => {
    expect(validateContractId(VALID_CONTRACT, makeRes())).toBe(true);
    expect(validateStellarAddress(VALID_ACCOUNT, makeRes())).toBe(true);

    let nextCalled = false;
    validateContractIdMiddleware({ params: { contractId: VALID_CONTRACT } }, makeRes(), () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});

describe("regression: metrics module parses (#866)", () => {
  // Found while wiring the fuzz suite: backend/src/metrics.js carried a typo
  // (`import https ifrom "https"`) that made the module unparseable. Because
  // routes and the app entry point import it transitively, the majority of the
  // existing backend Jest suites could not even load. Importing it here keeps
  // that from silently regressing.
  test("backend/src/metrics.js can be imported", async () => {
    await expect(import("../../../backend/src/metrics.js")).resolves.toBeDefined();
  });
});
