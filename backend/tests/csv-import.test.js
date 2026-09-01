import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mockCreateCsvImport = jest.fn();
const mockAddImportResult = jest.fn();
const mockGetCsvImport = jest.fn();
const mockGetCsvImportsByContract = jest.fn();
const mockGetImportResults = jest.fn();
const mockGetImportSummary = jest.fn();
const mockMarkImportSuccess = jest.fn();
const mockMarkImportFailed = jest.fn();
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/csv-import.js", () => ({
  createCsvImport: mockCreateCsvImport,
  addImportResult: mockAddImportResult,
  getCsvImport: mockGetCsvImport,
  getCsvImportsByContract: mockGetCsvImportsByContract,
  getImportResults: mockGetImportResults,
  getImportSummary: mockGetImportSummary,
  markImportSuccess: mockMarkImportSuccess,
  markImportFailed: mockMarkImportFailed,
}));

await jest.unstable_mockModule("../src/database/audit.js", () => ({
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 9),
}));

import express from "express";
const { csvImportRouter } = await import("../src/routes/csv-import.js");

const app = express();
app.use(express.json());
app.use("/api/v1/csv-import", csvImportRouter);

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT_ID = "CAFQE4X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7X7R7";

describe("CSV Import - Template", () => {
  test("GET /template returns CSV content", async () => {
    const res = await request(app).get("/api/v1/csv-import/template");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("address,share_percentage");
    expect(res.text).toContain("GABCDEF1234567890XYZ");
  });
});

describe("CSV Import - Validation", () => {
  test("POST /validate with valid CSV returns parsed data", async () => {
    const csvContent =
      "address,share_percentage\nGAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C,10\nGA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P,90";
    const tmpFile = path.join(__dirname, "_test_valid.csv");
    fs.writeFileSync(tmpFile, csvContent, "utf-8");

    const res = await request(app).post("/api/v1/csv-import/validate").attach("file", tmpFile);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.valid.length).toBe(2);
    expect(res.body.data.errors.length).toBe(0);

    fs.unlinkSync(tmpFile);
  });

  test("POST /validate with invalid addresses catches errors", async () => {
    const csvContent = "address,share_percentage\ninvalid_address,10";
    const tmpFile = path.join(__dirname, "_test_invalid.csv");
    fs.writeFileSync(tmpFile, csvContent, "utf-8");

    const res = await request(app).post("/api/v1/csv-import/validate").attach("file", tmpFile);

    expect(res.status).toBe(200);
    expect(res.body.data.errors.length).toBeGreaterThan(0);

    fs.unlinkSync(tmpFile);
  });

  test("POST /validate with shares not summing to 100 returns errors", async () => {
    const csvContent =
      "address,share_percentage\nGAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C,10\nGA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P,10";
    const tmpFile = path.join(__dirname, "_test_sum.csv");
    fs.writeFileSync(tmpFile, csvContent, "utf-8");

    const res = await request(app).post("/api/v1/csv-import/validate").attach("file", tmpFile);

    expect(res.status).toBe(200);
    expect(res.body.data.errors.length).toBeGreaterThan(0);

    fs.unlinkSync(tmpFile);
  });

  test("POST /validate without file returns error", async () => {
    const res = await request(app).post("/api/v1/csv-import/validate");

    expect(res.status).toBe(400);
  });
});

describe("CSV Import - Preview", () => {
  test("POST /preview returns preview data", async () => {
    const csvContent =
      "address,share_percentage\nGAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C,50\nGA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P,50";
    const tmpFile = path.join(__dirname, "_test_preview.csv");
    fs.writeFileSync(tmpFile, csvContent, "utf-8");

    const res = await request(app)
      .post("/api/v1/csv-import/preview")
      .field("contractId", CONTRACT_ID)
      .attach("file", tmpFile);

    expect(res.status).toBe(200);
    expect(res.body.data.summary.total).toBe(2);
    expect(res.body.data.validRows.length).toBe(2);

    fs.unlinkSync(tmpFile);
  });
});

describe("CSV Import - Import Flow", () => {
  beforeEach(() => {
    mockCreateCsvImport.mockReturnValue({
      id: 1,
      contractId: CONTRACT_ID,
      fileName: "test.csv",
      rowCount: 2,
      importedBy: "admin",
    });
    mockGetCsvImport.mockReturnValue({
      id: 1,
      contractId: CONTRACT_ID,
      fileName: "test.csv",
      status: "completed",
    });
    mockGetImportResults.mockReturnValue([]);
    mockGetImportSummary.mockReturnValue({ total: 2, successCount: 2, errorCount: 0 });
    mockGetCsvImportsByContract.mockReturnValue([]);
  });

  test("POST /import imports CSV successfully", async () => {
    const csvContent =
      "address,share_percentage\nGAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C,50\nGA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P,50";
    const tmpFile = path.join(__dirname, "_test_import.csv");
    fs.writeFileSync(tmpFile, csvContent, "utf-8");

    const res = await request(app)
      .post("/api/v1/csv-import/import")
      .field("contractId", CONTRACT_ID)
      .field("importedBy", "admin")
      .attach("file", tmpFile);

    expect(res.status).toBe(200);
    expect(res.body.data.summary.successCount).toBe(2);

    fs.unlinkSync(tmpFile);
  });

  test("POST /import without contractId returns error", async () => {
    const csvContent = "address,share_percentage\nGABCDEF1234567890XYZ,100";
    const tmpFile = path.join(__dirname, "_test_no_contract.csv");
    fs.writeFileSync(tmpFile, csvContent, "utf-8");

    const res = await request(app).post("/api/v1/csv-import/import").attach("file", tmpFile);

    expect(res.status).toBe(400);

    fs.unlinkSync(tmpFile);
  });

  test("GET /history/:contractId returns import history", async () => {
    mockGetCsvImportsByContract.mockReturnValue([
      { id: 1, contractId: CONTRACT_ID, fileName: "test.csv", status: "completed" },
    ]);
    const res = await request(app).get(`/api/v1/csv-import/history/${CONTRACT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
  });

  test("GET /results/:importId returns import results", async () => {
    mockGetCsvImport.mockReturnValue({ id: 1, contractId: CONTRACT_ID });
    mockGetImportResults.mockReturnValue([
      { id: 1, rowIndex: 1, address: "G...", share: 50, status: "success" },
    ]);
    mockGetImportSummary.mockReturnValue({ total: 1, successCount: 1, errorCount: 0 });

    const res = await request(app).get("/api/v1/csv-import/results/1");
    expect(res.status).toBe(200);
    expect(res.body.data.results.length).toBe(1);
  });

  test("GET /results/:importId for non-existent import returns 404", async () => {
    mockGetCsvImport.mockReturnValue(null);
    const res = await request(app).get("/api/v1/csv-import/results/999");
    expect(res.status).toBe(404);
  });
});
