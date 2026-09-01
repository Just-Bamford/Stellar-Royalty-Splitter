/**
 * Fuzz: serialization, numeric boundaries, and oversized/nested payloads (#866).
 *
 * Target: the size and shape guards that run *before* schema validation —
 * `validateInitializePayloadSize`, `validateContractIdMiddleware`,
 * `validateStellarAddress`, `validateContractId` — plus the cursor
 * encode/decode pair (`encodeCursor` / `parseCursorPagination`) and the
 * basis-point arithmetic those guards protect.
 *
 * These run on every request, on the untrusted side of the boundary, and they
 * are the code most likely to be handed something that is not a string at all.
 *
 * ── Invariants asserted ────────────────────────────────────────────────────
 *
 *  S1  Total: every guard settles on every input, including deeply nested
 *      objects, oversized strings, and wrong types. A guard that throws
 *      escapes to the Express error handler as a 500, turning a client mistake
 *      into a server fault — and a guard that recurses without a depth limit
 *      on nested input is a remote stack-overflow.
 *
 *  S2  Exactly one outcome: a guard either calls `next()` (accept) or writes a
 *      response (reject). Never both, never neither. Doing both would emit a
 *      second set of headers; doing neither hangs the request until timeout.
 *
 *  S3  Rejections carry a 4xx status and a machine-readable error code, so
 *      clients can distinguish "your input was wrong" from "we broke".
 *
 *  S4  Size guards are monotonic: if a payload is rejected as too large, every
 *      strictly larger payload is also rejected. A non-monotonic size check is
 *      a bypass — an attacker just adds padding until it passes.
 *
 *  S5  Cursor round trip: `encodeCursor(t, id)` decodes back to exactly
 *      `{timestamp: t, id}`. This is the "serialization/deserialization does
 *      not silently corrupt valid values" criterion — a corrupted cursor
 *      silently skips or repeats a page of audit history.
 *
 *  S6  Cursor decoding is total: arbitrary base64, non-base64, and hostile
 *      JSON are rejected cleanly rather than crashing or yielding a partial
 *      cursor object.
 *
 *  S7  Basis-point arithmetic is exact and conserving across the full range of
 *      accepted amounts: the split never creates or destroys value, and the
 *      dust remainder is bounded by the recipient count.
 */

import { describe, test, expect, jest } from "@jest/globals";

import {
  validateInitializePayloadSize,
  validateContractIdMiddleware,
  validateContractId,
  validateStellarAddress,
  encodeCursor,
  parseCursorPagination,
  INITIALIZE_PAYLOAD_LIMIT_BYTES,
  INITIALIZE_COLLABORATORS_PAYLOAD_LIMIT_BYTES,
} from "../../../backend/src/validation.js";
import { forAll, settles, deepEqual, snapshot } from "../property.js";
import { resolveCases } from "../random.js";
import {
  validStellarAddress,
  validContractAddress,
  malformedStellarAddress,
  malformedContractAddress,
  boundaryInteger,
  hostileString,
  hostileTextOnly,
  oversizedString,
  deeplyNested,
  malformedJsonText,
  unexpectedType,
} from "../generators/primitives.js";
import { exactShares } from "../generators/payloads.js";
import { recordRun } from "../report.js";

const CASES = resolveCases();

/**
 * Minimal Express response double. Records the status and body a guard writes
 * so S2/S3 can be checked without spinning up a server.
 */
function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    send(payload) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

/** Run a middleware and report which of the two legal outcomes occurred. */
function runMiddleware(middleware, req) {
  const res = makeRes();
  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
  };

  const outcome = settles(() => middleware(req, res, next));
  return { outcome, res, nextCalls };
}

/** S1–S3, shared by every middleware guard. */
function assertGuardContract({ outcome, res, nextCalls }) {
  // S1 — the guard settled.
  expect(outcome.ok).toBe(true);

  const accepted = nextCalls > 0;
  const rejected = res.headersSent;

  // S2 — exactly one outcome, exactly once.
  expect(nextCalls).toBeLessThanOrEqual(1);
  expect(accepted !== rejected).toBe(true);

  // S3 — a rejection is a well-formed 4xx.
  if (rejected) {
    expect(Number.isInteger(res.statusCode)).toBe(true);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).not.toBeNull();
  }

  return accepted;
}

