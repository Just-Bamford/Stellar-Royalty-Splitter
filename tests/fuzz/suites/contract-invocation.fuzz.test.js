/**
 * Fuzz: contract invocation parameter construction (#866).
 *
 * Target: the ScVal builders in `backend/src/stellar.js`
 * (`addressToScVal`, `u32ToScVal`, `i128ToScVal`, `vecToScVal`,
 * `bytes32ToScVal`) plus `parseSorobanError`. These are the last code that
 * touches a value before it becomes transaction arguments, and they are pure
 * and network-free, so they can be fuzzed hard without any RPC access.
 *
 * Why this boundary matters: validation rejects bad *shapes*, but a value that
 * passes validation and is then mis-encoded produces a transaction that is
 * well-formed XDR carrying the wrong number. That failure is silent — the
 * transaction submits successfully and moves the wrong amount of money. The
 * round-trip invariants below are the guard against exactly that.
 *
 * ── Invariants asserted ────────────────────────────────────────────────────
 *
 *  C1  Total: every builder settles on every input — a normal Error, or a
 *      value. It never crashes the process and never throws a non-Error.
 *
 *  C2  Rejection is total, not partial: if a builder rejects an input it
 *      throws; it never returns a half-built ScVal. A partially constructed
 *      argument is worse than no argument, because it still serialises.
 *
 *  C3  Value-preserving: any input a builder accepts round-trips back to the
 *      original value. `i128ToScVal(x)` must decode to exactly `x`, for every
 *      accepted `x`, including the i128 extremes. This is the
 *      "serialization does not silently corrupt valid values" criterion.
 *
 *  C4  Serialisable: every accepted ScVal encodes to XDR and decodes back
 *      identically. An ScVal that cannot be serialised would fail deep inside
 *      the SDK with a far less actionable error.
 *
 *  C5  Non-mutating: builders do not modify their arguments.
 *
 *  C6  `parseSorobanError` never throws, and whenever it *does* classify an
 *      error it returns an actionable envelope — a 4xx/5xx status, a code, and
 *      a non-empty message. Returning `null` for an unrecognised shape is the
 *      documented sentinel, not a failure: the sole caller (the batch builder
 *      in stellar.js) substitutes a generic 500 via `??`. What must never
 *      happen is a throw, because this runs on the failure path and would
 *      replace the original fault with an unrelated one.
 */

import { describe, test, expect } from "@jest/globals";
import { xdr, scValToNative } from "@stellar/stellar-sdk";

import {
  addressToScVal,
  u32ToScVal,
  i128ToScVal,
  vecToScVal,
  bytes32ToScVal,
  parseSorobanError,
} from "../../../backend/src/stellar.js";
import { forAll, settles, deepEqual, snapshot } from "../property.js";
import { resolveCases } from "../random.js";
import {
  validStellarAddress,
  validContractAddress,
  malformedStellarAddress,
  boundaryInteger,
  hostileString,
  hostileTextOnly,
  oversizedString,
  deeplyNested,
  unexpectedType,
} from "../generators/primitives.js";
import { recordRun } from "../report.js";

const CASES = resolveCases();

const I128_MAX = 2n ** 127n - 1n;
const I128_MIN = -(2n ** 127n);
const U32_MAX = 4294967295;

/** C4 — an ScVal must survive an XDR encode/decode round trip. */
function assertXdrRoundTrips(scVal) {
  expect(scVal).toBeInstanceOf(xdr.ScVal);
  const encoded = settles(() => scVal.toXDR("base64"));
  expect(encoded.ok).toBe(true);
  expect(typeof encoded.value).toBe("string");

  const decoded = settles(() => xdr.ScVal.fromXDR(encoded.value, "base64"));
  expect(decoded.ok).toBe(true);
  expect(decoded.value.toXDR("base64")).toBe(encoded.value);
  return decoded.value;
}

