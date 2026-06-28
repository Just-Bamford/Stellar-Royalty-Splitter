import { describe, test, expect, jest } from "@jest/globals";
import { validateInitializePayloadSize } from "../src/validation.js";

describe("Standardized error responses (#227)", () => {
  const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  test("validateInitializePayloadSize returns standardized error payload on oversized body", () => {
    const req = {
      body: { data: "x".repeat(100_000) },
    };
    const res = mockRes();
    const next = jest.fn();

    validateInitializePayloadSize(req, res, next);
    expect(res.status).toHaveBeenCalledWith(413);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({
      status: 413,
      code: "payload_too_large",
      message: "Payload too large",
    });
    expect(typeof body.timestamp).toBe("string");
  });

  test("validateInitializePayloadSize returns standardized error on oversized collaborators", () => {
    const req = {
      body: {
        collaborators: Array.from({ length: 145 }, () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      },
    };
    const res = mockRes();
    const next = jest.fn();

    validateInitializePayloadSize(req, res, next);
    expect(res.status).toHaveBeenCalledWith(413);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({
      status: 413,
      code: "payload_too_large",
      message: "Collaborators payload too large",
    });
  });
});
