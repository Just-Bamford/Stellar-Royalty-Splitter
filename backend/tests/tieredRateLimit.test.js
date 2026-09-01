import { jest, describe, test, expect, beforeEach } from "@jest/globals";

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const { contractLimiter, walletLimiter, tieredLimiters, rateLimitMetrics } =
  await import("../src/middleware/tieredRateLimit.js");

function makeReqRes(body = {}, ip = "127.0.0.1") {
  const req = { body, ip, headers: {}, socket: { remoteAddress: ip } };
  const headers = {};
  const res = {
    _status: null,
    _body: null,
    statusCode: 200,
    status(code) { this._status = code; this.statusCode = code; return this; },
    json(payload) { this._body = payload; return this; },
    set(key, val) { headers[key] = val; return this; },
    setHeader(key, val) { headers[key] = val; },
    getHeader(key) { return headers[key]; },
    headers,
  };
  return { req, res };
}

describe("contractLimiter", () => {
  beforeEach(() => {
    rateLimitMetrics.contractHits = 0;
  });

  test("is a function (express middleware)", () => {
    expect(typeof contractLimiter).toBe("function");
  });

  test("skips when contractId is absent", (done) => {
    const { req, res } = makeReqRes({ walletAddress: "GW" });
    contractLimiter(req, res, () => done());
  });

  test("calls next when under the limit", (done) => {
    const { req, res } = makeReqRes({ contractId: "CA", walletAddress: "GW" });
    contractLimiter(req, res, () => done());
  });
});

describe("walletLimiter", () => {
  beforeEach(() => {
    rateLimitMetrics.walletHits = 0;
  });

  test("is a function (express middleware)", () => {
    expect(typeof walletLimiter).toBe("function");
  });

  test("skips when walletAddress is absent", (done) => {
    const { req, res } = makeReqRes({ contractId: "CA" });
    walletLimiter(req, res, () => done());
  });

  test("calls next when under the limit", (done) => {
    const { req, res } = makeReqRes({ contractId: "CA", walletAddress: "GW" });
    walletLimiter(req, res, () => done());
  });
});

describe("tieredLimiters", () => {
  test("exports an array of two middleware functions", () => {
    expect(Array.isArray(tieredLimiters)).toBe(true);
    expect(tieredLimiters).toHaveLength(2);
    tieredLimiters.forEach((m) => expect(typeof m).toBe("function"));
  });

  test("both limiters pass through a normal request in sequence", (done) => {
    const { req, res } = makeReqRes({ contractId: "CB", walletAddress: "GX" });
    let called = 0;
    const runNext = () => {
      called++;
      if (called < tieredLimiters.length) {
        tieredLimiters[called](req, res, runNext);
      } else {
        expect(called).toBe(tieredLimiters.length);
        done();
      }
    };
    tieredLimiters[0](req, res, runNext);
  });
});

describe("rateLimitMetrics", () => {
  test("exports an object with contractHits, walletHits, ipHits", () => {
    expect(rateLimitMetrics).toHaveProperty("contractHits");
    expect(rateLimitMetrics).toHaveProperty("walletHits");
    expect(rateLimitMetrics).toHaveProperty("ipHits");
  });
});
