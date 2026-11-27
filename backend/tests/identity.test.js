import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import { identityRouter } from "../src/routes/identity.js";

const app = express();
app.use(express.json());
app.use("/api/v1/identity", identityRouter);

describe("Identity ENS Routes (#1319)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  test("GET /api/v1/identity/ens/not-an-address returns 400", async () => {
    const res = await request(app).get("/api/v1/identity/ens/not-an-address");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_address");
  });

  test("GET /api/v1/identity/ens/:address rejects GraphQL injection attempts with 400", async () => {
    const malicious = '0x1234"}first:1){name}#';
    const res = await request(app).get(`/api/v1/identity/ens/${encodeURIComponent(malicious)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_address");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("GET /api/v1/identity/ens/0x1234567890abcdef1234567890abcdef12345678 passes validation and queries the subgraph with variables", async () => {
    const validAddress = "0x1234567890abcdef1234567890abcdef12345678";

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          domains: [
            {
              name: "vitalik.eth",
              resolver: { texts: ["avatar"] },
            },
          ],
        },
      }),
    });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          resolver: { texts: ["avatar"] },
        },
      }),
    });

    const res = await request(app).get(`/api/v1/identity/ens/${validAddress}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("vitalik.eth");
    expect(res.body.verified).toBe(true);

    // Verify fetch was called with GraphQL query and variables
    expect(global.fetch).toHaveBeenCalled();
    const firstCallBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(firstCallBody.variables).toEqual({
      resolvedAddress: validAddress.toLowerCase(),
    });
    expect(firstCallBody.query).toContain("query ResolveEns($resolvedAddress: String!)");
  });
});
