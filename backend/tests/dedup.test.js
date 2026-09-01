import { jest, describe, test, expect, beforeEach } from "@jest/globals";

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const { dedupMiddleware, dedupMetrics } = await import("../src/middleware/dedup.js");

function makeReqRes(body = {}) {
  const req = { body, ip: "127.0.0.1" };
  const res = {
    _status: 200,
    _body: null,
    statusCode: 200,
    status(code) { this._status = code; this.statusCode = code; return this; },
    json(payload) { this._body = payload; return this; },
  };
  // Expose interceptable json
  return { req, res };
}

describe("dedupMiddleware", () => {
  beforeEach(() => {
    dedupMetrics.hits = 0;
    dedupMetrics.misses = 0;
  });

  test("passes through when body has no contractId", (done) => {
    const { req, res } = makeReqRes({ walletAddress: "GABC" });
    dedupMiddleware()(req, res, () => {
      expect(dedupMetrics.misses).toBe(1);
      done();
    });
  });

  test("first request is counted as a miss and calls next", (done) => {
    const { req } = makeReqRes({ contractId: "CA", walletAddress: "GB", tokenId: "CT" });
    const res = {
      statusCode: 200,
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };
    dedupMiddleware()(req, res, () => {
      expect(dedupMetrics.misses).toBeGreaterThan(0);
      // simulate response so in-flight is cleared
      res.json({ xdr: "x", transactionId: "t" });
      done();
    });
  });

  test("duplicate request within window shares first response", async () => {
    let firstNext;
    const firstRes = {
      statusCode: 200,
      _body: null,
      json(payload) { this._body = payload; return this; },
      status(code) { this.statusCode = code; return this; },
    };
    const req1 = { body: { contractId: "CB", walletAddress: "GW", tokenId: "TK" } };
    const req2 = { body: { contractId: "CB", walletAddress: "GW", tokenId: "TK" } };

    // First request: capture its next
    const firstPromise = new Promise((resolve) => {
      firstNext = resolve;
    });
    dedupMiddleware()(req1, firstRes, firstNext);

    // Second request arrives before first completes
    const secondRes = {
      statusCode: 200,
      _received: null,
      json(payload) { this._received = payload; return this; },
      status(code) { this.statusCode = code; return this; },
    };
    dedupMiddleware()(req2, secondRes, () => {});

    // Complete first request
    firstRes.json({ xdr: "shared-xdr", transactionId: "shared-id" });
    await firstPromise;

    // Give the Promise chain a tick to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(dedupMetrics.hits).toBeGreaterThan(0);
    expect(secondRes._received).toEqual({ xdr: "shared-xdr", transactionId: "shared-id" });
  });

  test("after first request completes, same key starts a fresh in-flight", (done) => {
    const req = { body: { contractId: "CC", walletAddress: "GX", tokenId: "TY" } };
    const res1 = {
      statusCode: 200,
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };
    dedupMetrics.misses = 0;
    dedupMiddleware()(req, res1, () => {
      res1.json({ xdr: "a", transactionId: "b" });
      // Second call to the same route after first completes
      const res2 = {
        statusCode: 200,
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      };
      dedupMiddleware()(req, res2, () => {
        expect(dedupMetrics.misses).toBeGreaterThanOrEqual(2);
        res2.json({ xdr: "c", transactionId: "d" });
        done();
      });
    });
  });
});
