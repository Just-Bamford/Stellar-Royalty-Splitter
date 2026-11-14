/**
 * Tests for ENS address validation and parameterized GraphQL resolution (#1319).
 */
import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { notFoundHandler, errorHandler } from "../src/error-response.js";
import {
  identityRouter,
  clearEnsCache,
  ETH_ADDRESS_REGEX,
  isValidEthAddress,
} from "../src/routes/identity.js";

const app = express();
app.use(express.json());
app.use("/api/v1/identity", identityRouter);
app.use(notFoundHandler);
app.use(errorHandler);

const VALID_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const CHECKSUMMED_ADDRESS = "0xAbCdEf1234567890aBcDeF1234567890AbCdEf12";

describe("ENS Ethereum address validation & GraphQL parameterization (#1319)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    clearEnsCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe("isValidEthAddress", () => {
    test("accepts lowercase and mixed-case 40-hex-char 0x addresses", () => {
      expect(ETH_ADDRESS_REGEX.test(VALID_ADDRESS)).toBe(true);
      expect(isValidEthAddress(VALID_ADDRESS)).toBe(true);
      expect(isValidEthAddress(CHECKSUMMED_ADDRESS)).toBe(true);
    });

    test("rejects malformed strings, Stellar addresses, and GraphQL injection payloads", () => {
      expect(isValidEthAddress("not-an-address")).toBe(false);
      expect(isValidEthAddress("0x12345")).toBe(false);
      expect(isValidEthAddress("1234567890abcdef1234567890abcdef12345678")).toBe(false);
      expect(isValidEthAddress("0x1234567890abcdef1234567890abcdef1234567g")).toBe(false);
      expect(isValidEthAddress("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")).toBe(
        false
      );
      expect(isValidEthAddress('0x1234"}, first: 1) { name } #')).toBe(false);
      expect(isValidEthAddress(null)).toBe(false);
      expect(isValidEthAddress(undefined)).toBe(false);
    });
  });

  describe("GET /api/v1/identity/ens/:address", () => {
    test("returns 400 for non-Ethereum addresses without querying the subgraph", async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock;

      const res = await request(app).get("/api/v1/identity/ens/not-an-address");

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_address");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("rejects crafted GraphQL injection payloads with 400 and never invokes fetch", async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock;

      const payload = encodeURIComponent('"x"}, first: 1) { name } #');
      const res = await request(app).get(`/api/v1/identity/ens/${payload}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_address");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("queries the ENS subgraph using GraphQL variables for a valid Ethereum address", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              domains: [{ name: "alice.eth", resolver: { texts: ["avatar"] } }],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              resolver: { texts: ["avatar", "url"] },
            },
          }),
        });
      global.fetch = fetchMock;

      const res = await request(app).get(`/api/v1/identity/ens/${CHECKSUMMED_ADDRESS}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        name: "alice.eth",
        avatar: "https://metadata.ens.domains/mainnet/avatar/alice.eth",
        verified: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(firstBody.variables).toEqual({
        address: CHECKSUMMED_ADDRESS.toLowerCase(),
      });
      expect(firstBody.query).toContain("$address: String!");
      expect(firstBody.query).not.toContain(CHECKSUMMED_ADDRESS.toLowerCase());

      const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(secondBody.variables).toEqual({
        id: CHECKSUMMED_ADDRESS.toLowerCase(),
      });
      expect(secondBody.query).toContain("$id: ID!");
      expect(secondBody.query).not.toContain(CHECKSUMMED_ADDRESS.toLowerCase());
    });

    test("returns 404 when a valid Ethereum address has no ENS record", async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { domains: [] } }),
      });

      const res = await request(app).get(`/api/v1/identity/ens/${VALID_ADDRESS}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("not_found");
    });
  });
});
