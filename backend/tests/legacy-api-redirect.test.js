import express from "express";
import http from "node:http";
import net from "node:net";
import request from "supertest";
import { describe, expect, jest, test } from "@jest/globals";
import {
  createLegacyApiRedirectMiddleware,
  validateLegacyApiRequestTarget,
} from "../src/legacy-api-redirect.js";

function createApp() {
  const logger = {
    warn: jest.fn(),
  };

  const app = express();
  app.use(createLegacyApiRedirectMiddleware({ logger }));
  app.get("/admin", (_req, res) => {
    res.status(200).json({ area: "admin" });
  });
  app.get("/api/v1/health", (_req, res) => {
    res.json({ ok: true });
  });

  return { app, logger };
}

function sendRawHttpRequest(app, requestTarget) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);

    server.listen(0, () => {
      const { port } = server.address();
      const client = net.createConnection({ port }, () => {
        client.write(
          `GET ${requestTarget} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
        );
      });

      const chunks = [];

      client.on("data", (chunk) => {
        chunks.push(chunk);
      });

      client.on("error", (error) => {
        server.close(() => reject(error));
      });

      client.on("end", () => {
        server.close(() => {
          const rawResponse = Buffer.concat(chunks).toString("utf8");
          const [head, body = ""] = rawResponse.split("\r\n\r\n");
          const [statusLine, ...headerLines] = head.split("\r\n");
          const headers = {};

          for (const line of headerLines) {
            const separatorIndex = line.indexOf(":");
            if (separatorIndex === -1) continue;

            const key = line.slice(0, separatorIndex).trim().toLowerCase();
            const value = line.slice(separatorIndex + 1).trim();
            headers[key] = value;
          }

          resolve({
            body,
            headers,
            statusCode: Number.parseInt(statusLine.split(" ")[1], 10),
          });
        });
      });
    });
  });
}

describe("legacy API redirect security", () => {
  test("redirects allowlisted legacy API paths to /api/v1", async () => {
    const { app, logger } = createApp();

    const response = await request(app).get("/api/health?full=true");

    expect(response.status).toBe(308);
    expect(response.headers.location).toBe("/api/v1/health?full=true");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("does not interfere with already-versioned API routes", async () => {
    const { app, logger } = createApp();

    const response = await request(app).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("rejects legacy paths outside the allowlist so admin does not redirect", async () => {
    const { app, logger } = createApp();

    const response = await request(app).get("/api/admin");

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.body.code).toBe("invalid_legacy_api_path");
    expect(logger.warn).toHaveBeenCalledWith(
      "Rejected legacy API redirect target",
      expect.objectContaining({
        path: "/api/admin",
        reason: "disallowed_path",
      })
    );
  });

  test("rejects raw encoded traversal attempts before they can reach /admin", async () => {
    const { app, logger } = createApp();

    const response = await sendRawHttpRequest(app, "/api/%2e%2e/admin");
    const payload = JSON.parse(response.body);

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(payload.code).toBe("invalid_legacy_api_path");
    expect(logger.warn).toHaveBeenCalledWith(
      "Rejected legacy API redirect target",
      expect.objectContaining({
        path: "/api/%2e%2e/admin",
        reason: "path_traversal",
      })
    );
  });

  test("rejects traversal attempts encoded as an escaped slash", () => {
    const result = validateLegacyApiRequestTarget("/api/..%2fadmin");

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "path_traversal",
      })
    );
  });

  test("rejects traversal attempts encoded as a full ../ sequence", () => {
    const result = validateLegacyApiRequestTarget("/api/%2e%2e%2fadmin");

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "path_traversal",
      })
    );
  });

  test("rejects double-encoded traversal attempts after repeated decoding", () => {
    const result = validateLegacyApiRequestTarget("/api/%252e%252e/admin");

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "path_traversal",
      })
    );
  });

  test("rejects uppercase encoded traversal attempts", () => {
    const result = validateLegacyApiRequestTarget("/api/%2E%2E/admin");

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "path_traversal",
      })
    );
  });

  test("rejects malformed encoded paths instead of redirecting them", () => {
    const result = validateLegacyApiRequestTarget("/api/%E0%A4%A");

    expect(result).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "malformed_encoding",
      })
    );
  });
});
