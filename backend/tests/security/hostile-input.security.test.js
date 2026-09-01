/**
 * OWASP A04:2021 — Insecure Design (resource-exhaustion / hostile input)
 * OWASP A03:2021 — Injection (XSS payload handling at the validation boundary)
 *
 * Verifies that the validation layer bounds every attacker-controlled
 * dimension — collaborator count, payload size, numeric range, share totals —
 * and that script payloads are refused rather than stored and echoed.
 *
 * Removing MAX_COLLABORATORS, the basis-point bounds, the shares-sum
 * superRefine, or the payload-size guard makes these fail deterministically.
 */
import {
  initializeSchema,
  distributeSchema,
  basisPoints,
  validateInitializePayloadSize,
  MAX_COLLABORATORS,
  INITIALIZE_PAYLOAD_LIMIT_BYTES,
} from "../../src/validation.js";

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

const XSS_PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "javascript:alert(document.cookie)",
  "<svg/onload=alert(1)>",
  "\"><script>alert(String.fromCharCode(88,83,83))</script>",
  "<iframe src='javascript:alert(1)'></iframe>",
];

function nextMiddleware() {
  let called = false;
  const fn = () => {
    called = true;
  };
  fn.wasCalled = () => called;
  return fn;
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("Security — OWASP A04 Resource Exhaustion", () => {
  test("more than MAX_COLLABORATORS entries are refused", () => {
    const collaborators = Array.from({ length: MAX_COLLABORATORS + 1 }, () => VALID_WALLET);
    const shares = Array.from({ length: MAX_COLLABORATORS + 1 }, () => 1);

    const result = initializeSchema.safeParse({
      contractId: VALID_CONTRACT,
      walletAddress: VALID_WALLET,
      collaborators,
      shares,
    });

    expect(result.success).toBe(false);
  });

  test("a massively oversized collaborator array is refused", () => {
    const collaborators = Array.from({ length: 10_000 }, () => VALID_WALLET);
    const shares = Array.from({ length: 10_000 }, () => 1);

    const result = initializeSchema.safeParse({
      contractId: VALID_CONTRACT,
      walletAddress: VALID_WALLET,
      collaborators,
      shares,
    });

    expect(result.success).toBe(false);
  });

  test("an over-limit JSON body is rejected with 413 before handler logic", () => {
    const req = {
      body: {
        contractId: VALID_CONTRACT,
        walletAddress: VALID_WALLET,
        padding: "A".repeat(INITIALIZE_PAYLOAD_LIMIT_BYTES + 1024),
      },
    };
    const res = mockRes();
    const next = nextMiddleware();

    validateInitializePayloadSize(req, res, next);

    expect(next.wasCalled()).toBe(false);
    expect(res.statusCode).toBe(413);
    expect(res.body.code).toBe("payload_too_large");
  });

  test("a within-limit body passes the size guard", () => {
    const req = {
      body: {
        contractId: VALID_CONTRACT,
        walletAddress: VALID_WALLET,
        collaborators: [VALID_WALLET],
        shares: [10000],
      },
    };
    const res = mockRes();
    const next = nextMiddleware();

    validateInitializePayloadSize(req, res, next);

    expect(next.wasCalled()).toBe(true);
    expect(res.statusCode).toBeNull();
  });
});

describe("Security — numeric boundary enforcement", () => {
  test.each([
    [-1, "negative basis points"],
    [10001, "above 100%"],
    [Number.MAX_SAFE_INTEGER, "integer overflow attempt"],
    [1.5, "fractional basis points"],
    [NaN, "NaN"],
    [Infinity, "Infinity"],
    [-Infinity, "-Infinity"],
  ])("rejects %p (%s)", (value) => {
    expect(basisPoints.safeParse(value).success).toBe(false);
  });

  test("shares that do not sum to 10000 are refused", () => {
    const result = initializeSchema.safeParse({
      contractId: VALID_CONTRACT,
      walletAddress: VALID_WALLET,
      collaborators: [VALID_WALLET, VALID_WALLET],
      shares: [5000, 4000], // sums to 9000
    });
    expect(result.success).toBe(false);
  });

  test("shares summing above 10000 are refused", () => {
    const result = initializeSchema.safeParse({
      contractId: VALID_CONTRACT,
      walletAddress: VALID_WALLET,
      collaborators: [VALID_WALLET, VALID_WALLET],
      shares: [9000, 9000],
    });
    expect(result.success).toBe(false);
  });

  test("mismatched collaborators/shares lengths are refused", () => {
    const result = initializeSchema.safeParse({
      contractId: VALID_CONTRACT,
      walletAddress: VALID_WALLET,
      collaborators: [VALID_WALLET, VALID_WALLET],
      shares: [10000],
    });
    expect(result.success).toBe(false);
  });
});

describe("Security — OWASP A03 XSS payload handling", () => {
  // The API is JSON-only and stores addresses, not free text: script payloads
  // are refused at the schema boundary rather than sanitised downstream.
  test.each(XSS_PAYLOADS)("script payload %j is refused as an address", (payload) => {
    const result = initializeSchema.safeParse({
      contractId: VALID_CONTRACT,
      walletAddress: payload,
      collaborators: [VALID_WALLET],
      shares: [10000],
    });
    expect(result.success).toBe(false);
  });

  test.each(XSS_PAYLOADS)("script payload %j is refused as a contractId", (payload) => {
    expect(distributeSchema.safeParse({
      contractId: payload,
      walletAddress: VALID_WALLET,
    }).success).toBe(false);
  });
});

describe("Security — malformed and hostile structures", () => {
  test.each([
    [null],
    [undefined],
    ["a plain string"],
    [42],
    [[]],
    [true],
  ])("non-object body %j is refused", (body) => {
    expect(initializeSchema.safeParse(body).success).toBe(false);
  });

  test("a prototype-pollution payload does not alter Object.prototype", () => {
    const polluted = JSON.parse('{"__proto__": {"polluted": true}}');

    initializeSchema.safeParse(polluted);

    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
  });

  test("deeply nested input is refused without a stack overflow", () => {
    let nested = {};
    let cursor = nested;
    for (let i = 0; i < 5_000; i += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }

    expect(() => initializeSchema.safeParse(nested)).not.toThrow();
    expect(initializeSchema.safeParse(nested).success).toBe(false);
  });
});
