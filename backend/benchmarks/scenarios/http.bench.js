/**
 * HTTP request-path benchmarks (#867).
 *
 * Measures a real Express request travelling the full middleware chain that
 * every write endpoint sits behind — body parsing, size limiting, schema
 * validation, and the project's standard error responses — terminating in a
 * trivial handler.
 *
 * The handler is trivial on purpose. This scenario is here to measure the
 * *framework and validation overhead* that every request pays, isolated from
 * Soroban RPC and database latency, which are network-bound and cannot be
 * benchmarked reproducibly in CI. Contract-call cost is covered separately by
 * the Criterion benches under `benches/`.
 *
 * Requests are issued over a real loopback socket against a real listening
 * server, so the numbers include Node's HTTP parsing and serialisation. That
 * makes p95/p99 here directly comparable to the k6 thresholds in
 * `backend/load-testing/`, just without the network in between.
 */

import express from "express";
import { once } from "node:events";
import { createBodySizeLimiters } from "../../src/body-size-limit.js";
import { validate, initializeSchema, distributeSchema } from "../../src/validation.js";
import { notFoundHandler, errorHandler } from "../../src/error-response.js";

const ACCOUNTS = [
  "GBDIA62PY5P5MSTMR3DSVAQ4TITI3JJWWMW2NAI2QZKMPTTKSLG5JU6L",
  "GAV4DGP22KP4ZWOFJXMVWNRCFFYU6BFDQHEYJAHONQHFRH4GSY4GFQRN",
  "GCS3HJDDTO6RAKEBYBA7KB3TLTVR4J3GPIT7FIWNEA6BFIDUA3Q4ADKI",
  "GBZSNVYQOMVZKGCJTYEM2YSK5RW3LFHLJ4MNKZNYMX44TGRHESDLDBXV",
  "GDVWFXWIMSTF2ZUJVQYWWDSGUFO5R5CRUZLIK3GEKFFZXAEDSOZEDKTT",
];

const CONTRACT = "CFIDWUVTWDSZTKLPVFRQQ42WFLK3I572742JAQV7ZHCM4UKZTZRJWH6P";
const TOKEN = "CIGTZ2LCHGNCEFHAVKMZP52FGJKAPRWJJRWNUCZPIIENJ4RLGYNKCLF2";

function exactShares(n) {
  const base = Math.floor(10000 / n);
  const shares = Array.from({ length: n }, () => base);
  shares[n - 1] += 10000 - base * n;
  return shares;
}

const INITIALIZE_BODY = JSON.stringify({
  contractId: CONTRACT,
  walletAddress: ACCOUNTS[0],
  collaborators: ACCOUNTS,
  shares: exactShares(ACCOUNTS.length),
});

const DISTRIBUTE_BODY = JSON.stringify({
  contractId: CONTRACT,
  walletAddress: ACCOUNTS[0],
  tokenId: TOKEN,
  amount: 1_000_000,
});

const INVALID_BODY = JSON.stringify({
  contractId: "not-a-contract",
  walletAddress: "not-an-address",
  collaborators: [],
  shares: [],
});

/**
 * Build and start the benchmark server.
 *
 * Binds to port 0 so concurrent runs cannot collide on a fixed port.
 */
async function startServer() {
  const app = express();
  app.use(...createBodySizeLimiters());

  // Terminal handlers are deliberately trivial: this scenario measures the
  // middleware chain, not business logic.
  app.post("/api/v1/initialize", validate(initializeSchema), (req, res) => {
    res.status(200).json({ ok: true, collaborators: req.body.collaborators.length });
  });

  app.post("/api/v1/distribute", validate(distributeSchema), (req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/api/v1/ping", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address();

  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(context) {
  if (!context?.server) return;
  context.server.close();
  await once(context.server, "close");
}

/**
 * Between-run noise floor for every scenario in this file.
 *
 * A loopback request varies by a few tenths of a millisecond from OS
 * scheduling alone, and that variation is invisible to any statistic computed
 * within a single run — the percentiles inside one process are far steadier
 * than the same percentiles measured a minute later. Calibrated by running
 * this suite twice against unchanged code: without this floor, `http/not-found`
 * reported a 20% "regression" comparing a run to itself.
 */
const HTTP_NOISE_FLOOR_MS = 0.3;

/** One request, awaited to completion including the response body. */
async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await response.text();
  return response.status;
}

/** @type {import("../runner.js").Scenario[]} */
export default [
  {
    name: "http/ping",
    group: "http",
    description: "Baseline round trip — Express routing and JSON response, no validation",
    iterations: 1000,
    warmup: 200,
    minAllowanceMs: HTTP_NOISE_FLOOR_MS,
    setup: startServer,
    teardown: stopServer,
    run: async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/v1/ping`);
      await response.text();
    },
  },
  {
    name: "http/initialize/5-collaborators",
    group: "http",
    description: "POST /initialize through body parsing, size limits, and schema validation",
    iterations: 1000,
    warmup: 200,
    minAllowanceMs: HTTP_NOISE_FLOOR_MS,
    setup: startServer,
    teardown: stopServer,
    run: ({ baseUrl }) => post(baseUrl, "/api/v1/initialize", INITIALIZE_BODY),
  },
  {
    name: "http/distribute",
    group: "http",
    description: "POST /distribute through the full middleware chain",
    iterations: 1000,
    warmup: 200,
    minAllowanceMs: HTTP_NOISE_FLOOR_MS,
    setup: startServer,
    teardown: stopServer,
    run: ({ baseUrl }) => post(baseUrl, "/api/v1/distribute", DISTRIBUTE_BODY),
  },
  {
    name: "http/initialize/rejected",
    group: "http",
    description:
      "POST /initialize with an invalid body — the 400 path, which is what a misbehaving client hits",
    iterations: 1000,
    warmup: 200,
    minAllowanceMs: HTTP_NOISE_FLOOR_MS,
    setup: startServer,
    teardown: stopServer,
    run: ({ baseUrl }) => post(baseUrl, "/api/v1/initialize", INVALID_BODY),
  },
  {
    name: "http/not-found",
    group: "http",
    description: "Unmatched route — exercises notFoundHandler and the standard error shape",
    iterations: 1000,
    warmup: 200,
    minAllowanceMs: HTTP_NOISE_FLOOR_MS,
    setup: startServer,
    teardown: stopServer,
    run: async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);
      await response.text();
    },
  },
];
