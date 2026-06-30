import { describe, test, expect, jest } from "@jest/globals";
import { validateRoyaltySplitMiddleware } from "../src/validation.js";

describe("validateRoyaltySplitMiddleware (#228)", () => {
  const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  test("validates Stellar public keys cleanly", () => {
    const req = {
      body: {
        recipients: [
          { address: "INVALID_KEY", percentage: 50 },
          { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", percentage: 50 },
        ],
      },
    };
    const res = mockRes();
    const next = jest.fn();

    validateRoyaltySplitMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(JSON.stringify(payload)).toMatch(/Invalid Stellar/i);
  });

  test("validates percentage sums (sums to exactly 100)", () => {
    const req = {
      body: {
        recipients: [
          { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", percentage: 40 },
          { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", percentage: 40 },
        ],
      },
    };
    const res = mockRes();
    const next = jest.fn();

    validateRoyaltySplitMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(JSON.stringify(payload)).toMatch(/sum to exactly 100/i);
  });

  test("passes valid recipients payload and normalizes collaborators/shares", () => {
    const req = {
      body: {
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        recipients: [
          { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", percentage: 60 },
          { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", percentage: 40 },
        ],
      },
    };
    const res = mockRes();
    const next = jest.fn();

    validateRoyaltySplitMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body.collaborators).toEqual([
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ]);
    expect(req.body.shares).toEqual([6000, 4000]);
  });

  test("passes valid collaborators + shares payload standardly", () => {
    const req = {
      body: {
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        collaborators: ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
        shares: [10000],
      },
    };
    const res = mockRes();
    const next = jest.fn();

    validateRoyaltySplitMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
