/**
 * Fuzz: API request-body validation (#866).
 *
 * Target: the zod schemas and middleware in `backend/src/validation.js`, which
 * are the only thing standing between an untrusted request body and the
 * transaction builder. These properties reuse the real exported schemas — no
 * parallel test-only validator — so a change to a schema is immediately
 * exercised here.
 *
 * ── Invariants asserted ────────────────────────────────────────────────────
 *
 *  V1  Total: `safeParse` settles for every input. It returns a result object
 *      or throws a normal Error; it never kills the process and never throws a
 *      non-Error value. Validation is the outermost untrusted-input boundary,
 *      so an uncaught crash here is a denial-of-service.
 *
 *  V2  Deterministic: parsing the same input twice yields the same verdict.
 *      A validator whose answer depends on hidden state cannot be reasoned
 *      about, and would make every other invariant untestable.
 *
 *  V3  Non-mutating: `safeParse` does not modify the caller's object. Callers
 *      in `routes/` hold a reference to `req.body` across the call; silent
 *      in-place edits would be invisible action at a distance.
 *
 *  V4  Rejection is explained: a failed parse always carries at least one
 *      issue with a path and a message, so the 400 response can name the bad
 *      field instead of returning an opaque failure.
 *
 *  V5  Accepted output is well-formed: if a body is accepted, the normalised
 *      `data` still satisfies every documented constraint — addresses match
 *      their format, shares still sum to 10 000, list lengths are still under
 *      their caps. This is the "no silently corrupted output" guarantee: a
 *      schema must never launder an invalid value into a valid-looking one.
 *
 *  V6  Round-trip safe: accepted output survives JSON serialisation unchanged,
 *      which is what the transaction builder and the audit log both rely on.
 *
 * Reproduction: every failure prints `FUZZ_SEED=<n>`; re-run with that env var
 * set to replay the exact case. See tests/fuzz/README.md.
 */

import { describe, test, expect } from "@jest/globals";

import {
  initializeSchema,
  distributeSchema,
  batchDistributeSchema,
  recordSecondarySaleSchema,
  MAX_COLLABORATORS,
  MAX_BATCH_OPERATIONS,
  MAX_NFT_ID_LENGTH,
  MAX_SALE_PRICE,
} from "../../../backend/src/validation.js";
import { isValidStellarAccountAddress } from "../../../shared/stellar-address.js";
import { forAll, settles, deepEqual, snapshot } from "../property.js";
import { resolveCases } from "../random.js";
import {
  initializeBody,
  distributeBody,
  batchDistributeBody,
  recordSecondarySaleBody,
} from "../generators/payloads.js";
import { recordRun } from "../report.js";

const CASES = resolveCases();
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/** V1–V4, applied to every schema the suite covers. */
function assertUniversalInvariants(schema, body, label) {
  const before = snapshot(body);

  // V1 — must settle rather than crash the process.
  const first = settles(() => schema.safeParse(body));
  expect(first.ok).toBe(true);
  const result = first.value;
  expect(typeof result).toBe("object");
  expect(typeof result.success).toBe("boolean");

  // V2 — same input, same verdict.
  const second = settles(() => schema.safeParse(body));
  expect(second.ok).toBe(true);
  expect(second.value.success).toBe(result.success);

  // V3 — the caller's object is untouched.
  expect(deepEqual(body, before)).toBe(true);

  // V4 — a rejection names what went wrong.
  if (!result.success) {
    expect(Array.isArray(result.error.issues)).toBe(true);
    expect(result.error.issues.length).toBeGreaterThan(0);
    for (const issue of result.error.issues) {
      expect(typeof issue.message).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
      expect(Array.isArray(issue.path)).toBe(true);
    }
  }

  return result;
}

/**
 * V6 — accepted data survives a JSON round trip byte-identically.
 *
 * Compared re-encode to re-encode rather than decode to original: an optional
 * field present with the value `undefined` is dropped by JSON.stringify, so a
 * decode-vs-original key comparison would flag standard JSON semantics as
 * corruption. What actually matters is that the encoding is stable — encode,
 * decode, and re-encode must produce the same bytes, which is exactly the
 * property the audit log and the transaction builder depend on.
 */
function assertRoundTrips(data) {
  const encoded = JSON.stringify(data);
  expect(typeof encoded).toBe("string");

  const decoded = JSON.parse(encoded);
  expect(JSON.stringify(decoded)).toBe(encoded);

  // No value may change on the way through — only absent-vs-undefined keys
  // are allowed to differ, which the re-encode comparison above already pins.
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    expect(deepEqual(decoded[key], value)).toBe(true);
  }
}