describe("fuzz: payload size and shape guards (#866)", () => {
  test(`validateInitializePayloadSize stays total over ${CASES} generated bodies`, () => {
    const run = forAll({
      name: "validateInitializePayloadSize",
      cases: CASES,
      generate: (rng) => {
        const kind = rng.weighted([
          ["small", 3],
          ["at-limit", 3],
          ["over-limit", 3],
          ["many-collaborators", 3],
          ["nested", 3],
          ["oversized-field", 2],
          ["not-object", 2],
          ["missing-body", 2],
        ]);

        switch (kind) {
          case "small":
            return { body: { contractId: validContractAddress(rng), collaborators: [] } };
          case "at-limit":
            return { body: { pad: "A".repeat(INITIALIZE_PAYLOAD_LIMIT_BYTES - 20) } };
          case "over-limit":
            return { body: { pad: "A".repeat(INITIALIZE_PAYLOAD_LIMIT_BYTES + rng.int(1, 4096)) } };
          case "many-collaborators":
            return {
              body: {
                collaborators: rng.array(rng.int(1, 400), () => validStellarAddress(rng)),
              },
            };
          case "nested":
            // A recursive size walk would blow the stack here; JSON.stringify
            // is depth-limited, so the guard must survive either way.
            return { body: deeplyNested(rng) };
          case "oversized-field":
            return { body: { note: oversizedString(rng) } };
          case "not-object":
            // Restricted to values `express.json()` can actually produce.
            // A symbol body would make JSON.stringify return undefined and
            // Buffer.byteLength throw, but no JSON parser can construct one,
            // so pinning that would encode a requirement the guard does not
            // need to meet.
            return { body: rng.pick([null, "a string", 42, true, [], {}]) };
          default:
            return {};
        }
      },
      check: (req) => {
        const before = req.body === undefined ? undefined : snapshot(req.body);
        const result = runMiddleware(validateInitializePayloadSize, req);
        assertGuardContract(result);

        // The guard is a read-only check; it must not rewrite the body.
        if (req.body !== undefined && typeof req.body === "object" && req.body !== null) {
          expect(deepEqual(req.body, before)).toBe(true);
        }
      },
    });
    recordRun("validateInitializePayloadSize", run);
  });

  test("payload size rejection is monotonic in payload size", () => {
    // S4 — a dedicated deterministic property: growing a rejected payload can
    // never make it acceptable. Run over the boundary region rather than
    // randomly, because that is the only place the answer can flip.
    const run = forAll({
      name: "payloadSizeMonotonicity",
      cases: Math.min(CASES, 400),
      generate: (rng) => {
        const base = rng.int(
          INITIALIZE_PAYLOAD_LIMIT_BYTES - 200,
          INITIALIZE_PAYLOAD_LIMIT_BYTES + 200
        );
        return { base, growth: rng.int(1, 2048) };
      },
      check: ({ base, growth }) => {
        const accept = (size) => {
          const req = { body: { pad: "A".repeat(Math.max(size, 0)) } };
          return assertGuardContract(runMiddleware(validateInitializePayloadSize, req));
        };

        const smallerAccepted = accept(base);
        const largerAccepted = accept(base + growth);

        if (!smallerAccepted) {
          expect(largerAccepted).toBe(false);
        }
      },
    });
    recordRun("payloadSizeMonotonicity", run);
  });

  test("collaborators sub-payload cap is enforced independently of the total cap", () => {
    // The two caps are separate limits (10 KB total, 8 KB collaborators). A
    // body under the total cap but over the collaborators cap must still be
    // rejected — otherwise the tighter on-chain-facing limit is unenforced.
    const collaboratorsBytes = INITIALIZE_COLLABORATORS_PAYLOAD_LIMIT_BYTES;
    const oversizedCollaborators = { collaborators: ["A".repeat(collaboratorsBytes + 256)] };
    const result = runMiddleware(validateInitializePayloadSize, { body: oversizedCollaborators });
    expect(assertGuardContract(result)).toBe(false);
    expect(result.res.statusCode).toBe(413);
  });

  test(`contract-id and address guards stay total over ${CASES} generated values`, () => {
    const run = forAll({
      name: "identifierGuards",
      cases: CASES,
      generate: (rng) => ({
        contractId: rng.weighted([
          [validContractAddress(rng), 3],
          [malformedContractAddress(rng), 5],
          [oversizedString(rng), 1],
          [hostileString(rng, { maxLength: 64 }), 2],
          [unexpectedType(rng), 2],
        ]),
        address: rng.weighted([
          [validStellarAddress(rng), 3],
          [malformedStellarAddress(rng), 5],
          [oversizedString(rng), 1],
          [unexpectedType(rng), 2],
        ]),
      }),
      check: ({ contractId, address }) => {
        // Middleware form.
        const middlewareResult = runMiddleware(validateContractIdMiddleware, {
          params: { contractId },
        });
        const accepted = assertGuardContract(middlewareResult);
        if (accepted) {
          // Only a canonical C-address may pass.
          expect(/^C[A-Z2-7]{55}$/.test(contractId)).toBe(true);
        }

        // Predicate form — must agree with the middleware form. Two guards
        // for the same rule that disagree is a validation bypass waiting to
        // be found by whichever route uses the looser one.
        const predicateRes = makeRes();
        const predicate = settles(() => validateContractId(contractId, predicateRes));
        expect(predicate.ok).toBe(true);
        expect(predicate.value).toBe(accepted);

        // Address predicate.
        const addressRes = makeRes();
        const addressOutcome = settles(() => validateStellarAddress(address, addressRes));
        expect(addressOutcome.ok).toBe(true);
        expect(typeof addressOutcome.value).toBe("boolean");
        if (addressOutcome.value) {
          // The account guard validates the *normalised* address — see
          // shared/stellar-address.js, which trims before testing. Asserting
          // against the raw string here would be asserting a contract the
          // code does not offer; the surrounding-whitespace consequence of
          // that choice is pinned separately in the regression suite.
          expect(/^G[A-Z2-7]{55}$/.test(String(address).trim())).toBe(true);
        } else {
          expect(addressRes.statusCode).toBe(400);
        }
      },
    });
    recordRun("identifierGuards", run);
  });
});

