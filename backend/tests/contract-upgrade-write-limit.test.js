/**
 * #1127 — contract upgrade endpoints are write-limited; read-only contract
 * routes are not.
 *
 * src/index.js starts the server on import, so (like payload-size.test.js)
 * this mirrors its wiring with the real express-rate-limit, and separately
 * asserts that index.js still contains that wiring.
 */
import { describe, test, expect } from "@jest/globals";
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRITE_MAX = 3;

function buildApp() {
  const app = express();
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: WRITE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ code: "too_many_requests" }),
  });

  // Same lines as src/index.js.
  app.post(["/api/v1/contract/upgrade", "/api/v1/contract/upgrade/*"], writeLimiter);

  const contractRouter = express.Router();
  contractRouter.get("/state", (_req, res) => res.json({ ok: true }));
  contractRouter.get("/version/:contractId", (_req, res) => res.json({ ok: true }));
  contractRouter.post("/upgrade", (_req, res) => res.json({ ok: true }));
  contractRouter.post("/upgrade/propose", (_req, res) => res.json({ ok: true }));
  contractRouter.get("/upgrade/proposals/:contractId", (_req, res) => res.json({ ok: true }));
  app.use("/api/v1/contract", contractRouter);
  return app;
}

async function hit(app, method, url, times) {
  const statuses = [];
  for (let i = 0; i < times; i++) {
    statuses.push((await request(app)[method](url)).status);
  }
  return statuses;
}

describe("contract upgrade write limiter (#1127)", () => {
  test("POST /api/v1/contract/upgrade is limited after the write quota", async () => {
    const statuses = await hit(buildApp(), "post", "/api/v1/contract/upgrade", WRITE_MAX + 2);
    expect(statuses.slice(0, WRITE_MAX)).toEqual(Array(WRITE_MAX).fill(200));
    expect(statuses.slice(WRITE_MAX)).toEqual([429, 429]);
  });

  test("POST sub-paths of /upgrade share the write limit", async () => {
    const statuses = await hit(buildApp(), "post", "/api/v1/contract/upgrade/propose", WRITE_MAX + 1);
    expect(statuses[WRITE_MAX]).toBe(429);
  });

  test("GET contract routes are not write-limited", async () => {
    const app = buildApp();
    const n = WRITE_MAX * 3;
    expect(await hit(app, "get", "/api/v1/contract/state", n)).toEqual(Array(n).fill(200));
    expect(await hit(app, "get", "/api/v1/contract/version/CABC", n)).toEqual(Array(n).fill(200));
    expect(await hit(app, "get", "/api/v1/contract/upgrade/proposals/CABC", n)).toEqual(Array(n).fill(200));
  });

  test("src/index.js applies writeLimiter to the upgrade POST paths before mounting contractRouter", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
    const limiterLine = 'app.post(["/api/v1/contract/upgrade", "/api/v1/contract/upgrade/*"], writeLimiter);';
    const mountLine = 'app.use("/api/v1/contract", contractRouter);';
    expect(source).toContain(limiterLine);
    expect(source.indexOf(limiterLine)).toBeLessThan(source.indexOf(mountLine));
    expect(source).not.toMatch(/app\.use\("\/api\/v1\/contract",\s*writeLimiter\)/);
  });
});