describe("fuzz: API request validation (#866)", () => {
  test(`initializeSchema holds its invariants over ${CASES} generated bodies`, () => {
    const run = forAll({
      name: "initializeSchema",
      cases: CASES,
      generate: (rng) => initializeBody(rng),
      check: ({ body, expectValid }) => {
        const result = assertUniversalInvariants(initializeSchema, body, "initialize");

        if (result.success) {
          // V5 — nothing invalid may survive as "accepted".
          const { data } = result;
          expect(CONTRACT_ID_PATTERN.test(data.contractId)).toBe(true);
          expect(isValidStellarAccountAddress(data.walletAddress)).toBe(true);
          expect(data.collaborators.length).toBe(data.shares.length);
          expect(data.collaborators.length).toBeGreaterThanOrEqual(1);
          expect(data.collaborators.length).toBeLessThanOrEqual(MAX_COLLABORATORS);
          for (const addr of data.collaborators) {
            expect(isValidStellarAccountAddress(addr)).toBe(true);
          }
          for (const share of data.shares) {
            expect(Number.isInteger(share)).toBe(true);
            expect(share).toBeGreaterThanOrEqual(0);
            expect(share).toBeLessThanOrEqual(10000);
          }
          // The single most important arithmetic guarantee: an accepted split
          // always adds up, so the contract can never be initialised with a
          // configuration that strands or over-allocates funds.
          expect(data.shares.reduce((a, b) => a + b, 0)).toBe(10000);
          assertRoundTrips(data);
        } else if (expectValid) {
          // A body the generator built to be valid must not be rejected.
          throw new Error(
            `known-good body rejected: ${JSON.stringify(result.error.issues)}`
          );
        }
      },
    });
    recordRun("initializeSchema", run);
  });

  test(`distributeSchema holds its invariants over ${CASES} generated bodies`, () => {
    const run = forAll({
      name: "distributeSchema",
      cases: CASES,
      generate: (rng) => distributeBody(rng),
      check: ({ body, expectValid }) => {
        const result = assertUniversalInvariants(distributeSchema, body, "distribute");

        if (result.success) {
          const { data } = result;
          expect(CONTRACT_ID_PATTERN.test(data.contractId)).toBe(true);
          expect(CONTRACT_ID_PATTERN.test(data.tokenId)).toBe(true);
          expect(isValidStellarAccountAddress(data.walletAddress)).toBe(true);

          if (data.amount !== undefined) {
            // An accepted amount is either a positive finite number or a
            // canonical digit string — never NaN, never negative, never a
            // string the downstream BigInt conversion would reject.
            if (typeof data.amount === "number") {
              expect(Number.isFinite(data.amount)).toBe(true);
              expect(data.amount).toBeGreaterThan(0);
            } else {
              expect(typeof data.amount).toBe("string");
              expect(/^[1-9]\d*$/.test(data.amount)).toBe(true);
              expect(() => BigInt(data.amount)).not.toThrow();
            }
          }
          assertRoundTrips(data);
        } else if (expectValid) {
          throw new Error(
            `known-good body rejected: ${JSON.stringify(result.error.issues)}`
          );
        }
      },
    });
    recordRun("distributeSchema", run);
  });

  test(`batchDistributeSchema holds its invariants over ${CASES} generated bodies`, () => {
    const run = forAll({
      name: "batchDistributeSchema",
      cases: CASES,
      generate: (rng) => batchDistributeBody(rng),
      check: ({ body, expectValid }) => {
        const result = assertUniversalInvariants(batchDistributeSchema, body, "batch");

        if (result.success) {
          const { data } = result;
          expect(isValidStellarAccountAddress(data.walletAddress)).toBe(true);
          expect(Array.isArray(data.operations)).toBe(true);
          expect(data.operations.length).toBeGreaterThanOrEqual(1);
          // The batch cap is a resource-exhaustion guard: exceeding it would
          // build a transaction too large for Soroban to simulate.
          expect(data.operations.length).toBeLessThanOrEqual(MAX_BATCH_OPERATIONS);
          for (const op of data.operations) {
            expect(CONTRACT_ID_PATTERN.test(op.contractId)).toBe(true);
            expect(CONTRACT_ID_PATTERN.test(op.tokenId)).toBe(true);
          }
          assertRoundTrips(data);
        } else if (expectValid) {
          throw new Error(
            `known-good body rejected: ${JSON.stringify(result.error.issues)}`
          );
        }
      },
    });
    recordRun("batchDistributeSchema", run);
  });

  test(`recordSecondarySaleSchema holds its invariants over ${CASES} generated bodies`, () => {
    const run = forAll({
      name: "recordSecondarySaleSchema",
      cases: CASES,
      generate: (rng) => recordSecondarySaleBody(rng),
      check: ({ body, expectValid }) => {
        const result = assertUniversalInvariants(
          recordSecondarySaleSchema,
          body,
          "secondary-sale"
        );

        if (result.success) {
          const { data } = result;
          expect(CONTRACT_ID_PATTERN.test(data.contractId)).toBe(true);
          expect(CONTRACT_ID_PATTERN.test(data.saleToken)).toBe(true);
          expect(isValidStellarAccountAddress(data.walletAddress)).toBe(true);
          expect(isValidStellarAccountAddress(data.previousOwner)).toBe(true);
          expect(isValidStellarAccountAddress(data.newOwner)).toBe(true);

          expect(data.nftId.length).toBeGreaterThanOrEqual(1);
          expect(data.nftId.length).toBeLessThanOrEqual(MAX_NFT_ID_LENGTH);

          // salePrice feeds basis-point arithmetic. If a value past
          // MAX_SAFE_INTEGER were accepted it would already have lost
          // precision before the royalty was computed.
          expect(Number.isInteger(data.salePrice)).toBe(true);
          expect(data.salePrice).toBeGreaterThan(0);
          expect(data.salePrice).toBeLessThanOrEqual(MAX_SALE_PRICE);
          expect(Number.isSafeInteger(data.salePrice)).toBe(true);

          expect(Number.isInteger(data.royaltyRate)).toBe(true);
          expect(data.royaltyRate).toBeGreaterThanOrEqual(0);
          expect(data.royaltyRate).toBeLessThanOrEqual(10000);

          // The royalty cut must be computable without overflow.
          const royalty = (data.salePrice * data.royaltyRate) / 10000;
          expect(Number.isFinite(royalty)).toBe(true);

          assertRoundTrips(data);
        } else if (expectValid) {
          throw new Error(
            `known-good body rejected: ${JSON.stringify(result.error.issues)}`
          );
        }
      },
    });
    recordRun("recordSecondarySaleSchema", run);
  });
});