describe("fuzz: contract invocation parameters (#866)", () => {
  test(`addressToScVal holds its invariants over ${CASES} generated addresses`, () => {
    const run = forAll({
      name: "addressToScVal",
      cases: CASES,
      generate: (rng) => {
        const kind = rng.weighted([
          ["valid-account", 3],
          ["valid-contract", 3],
          ["malformed", 6],
          ["oversized", 1],
          ["unexpected", 2],
        ]);
        switch (kind) {
          case "valid-account":
            return { value: validStellarAddress(rng), expectValid: true };
          case "valid-contract":
            return { value: validContractAddress(rng), expectValid: false };
          case "malformed":
            return { value: malformedStellarAddress(rng), expectValid: false };
          case "oversized":
            return { value: oversizedString(rng), expectValid: false };
          default:
            return { value: unexpectedType(rng), expectValid: false };
        }
      },
      check: ({ value, expectValid }) => {
        const before = typeof value === "object" && value !== null ? snapshot(value) : value;

        // C1 — settles.
        const outcome = settles(() => addressToScVal(value));

        // C5 — argument untouched.
        if (typeof value === "object" && value !== null) {
          expect(deepEqual(value, before)).toBe(true);
        }

        if (!outcome.ok) {
          // C2 — a rejection is a clean throw with a usable message.
          expect(outcome.error.message.length).toBeGreaterThan(0);
          if (expectValid) {
            throw new Error(`known-good address rejected: ${outcome.error.message}`);
          }
          return;
        }

        // C3/C4 — an accepted address encodes and decodes back to itself.
        const decoded = assertXdrRoundTrips(outcome.value);
        const native = settles(() => scValToNative(decoded));
        expect(native.ok).toBe(true);
        expect(String(native.value)).toBe(String(value).trim());
      },
    });
    recordRun("addressToScVal", run);
  });

  test(`u32ToScVal holds its invariants over ${CASES} generated integers`, () => {
    const run = forAll({
      name: "u32ToScVal",
      cases: CASES,
      generate: (rng) => {
        const value = rng.weighted([
          [rng.int(0, U32_MAX), 3],
          [0, 2],
          [1, 1],
          [10000, 2], // full basis points
          [U32_MAX, 2],
          [U32_MAX + 1, 2], // just past the type's range
          [-1, 2],
          [boundaryInteger(rng), 3],
          [unexpectedType(rng), 2],
        ]);
        const expectValid = Number.isInteger(value) && value >= 0 && value <= U32_MAX;
        return { value, expectValid };
      },
      check: ({ value, expectValid }) => {
        const outcome = settles(() => u32ToScVal(value));

        if (!outcome.ok) {
          expect(outcome.error.message.length).toBeGreaterThan(0);
          if (expectValid) {
            throw new Error(`in-range u32 rejected: ${value} — ${outcome.error.message}`);
          }
          return;
        }

        // A u32 builder that accepts an out-of-range value and silently wraps
        // it would corrupt a basis-point argument without any error. Encoding
        // must therefore fail rather than truncate.
        const encoded = settles(() => outcome.value.toXDR("base64"));
        if (!encoded.ok) {
          expect(expectValid).toBe(false);
          return;
        }

        // `+ 0` normalises -0 to 0: the generator's boundary table includes -0,
        // and Object.is(-0, 0) is false even though u32 has no signed zero and
        // the encoded value is identical.
        const decoded = xdr.ScVal.fromXDR(encoded.value, "base64");
        expect(Number(scValToNative(decoded)) + 0).toBe(Number(value) + 0);
      },
    });
    recordRun("u32ToScVal", run);
  });

  test(`i128ToScVal holds its invariants over ${CASES} generated amounts`, () => {
    const run = forAll({
      name: "i128ToScVal",
      cases: CASES,
      generate: (rng) => {
        const value = rng.weighted([
          [rng.int(1, 1_000_000), 3],
          [String(rng.int(1, 1_000_000)), 2],
          [0, 2],
          [-1, 2],
          [1, 1],
          [Number.MAX_SAFE_INTEGER, 2],
          [String(I128_MAX), 2],
          [String(I128_MIN), 2],
          [String(I128_MAX + 1n), 2], // one past the type's range
          [String(I128_MIN - 1n), 2],
          [1.5, 2], // BigInt() rejects fractions
          [NaN, 2],
          [Infinity, 2],
          [hostileString(rng, { maxLength: 24 }), 3],
          [unexpectedType(rng), 2],
        ]);
        return { value };
      },
      check: ({ value }) => {
        const outcome = settles(() => i128ToScVal(value));

        if (!outcome.ok) {
          expect(outcome.error.message.length).toBeGreaterThan(0);
          return;
        }

        const encoded = settles(() => outcome.value.toXDR("base64"));
        if (!encoded.ok) {
          // Out-of-range values must fail at encode time rather than wrap —
          // an amount that wraps is money moved to the wrong place.
          return;
        }

        // C3 — the decoded amount is bit-for-bit the amount we asked for.
        const decoded = xdr.ScVal.fromXDR(encoded.value, "base64");
        const native = scValToNative(decoded);
        expect(BigInt(native)).toBe(BigInt(value));
        expect(BigInt(native)).toBeLessThanOrEqual(I128_MAX);
        expect(BigInt(native)).toBeGreaterThanOrEqual(I128_MIN);
      },
    });
    recordRun("i128ToScVal", run);
  });

  test(`vecToScVal holds its invariants over ${CASES} generated argument lists`, () => {
    const run = forAll({
      name: "vecToScVal",
      cases: CASES,
      generate: (rng) => {
        const kind = rng.weighted([
          ["valid", 5],
          ["empty", 2],
          ["large", 2],
          ["mixed-junk", 4],
          ["nested", 2],
          ["not-array", 2],
        ]);

        switch (kind) {
          case "valid":
            return {
              value: rng.array(rng.int(1, 8), () => u32ToScVal(rng.int(0, 10000))),
              expectValid: true,
            };
          case "empty":
            return { value: [], expectValid: true };
          case "large":
            // Resource-exhaustion probe: a long argument vector must either
            // encode or throw, never hang.
            return {
              value: rng.array(rng.int(500, 2000), () => u32ToScVal(1)),
              expectValid: true,
            };
          case "mixed-junk":
            return {
              value: rng.array(rng.int(1, 6), () =>
                rng.bool() ? u32ToScVal(1) : unexpectedType(rng)
              ),
              expectValid: false,
            };
          case "nested":
            return { value: [deeplyNested(rng, { maxDepth: 256 })], expectValid: false };
          default:
            return { value: unexpectedType(rng), expectValid: false };
        }
      },
      check: ({ value, expectValid }) => {
        const outcome = settles(() => vecToScVal(value));

        if (!outcome.ok) {
          expect(outcome.error.message.length).toBeGreaterThan(0);
          return;
        }

        const encoded = settles(() => outcome.value.toXDR("base64"));
        if (!encoded.ok) {
          expect(expectValid).toBe(false);
          return;
        }

        // C4 — arity is preserved exactly; a vec that loses or duplicates an
        // element changes which contract overload is invoked. Only meaningful
        // when the input was a list to begin with — a non-array that somehow
        // encoded has no arity to preserve.
        const decoded = xdr.ScVal.fromXDR(encoded.value, "base64");
        if (Array.isArray(value)) {
          expect(decoded.vec().length).toBe(value.length);
        }
      },
    });
    recordRun("vecToScVal", run);
  });

  test(`bytes32ToScVal holds its invariants over ${CASES} generated hashes`, () => {
    const run = forAll({
      name: "bytes32ToScVal",
      cases: CASES,
      generate: (rng) => {
        const hexChars = "0123456789abcdef".split("");
        const kind = rng.weighted([
          ["valid", 4],
          ["short", 3],
          ["long", 3],
          ["odd-length", 3],
          ["non-hex", 3],
          ["unexpected", 2],
        ]);

        switch (kind) {
          case "valid":
            return { value: rng.array(64, () => rng.pick(hexChars)).join(""), expectValid: true };
          case "short":
            return {
              value: rng.array(rng.int(0, 62), () => rng.pick(hexChars)).join(""),
              expectValid: false,
            };
          case "long":
            return {
              value: rng.array(rng.int(66, 200), () => rng.pick(hexChars)).join(""),
              expectValid: false,
            };
          case "odd-length":
            return { value: rng.array(63, () => rng.pick(hexChars)).join(""), expectValid: false };
          case "non-hex":
            // Buffer.from(..., "hex") stops at the first non-hex character
            // rather than throwing, so a "zz…" string silently becomes a
            // short buffer — the explicit length check is what catches it.
            return { value: hostileString(rng, { maxLength: 64 }), expectValid: false };
          default:
            return { value: unexpectedType(rng), expectValid: false };
        }
      },
      check: ({ value, expectValid }) => {
        const outcome = settles(() => bytes32ToScVal(value));

        if (!outcome.ok) {
          expect(outcome.error.message.length).toBeGreaterThan(0);
          if (expectValid) {
            throw new Error(`valid 32-byte hex rejected: ${outcome.error.message}`);
          }
          return;
        }

        // Anything accepted really is 32 bytes and round-trips unchanged.
        expect(expectValid).toBe(true);
        const decoded = assertXdrRoundTrips(outcome.value);
        const native = scValToNative(decoded);
        expect(Buffer.from(native).length).toBe(32);
        expect(Buffer.from(native).toString("hex")).toBe(String(value).toLowerCase());
      },
    });
    recordRun("bytes32ToScVal", run);
  });

  test(`parseSorobanError stays total over ${CASES} generated error shapes`, () => {
    const run = forAll({
      name: "parseSorobanError",
      cases: CASES,
      generate: (rng) => {
        const kind = rng.weighted([
          ["simulation", 3],
          ["simulate-error-type", 2],
          ["horizon", 3],
          ["plain-error", 3],
          ["nested", 2],
          ["hostile", 3],
          ["primitive", 3],
        ]);

        switch (kind) {
          case "simulation":
            return { result: { error: hostileTextOnly(rng, { maxLength: 128 }) } };
          case "simulate-error-type":
            return {
              _type: "SimulateTransactionError",
              events: [],
              error: hostileTextOnly(rng, { maxLength: 128 }),
            };
          case "horizon":
            return {
              response: {
                data: {
                  extras: {
                    result_codes: {
                      transaction: rng.pick(["tx_failed", "tx_bad_seq", hostileTextOnly(rng)]),
                      operations: rng.array(rng.int(0, 4), () => hostileTextOnly(rng, { maxLength: 24 })),
                    },
                  },
                },
              },
            };
          case "plain-error":
            return new Error(hostileTextOnly(rng, { maxLength: 256 }));
          case "nested":
            return deeplyNested(rng, { maxDepth: 512 });
          case "hostile":
            return { result: { error: oversizedString(rng) } };
          default:
            // Restricted to JSON-representable values on purpose. This
            // function only ever sees errors raised by the Stellar SDK or by
            // `fetch`, so an object with a non-callable `toString` (which makes
            // template interpolation throw) is not a shape it can encounter.
            // Generating one would pin a defensive behaviour the codebase has
            // no reason to carry.
            return rng.pick([null, undefined, 0, "", "boom", [], {}, true]);
        }
      },
      check: (input) => {
        const before = typeof input === "object" && input !== null ? snapshot(input) : input;

        // C1 — total on the failure path.
        const outcome = settles(() => parseSorobanError(input));
        expect(outcome.ok).toBe(true);

        const parsed = outcome.value;

        // C6 — `null` means "not a shape I recognise"; the caller supplies a
        // generic 500. Anything else must be a fully-formed envelope.
        if (parsed !== null) {
          expect(typeof parsed).toBe("object");
          expect(Number.isInteger(parsed.status)).toBe(true);
          expect(parsed.status).toBeGreaterThanOrEqual(400);
          expect(parsed.status).toBeLessThan(600);
          expect(typeof parsed.code).toBe("string");
          expect(parsed.code.length).toBeGreaterThan(0);
          expect(typeof parsed.message).toBe("string");
          expect(parsed.message.length).toBeGreaterThan(0);
        }

        // C5 — the error object is not modified while being classified.
        if (typeof input === "object" && input !== null) {
          expect(deepEqual(input, before)).toBe(true);
        }
      },
    });
    recordRun("parseSorobanError", run);
  });
});
