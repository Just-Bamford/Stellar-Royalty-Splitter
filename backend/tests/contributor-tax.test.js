import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import fs from "fs";

const mockGetContributorTax = jest.fn();
const mockUpsertContributorTax = jest.fn();
const mockGetTaxComplianceReport = jest.fn();
const mockGetContributorsMissingTaxInfo = jest.fn();

await jest.unstable_mockModule("../src/database/contributor-tax.js", () => ({
  getContributorTax: mockGetContributorTax,
  upsertContributorTax: mockUpsertContributorTax,
  getTaxComplianceReport: mockGetTaxComplianceReport,
  getContributorsMissingTaxInfo: mockGetContributorsMissingTaxInfo,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 9),
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (req, _res, next) => { req.role = "admin"; next(); },
  requireRole: () => (req, _res, next) => { req.role = "admin"; next(); },
}));

import express from "express";
const { contributorTaxRouter } = await import("../src/routes/contributor-tax.js");

const app = express();
app.use(express.json());
app.use("/api/v1/contributor-tax", contributorTaxRouter);

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

describe("Contributor Tax - CRUD", () => {
  test("GET /:walletAddress returns tax info", async () => {
    mockGetContributorTax.mockReturnValue({ id: 1, walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" });
    const res = await request(app).get(`/api/v1/contributor-tax/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tax_status).toBe("completed");
  });

  test("GET /:walletAddress returns null when not set", async () => {
    mockGetContributorTax.mockReturnValue(null);
    const res = await request(app).get(`/api/v1/contributor-tax/${WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  test("POST / saves tax info", async () => {
    mockUpsertContributorTax.mockReturnValue({ id: 1, walletAddress: WALLET, tax_status: "pending" });
    const res = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ walletAddress: WALLET, tax_status: "pending" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("POST / rejects missing walletAddress", async () => {
    const res = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ tax_status: "pending" });
    expect(res.status).toBe(400);
  });

  test("POST / rejects invalid tax_status", async () => {
    const res = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ walletAddress: WALLET, tax_status: "invalid" });
    expect(res.status).toBe(400);
  });

  test("POST / saves with tax_id", async () => {
    mockUpsertContributorTax.mockReturnValue({ id: 1, walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" });
    const res = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" });
    expect(res.status).toBe(200);
    expect(mockUpsertContributorTax).toHaveBeenCalledWith(
      expect.objectContaining({ tax_id: "12-3456789" })
    );
  });
});

describe("Contributor Tax - Reports", () => {
  test("GET /report/compliance returns compliance report", async () => {
    mockGetTaxComplianceReport.mockReturnValue([
      { walletAddress: WALLET, tax_status: "completed", compliance_status: "compliant" }
    ]);
    const res = await request(app).get("/api/v1/contributor-tax/report/compliance");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.summary).toBeDefined();
  });

  test("GET /report/missing returns contributors missing tax info", async () => {
    mockGetContributorsMissingTaxInfo.mockReturnValue([{ walletAddress: WALLET, tax_status: null }]);
    const res = await request(app).get("/api/v1/contributor-tax/report/missing");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

describe("Contributor Tax - CSV Export (#741)", () => {
  test("GET /export returns CSV with headers and escaped rows", async () => {
    mockGetTaxComplianceReport.mockReturnValue([
      {
        walletAddress: WALLET,
        tax_status: "completed",
        tax_id: '12-3456789, "Inc."',
        compliance_status: "compliant",
        w9_file_name: "w9.pdf",
        updated_at: "2026-01-15T00:00:00.000Z",
      },
    ]);

    const res = await request(app).get("/api/v1/contributor-tax/export");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.headers["content-disposition"]).toMatch(/contributor-tax-export\.csv/);

    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe(
      '"Wallet Address","Tax Status","Tax ID","Compliance Status","W9 File Name","Updated At"',
    );
    // Embedded quotes and commas in tax_id are escaped/quoted correctly.
    expect(lines[1]).toContain('"12-3456789, ""Inc."""');
    expect(lines[1]).toContain(`"${WALLET}"`);
  });

  test("GET /export returns header row only when there are no records", async () => {
    mockGetTaxComplianceReport.mockReturnValue([]);

    const res = await request(app).get("/api/v1/contributor-tax/export");

    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("GET /export renders null fields as empty quoted strings without throwing", async () => {
    mockGetTaxComplianceReport.mockReturnValue([
      {
        walletAddress: WALLET,
        tax_status: null,
        tax_id: null,
        compliance_status: "missing",
        w9_file_name: null,
        updated_at: null,
      },
    ]);

    const res = await request(app).get("/api/v1/contributor-tax/export");

    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n");
    expect(lines[1]).toBe(`"${WALLET}","","","missing","",""`);
  });

  test("GET /export returns 500 with the standard error shape when the report query throws", async () => {
    mockGetTaxComplianceReport.mockImplementation(() => {
      throw new Error("db unavailable");
    });

    const res = await request(app).get("/api/v1/contributor-tax/export");
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});

describe("Contributor Tax - Data Validation", () => {
  test("valid tax_status values are accepted", async () => {
    const statuses = ["not_collected", "pending", "completed", "exempt"];
    for (const status of statuses) {
      mockUpsertContributorTax.mockReturnValue({ id: 1, walletAddress: WALLET, tax_status: status });
      const res = await request(app)
        .post("/api/v1/contributor-tax")
        .send({ walletAddress: WALLET, tax_status: status });
      expect(res.status).toBe(200);
    }
  });

  test("data persists correctly across save and fetch", async () => {
    const savedData = { id: 1, walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" };
    mockUpsertContributorTax.mockReturnValue(savedData);
    mockGetContributorTax.mockReturnValue(savedData);

    const saveRes = await request(app)
      .post("/api/v1/contributor-tax")
      .send({ walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" });
    expect(saveRes.body.data.tax_status).toBe("completed");

    const getRes = await request(app).get(`/api/v1/contributor-tax/${WALLET}`);
    expect(getRes.body.data.tax_id).toBe("12-3456789");
  });
});

describe("Contributor Tax - upload size limit", () => {
  const UPLOAD_URL = `/api/v1/contributor-tax/upload/${WALLET}`;
  const FIVE_MB = 5 * 1024 * 1024;

  beforeEach(() => {
    mockUpsertContributorTax.mockClear();
  });

  test("accepts a small PDF and stores it", async () => {
    mockUpsertContributorTax.mockReturnValue({ walletAddress: WALLET, tax_status: "pending" });

    const res = await request(app)
      .post(UPLOAD_URL)
      .attach("taxDocument", Buffer.alloc(1024, 1), "w9.pdf");

    expect(res.status).toBe(200);
    expect(res.body.file).toEqual({ name: "w9.pdf", size: 1024 });
    const { w9_file_path } = mockUpsertContributorTax.mock.calls[0][0];
    fs.unlinkSync(w9_file_path);
  });

  test("accepts a file of exactly 5 MB", async () => {
    mockUpsertContributorTax.mockReturnValue({ walletAddress: WALLET, tax_status: "pending" });

    const res = await request(app)
      .post(UPLOAD_URL)
      .attach("taxDocument", Buffer.alloc(FIVE_MB, 1), "scan.pdf");

    expect(res.status).toBe(200);
    const { w9_file_path } = mockUpsertContributorTax.mock.calls[0][0];
    fs.unlinkSync(w9_file_path);
  });

  test("rejects a file one byte over 5 MB with 413", async () => {
    const res = await request(app)
      .post(UPLOAD_URL)
      .attach("taxDocument", Buffer.alloc(FIVE_MB + 1, 1), "too-big.pdf");

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("file_too_large");
    expect(res.body.message).toBe("Tax documents must be 5 MB or smaller");
    expect(mockUpsertContributorTax).not.toHaveBeenCalled();
  });

  test("rejects unsupported file types with 400", async () => {
    const res = await request(app)
      .post(UPLOAD_URL)
      .attach("taxDocument", Buffer.from("MZ"), "payload.exe");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("upload_error");
    expect(res.body.message).toBe("Only PDF, PNG, and JPG files are allowed");
    expect(mockUpsertContributorTax).not.toHaveBeenCalled();
  });
});