describe("fuzz: cursor serialization (#866)", () => {
  test(`encodeCursor round-trips over ${CASES} generated cursors`, () => {
    const run = forAll({
      name: "cursorRoundTrip",
      cases: CASES,
      generate: (rng) => ({
        timestamp: rng.weighted([
          ["2026-01-01T00:00:00.000Z", 3],
          [`2026-${String(rng.int(1, 12)).padStart(2, "0")}-15T12:00:00.000Z`, 3],
          [String(rng.int(0, 2 ** 31 - 1)), 2],
          // Text-only: a cursor timestamp always arrives as a string from
          // the query string, and JSON cannot encode a symbol at all.
          [hostileTextOnly(rng, { maxLength: 48 }), 2],
        ]),
        id: rng.weighted([
          [rng.int(1, 1_000_000), 4],
          [1, 2],
          [Number.MAX_SAFE_INTEGER, 2],
          [boundaryInteger(rng), 2],
        ]),
      }),
      check: ({ timestamp, id }) => {
        const encoded = settles(() => encodeCursor(timestamp, id));
        expect(encoded.ok).toBe(true);
        expect(typeof encoded.value).toBe("string");

        const res = makeRes();
        const parsed = settles(() =>
          parseCursorPagination({ limit: "10", cursor: encoded.value }, res)
        );
        expect(parsed.ok).toBe(true);

        // S5 — a cursor this codebase produced must always be one this
        // codebase can consume, with both fields intact.
        //
        // Two exclusions, both properties of JSON rather than of this code:
        // falsy fields are rejected by the decoder's own presence check, and
        // non-finite numbers serialise to `null` (JSON has no Infinity/NaN),
        // so they cannot round-trip through any JSON-encoded cursor.
        const roundTrippable =
          Boolean(timestamp) && Boolean(id) && !(typeof id === "number" && !Number.isFinite(id));

        if (roundTrippable) {
          expect(parsed.value).not.toBeNull();
          expect(parsed.value.cursor).toEqual({ timestamp, id });
        }
      },
    });
    recordRun("cursorRoundTrip", run);
  });

  test(`cursor decoding stays total over ${CASES} malformed cursors`, () => {
    const run = forAll({
      name: "cursorDecodeTotality",
      cases: CASES,
      generate: (rng) => {
        const kind = rng.weighted([
          ["malformed-json-b64", 4],
          ["raw-junk", 3],
          ["oversized", 2],
          ["nested", 2],
          ["wrong-type", 2],
          ["valid-shape", 2],
        ]);

        switch (kind) {
          case "malformed-json-b64":
            return {
              limit: "10",
              cursor: Buffer.from(malformedJsonText(rng)).toString("base64"),
            };
          case "raw-junk":
            return { limit: "10", cursor: hostileString(rng, { maxLength: 128 }) };
          case "oversized":
            return { limit: "10", cursor: oversizedString(rng) };
          case "nested":
            return {
              limit: "10",
              cursor: Buffer.from(
                JSON.stringify(deeplyNested(rng, { maxDepth: 512 }))
              ).toString("base64"),
            };
          case "wrong-type":
            return { limit: "10", cursor: unexpectedType(rng) };
          default:
            return {
              limit: String(boundaryInteger(rng)),
              cursor: encodeCursor("2026-01-01T00:00:00.000Z", 1),
            };
        }
      },
      check: (query) => {
        const before = snapshot(query);
        const res = makeRes();

        // S6 — decoding never crashes on attacker-controlled input.
        const outcome = settles(() => parseCursorPagination(query, res));
        expect(outcome.ok).toBe(true);

        if (outcome.value === null) {
          // Rejection path: a 4xx was written.
          expect(res.headersSent).toBe(true);
          expect(res.statusCode).toBeGreaterThanOrEqual(400);
          expect(res.statusCode).toBeLessThan(500);
        } else {
          // Acceptance path: the result is fully formed, never partial.
          expect(res.headersSent).toBe(false);
          expect(Number.isInteger(outcome.value.limit)).toBe(true);
          expect(outcome.value.limit).toBeGreaterThan(0);
          if (outcome.value.cursor !== null) {
            expect(outcome.value.cursor.timestamp).toBeTruthy();
            expect(outcome.value.cursor.id).toBeTruthy();
          }
        }

        // The query object belongs to Express; the parser must not edit it.
        expect(deepEqual(query, before)).toBe(true);
      },
    });
    recordRun("cursorDecodeTotality", run);
  });
});

