import { describe, test, expect } from "@jest/globals";
import express from "express";
import request from "supertest";
import { versionRouter } from "../src/routes/version.js";

function buildApp() {
  const app = express();
  app.use(express.json());

  // X-API-Version header on all versioned routes
  app.use("/api/v1", (_req, res, next) => {
    res.set("X-API-Version", "v1");
    next();
  });

  app.use("/api/v1/version", versionRouter);

  // Simulate a versioned route to test headers
  app.get("/api/v1/ping", (_req, res) => res.json({ ok: true }));

  // Legacy redirect with deprecation headers
  app.use("/api", (req, res) => {
    res.set("Deprecation", "true");
    res.set("Link", `</api/v1${req.url}>; rel="successor-version"`);
    res.redirect(308, `/api/v1${req.url}`);
  });

  return app;
}

const app = buildApp();

describe("GET /api/v1/version", () => {
  test("returns current version, supported list and no deprecated versions", async () => {
    const res = await request(app).get("/api/v1/version");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.current).toBe("v1");
    expect(res.body.data.supported).toContain("v1");
    expect(Array.isArray(res.body.data.deprecated)).toBe(true);
    expect(res.body.data.deprecated).toHaveLength(0);
  });

  test("includes documentation link", async () => {
    const res = await request(app).get("/api/v1/version");
    expect(res.body.data.documentation).toBe("/api/docs");
  });

  test("responds with X-API-Version: v1 header", async () => {
    const res = await request(app).get("/api/v1/version");
    expect(res.headers["x-api-version"]).toBe("v1");
  });
});

describe("Versioned route headers", () => {
  test("every /api/v1 response carries X-API-Version: v1", async () => {
    const res = await request(app).get("/api/v1/ping");
    expect(res.headers["x-api-version"]).toBe("v1");
  });
});

describe("Legacy /api redirect", () => {
  test("redirects /api/ping to /api/v1/ping with HTTP 308", async () => {
    const res = await request(app).get("/api/ping");
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe("/api/v1/ping");
  });

  test("sets Deprecation: true header on legacy redirect", async () => {
    const res = await request(app).get("/api/ping");
    expect(res.headers["deprecation"]).toBe("true");
  });

  test("sets Link header pointing to versioned successor", async () => {
    const res = await request(app).get("/api/ping");
    expect(res.headers["link"]).toMatch(/\/api\/v1\/ping/);
    expect(res.headers["link"]).toMatch(/rel="successor-version"/);
  });

  test("preserves query string in redirect target", async () => {
    const res = await request(app).get("/api/anything?limit=10&offset=0");
    expect(res.headers.location).toBe("/api/v1/anything?limit=10&offset=0");
  });
});
