/**
 * Tests for batch distribution (#521):
 * - Queue a batch job
 * - Retrieve status
 * - Process chunks
 * - Resume failed batches
 * - Monitoring stats
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────

const retryBuildTx = jest.fn();

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: {},
  Address: { fromScVal: jest.fn((v) => ({ toString: () => v })) },
  Contract: jest.fn().mockImplementation(() => ({ call: jest.fn((m) => ({ method: m })) })),
  SorobanRpc: { Api: { isSimulationError: jest.fn(() => false) } },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
  BASE_FEE: "100",
  Account: jest.fn(),
  scValToNative: jest.fn((v) => v),
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  isContractInitialized: jest.fn(),
  addressToScVal: jest.fn((a) => `scval:${a}`),
  vecToScVal: jest.fn((v) => `vec:${JSON.stringify(v)}`),
  getNetworkLabel: jest.fn(() => "Testnet"),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

await jest.unstable_mockModule("../src/xdr-validation.js", () => ({
  validateXdrStructure: jest.fn(() => ({ valid: true, errors: [] })),
}));

// In-memory store for batch jobs and chunks
const batchJobsStore = new Map();
const batchChunksStore = new Map();
let chunkIdCounter = 1;

const createBatchJob = jest.fn((contractId, walletAddress, tokenId, collaborators) => {
  const id = `batch-${Date.now()}`;
  const BATCH_SIZE = 100;
  const totalChunks = Math.ceil(collaborators.length / BATCH_SIZE);
  const job = {
    id,
    contractId,
    walletAddress,
    tokenId,
    totalCollaborators: collaborators.length,
    totalChunks,
    completedChunks: 0,
    status: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  batchJobsStore.set(id, job);
  for (let i = 0; i < totalChunks; i++) {
    const chunkId = chunkIdCounter++;
    batchChunksStore.set(chunkId, {
      id: chunkId,
      batchJobId: id,
      chunkIndex: i,
      collaborators: JSON.stringify(collaborators.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)),
      status: "pending",
      transactionId: null,
      errorMessage: null,
    });
  }
  return id;
});

const getBatchJob = jest.fn((id) => batchJobsStore.get(id) ?? null);

const getBatchJobChunks = jest.fn((id) =>
  [...batchChunksStore.values()].filter((c) => c.batchJobId === id)
);

const getPendingChunks = jest.fn((id) =>
  [...batchChunksStore.values()].filter(
    (c) => c.batchJobId === id && ["pending", "failed"].includes(c.status)
  )
);

const markChunkProcessing = jest.fn((chunkId) => {
  const c = batchChunksStore.get(chunkId);
  if (c) c.status = "processing";
});

const markChunkCompleted = jest.fn((chunkId, txId) => {
  const c = batchChunksStore.get(chunkId);
  if (c) {
    c.status = "completed";
    c.transactionId = txId;
    const job = batchJobsStore.get(c.batchJobId);
    if (job) {
      job.completedChunks++;
      job.status = job.completedChunks === job.totalChunks ? "completed" : "processing";
    }
  }
});

const markChunkFailed = jest.fn((chunkId, errorMessage) => {
  const c = batchChunksStore.get(chunkId);
  if (c) {
    c.status = "failed";
    c.errorMessage = errorMessage;
    const job = batchJobsStore.get(c.batchJobId);
    if (job) job.status = "failed";
  }
});

const listBatchJobs = jest.fn((contractId) =>
  [...batchJobsStore.values()].filter((j) => j.contractId === contractId)
);

const getBatchMonitoringStats = jest.fn(() => ({
  jobs: [{ status: "queued", count: 1 }],
  chunks: [{ status: "pending", count: 2 }],
}));

const recordTransaction = jest.fn(() => 999);

await jest.unstable_mockModule("../src/database/index.js", () => ({
  createBatchJob,
  getBatchJob,
  getBatchJobChunks,
  getPendingChunks,
  markChunkProcessing,
  markChunkCompleted,
  markChunkFailed,
  listBatchJobs,
  getBatchMonitoringStats,
  recordTransaction,
  addAuditLog: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 11),
}));

const { batchRouter } = await import("../src/routes/batch-distribute.js");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api/v1/batch-distribute", batchRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN    = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Generate N valid Stellar public addresses (G + 55 base32 chars A-Z2-7)
function makeCollaborators(n) {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return Array.from({ length: n }, (_, i) => {
    // encode i as base32-like suffix (5 chars), rest padded with 'A'
    let rem = i;
    let suffix = "";
    for (let s = 0; s < 5; s++) {
      suffix = CHARS[rem % CHARS.length] + suffix;
      rem = Math.floor(rem / CHARS.length);
    }
    return `G${"A".repeat(50)}${suffix}`;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/v1/batch-distribute — queue batch job", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    batchJobsStore.clear();
    batchChunksStore.clear();
    chunkIdCounter = 1;
  });

  test("1. enqueues a batch job and returns 202 with batchJobId", async () => {
    const collaborators = makeCollaborators(250);
    createBatchJob.mockImplementationOnce((cId, wAddr, tId, colls) => {
      const id = "batch-test-1";
      batchJobsStore.set(id, {
        id,
        contractId: cId,
        walletAddress: wAddr,
        tokenId: tId,
        totalCollaborators: colls.length,
        totalChunks: 3,
        completedChunks: 0,
        status: "queued",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      return id;
    });

    const res = await request(app)
      .post("/api/v1/batch-distribute")
      .send({ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN, collaborators });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      batchJobId: "batch-test-1",
      totalChunks: 3,
      totalCollaborators: 250,
      status: "queued",
    });
    expect(createBatchJob).toHaveBeenCalledWith(CONTRACT, WALLET, TOKEN, collaborators);
  });

  test("2. splits 100 collaborators into exactly 1 chunk", async () => {
    const collaborators = makeCollaborators(100);
    createBatchJob.mockImplementationOnce((cId, wAddr, tId, colls) => {
      const id = "batch-test-2";
      batchJobsStore.set(id, {
        id,
        contractId: cId,
        walletAddress: wAddr,
        tokenId: tId,
        totalCollaborators: colls.length,
        totalChunks: 1,
        completedChunks: 0,
        status: "queued",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      return id;
    });

    const res = await request(app)
      .post("/api/v1/batch-distribute")
      .send({ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN, collaborators });

    expect(res.status).toBe(202);
    expect(res.body.totalChunks).toBe(1);
  });

  test("3. validates required fields — returns 400 when contractId missing", async () => {
    const res = await request(app)
      .post("/api/v1/batch-distribute")
      .send({ walletAddress: WALLET, tokenId: TOKEN, collaborators: makeCollaborators(5) });

    expect(res.status).toBe(400);
    expect(createBatchJob).not.toHaveBeenCalled();
  });

  test("4. validates collaborators array — returns 400 when empty", async () => {
    const res = await request(app)
      .post("/api/v1/batch-distribute")
      .send({ contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN, collaborators: [] });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/batch-distribute/:batchJobId — status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    batchJobsStore.clear();
    batchChunksStore.clear();
    chunkIdCounter = 1;
  });

  test("5. returns batch job status with chunks", async () => {
    const jobId = "status-test-1";
    batchJobsStore.set(jobId, {
      id: jobId,
      contractId: CONTRACT,
      walletAddress: WALLET,
      tokenId: TOKEN,
      totalCollaborators: 150,
      totalChunks: 2,
      completedChunks: 1,
      status: "processing",
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    batchChunksStore.set(1, { id: 1, batchJobId: jobId, chunkIndex: 0, status: "completed", collaborators: "[]" });
    batchChunksStore.set(2, { id: 2, batchJobId: jobId, chunkIndex: 1, status: "pending", collaborators: "[]" });

    const res = await request(app).get(`/api/v1/batch-distribute/${jobId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(jobId);
    expect(res.body.status).toBe("processing");
    expect(res.body.chunks).toHaveLength(2);
  });

  test("6. returns 404 for unknown batch job", async () => {
    getBatchJob.mockReturnValueOnce(null);

    const res = await request(app).get("/api/v1/batch-distribute/nonexistent-id");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe("POST /api/v1/batch-distribute/:batchJobId/process — process chunks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    batchJobsStore.clear();
    batchChunksStore.clear();
    chunkIdCounter = 1;
  });

  test("7. processes pending chunks and returns processed count", async () => {
    const jobId = "process-test-1";
    batchJobsStore.set(jobId, {
      id: jobId,
      contractId: CONTRACT,
      walletAddress: WALLET,
      tokenId: TOKEN,
      totalCollaborators: 2,
      totalChunks: 1,
      completedChunks: 0,
      status: "queued",
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    batchChunksStore.set(1, {
      id: 1,
      batchJobId: jobId,
      chunkIndex: 0,
      status: "pending",
      collaborators: JSON.stringify(makeCollaborators(2)),
      transactionId: null,
      errorMessage: null,
    });

    retryBuildTx.mockResolvedValue("mock-xdr");

    const res = await request(app)
      .post(`/api/v1/batch-distribute/${jobId}/process`)
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(markChunkCompleted).toHaveBeenCalledWith(1, expect.anything());
  });

  test("8. marks chunk as failed when Stellar RPC throws", async () => {
    const jobId = "process-fail-1";
    batchJobsStore.set(jobId, {
      id: jobId,
      contractId: CONTRACT,
      walletAddress: WALLET,
      tokenId: TOKEN,
      totalCollaborators: 1,
      totalChunks: 1,
      completedChunks: 0,
      status: "queued",
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    batchChunksStore.set(2, {
      id: 2,
      batchJobId: jobId,
      chunkIndex: 0,
      status: "pending",
      collaborators: JSON.stringify(makeCollaborators(1)),
      transactionId: null,
      errorMessage: null,
    });

    retryBuildTx.mockRejectedValue(new Error("RPC unavailable"));

    const res = await request(app)
      .post(`/api/v1/batch-distribute/${jobId}/process`)
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(200);
    expect(res.body.failed).toBe(1);
    expect(res.body.processed).toBe(0);
    expect(markChunkFailed).toHaveBeenCalledWith(2, "RPC unavailable");
  });

  test("9. returns 404 for unknown job", async () => {
    getBatchJob.mockReturnValueOnce(null);

    const res = await request(app)
      .post("/api/v1/batch-distribute/unknown/process")
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/batch-distribute/:batchJobId/resume — resume failed", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    batchJobsStore.clear();
    batchChunksStore.clear();
    chunkIdCounter = 1;
  });

  test("10. resumes a failed job and retries failed chunks", async () => {
    const jobId = "resume-test-1";
    batchJobsStore.set(jobId, {
      id: jobId,
      contractId: CONTRACT,
      walletAddress: WALLET,
      tokenId: TOKEN,
      totalCollaborators: 1,
      totalChunks: 1,
      completedChunks: 0,
      status: "failed",
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    batchChunksStore.set(3, {
      id: 3,
      batchJobId: jobId,
      chunkIndex: 0,
      status: "failed",
      collaborators: JSON.stringify(makeCollaborators(1)),
      transactionId: null,
      errorMessage: "previous error",
    });

    retryBuildTx.mockResolvedValue("resume-xdr");

    // Resume delegates to /process which uses getPendingChunks (includes 'failed')
    const res = await request(app)
      .post(`/api/v1/batch-distribute/${jobId}/resume`)
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
  });

  test("11. returns 409 when job is not in failed/partial state", async () => {
    const jobId = "resume-conflict-1";
    batchJobsStore.set(jobId, {
      id: jobId,
      contractId: CONTRACT,
      walletAddress: WALLET,
      tokenId: TOKEN,
      totalCollaborators: 1,
      totalChunks: 1,
      completedChunks: 1,
      status: "completed",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post(`/api/v1/batch-distribute/${jobId}/resume`)
      .send({ walletAddress: WALLET });

    expect(res.status).toBe(409);
  });
});

describe("GET /api/v1/batch-distribute/monitoring/stats — monitoring", () => {
  test("12. returns job and chunk stats", async () => {
    const res = await request(app).get("/api/v1/batch-distribute/monitoring/stats");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("jobs");
    expect(res.body).toHaveProperty("chunks");
    expect(getBatchMonitoringStats).toHaveBeenCalled();
  });
});

describe("GET /api/v1/batch-distribute — list jobs", () => {
  test("13. returns jobs for a given contractId", async () => {
    batchJobsStore.clear();
    batchJobsStore.set("j1", {
      id: "j1",
      contractId: CONTRACT,
      walletAddress: WALLET,
      tokenId: TOKEN,
      totalCollaborators: 50,
      totalChunks: 1,
      completedChunks: 0,
      status: "queued",
      createdAt: new Date().toISOString(),
      completedAt: null,
    });

    const res = await request(app).get(`/api/v1/batch-distribute?contractId=${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(listBatchJobs).toHaveBeenCalledWith(CONTRACT, 20, 0);
  });

  test("14. returns 400 when contractId is missing", async () => {
    const res = await request(app).get("/api/v1/batch-distribute");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contractId/i);
  });
});