describe("fuzz: basis-point arithmetic boundaries (#866)", () => {
  test(`share splits conserve value over ${CASES} generated allocations`, () => {
    const run = forAll({
      name: "basisPointConservation",
      cases: CASES,
      generate: (rng) => ({
        recipients: rng.weighted([
          [rng.int(1, 10), 5],
          [1, 2],
          [10, 2],
        ]),
        amount: rng.weighted([
          [rng.int(1, 1_000_000), 4],
          [1, 2],
          [9999, 2],
          [10000, 2],
          [10001, 2],
          [Number.MAX_SAFE_INTEGER, 2],
          [rng.int(1, 10) - 1, 2], // amounts smaller than the recipient count
        ]),
      }),
      check: ({ recipients, amount }) => {
        const shares = exactShares(recipients);

        // Precondition on the generator itself: an exact split always sums to
        // the full 10 000 basis points regardless of recipient count.
        expect(shares.reduce((a, b) => a + b, 0)).toBe(10000);
        expect(shares.length).toBe(recipients);

        // Model the contract's integer split: floor each payout, then hand the
        // remainder to the last recipient. Uses BigInt because the JS `number`
        // path loses precision above 2^53 and would hide a real overflow bug.
        const total = BigInt(amount);
        const payouts = shares.map((share) => (total * BigInt(share)) / 10000n);
        const distributed = payouts.reduce((a, b) => a + b, 0n);
        const dust = total - distributed;

        // S7 — value is conserved: nothing is minted, nothing is stranded
        // beyond the bounded dust remainder.
        expect(dust).toBeGreaterThanOrEqual(0n);
        expect(dust).toBeLessThan(BigInt(recipients));

        const withDust = [...payouts];
        withDust[withDust.length - 1] += dust;
        expect(withDust.reduce((a, b) => a + b, 0n)).toBe(total);

        // No payout is negative, and none exceeds the total.
        for (const payout of withDust) {
          expect(payout).toBeGreaterThanOrEqual(0n);
          expect(payout).toBeLessThanOrEqual(total);
        }

        // Everyone is paid only once the amount is large enough that the
        // *smallest* share still floors above zero. "one stroop per recipient"
        // is not sufficient: with 3 recipients the split is 3333/3333/3334, so
        // an amount of 3 floors every payout to 0 and the whole sum lands in
        // dust. The real threshold is ceil(10000 / smallest share).
        const smallestShare = BigInt(Math.min(...shares));
        if (smallestShare > 0n && total * smallestShare >= 10000n) {
          for (const payout of withDust) {
            expect(payout).toBeGreaterThan(0n);
          }
        }
      },
    });
    recordRun("basisPointConservation", run);
  });
});
