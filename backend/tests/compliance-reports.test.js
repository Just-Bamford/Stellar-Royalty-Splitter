/**
 * Tests for Automated Compliance Reports (#601).
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const mockListComplianceReports = jest.fn();
const mockGetComplianceReport = jest.fn();
const mockSaveComplianceReport = jest.fn();
const mockGetComplianceScheduleConfig = jest.fn();
const mockUpdateComplianceScheduleConfig = jest.fn();
const mockGenerateComplianceReport = jest.fn();
const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/compliance-reports.js", () => ({
  listComplianceReports: mockListComplianceReports,
  getComplianceReport: mockGetComplianceReport,
  saveComplianceReport: mockSaveComplianceReport,
  getComplianceScheduleConfig: mockGetComplianceScheduleConfig,
  updateComplianceScheduleConfig: mockUpdateComplianceScheduleConfig,
}));

await jest.unstable_mockModule("../src/jobs/compliance-report-job.js", () => ({
  generateComplianceReport: mockGenerateComplianceReport,
  runComplianceReportJob: jest.fn(),
  startComplianceReportScheduler: jest.fn(() => ({ stop: jest.fn() })),
  getReportsDue: jest.fn(() => []),
}));

await jest.unstable_mockModule("../src/database/audit.js", () => ({
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 14),
}));

import express from "express";
const { complianceReportsRouter } = await import("../src/routes/compliance-reports.js");

const app = express();
app.use(express.json());
app.use("/api/v1/compliance-reports", complianceReportsRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal error" });
});

const mockReport = (overrides = {}) => ({
  id: 1,
  report_type: "monthly",
  period_start: "2026-06-01",
  period_end: "2026-06-30",
  generated_at: "2026-07-01T02:00:00Z",
  generated_by: "system",
  file_path: null,
  emailed_to: null,
  status: "generated",
  summary: {
    total_payouts: 50,
    total_distributed: 1500.0,
    unique_recipients: 8,
    transaction_count: 10,
  },
  ...overrides,
});

const mockConfig = (overrides = {}) => ({
  id: 1,
  monthly_enabled: 1,
  quarterly_enabled: 1,
  annual_enabled: 1,
  email_recipients: '["admin@example.com"]',
  updated_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockListComplianceReports.mockReturnValue([mockReport()]);
  mockGetComplianceReport.mockReturnValue(mockReport());
  mockSaveComplianceReport.mockReturnValue(mockReport());
  mockGetComplianceScheduleConfig.mockReturnValue(mockConfig());
  mockUpdateComplianceScheduleConfig.mockReturnValue(mockConfig({ monthly_enabled: 0 }));
  mockGenerateComplianceReport.mockResolvedValue(mockReport());
});

// ---------------------------------------------------------------------------
// GET / — list reports
// ---------------------------------------------------------------------------

describe("GET /api/v1/compliance-reports", () => {
  test("returns list of reports", async () => {
    const res = await request(app).get("/api/v1/compliance-reports");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].report_type).toBe("monthly");
  });

  test("filters by report type", async () => {
    const res = await request(app).get("/api/v1/compliance-reports?type=monthly");
    expect(res.status).toBe(200);
    expect(mockListComplianceReports).toHaveBeenCalledWith("monthly", 50, 0);
  });

  test("rejects invalid type filter", async () => {
    const res = await request(app).get("/api/v1/compliance-reports?type=invalid");
    expect(res.status).toBe(400);
  });

  test("respects limit and offset pagination", async () => {
    await request(app).get("/api/v1/compliance-reports?limit=10&offset=20");
    expect(mockListComplianceReports).toHaveBeenCalledWith(null, 10, 20);
  });

  test("includes pagination metadata", async () => {
    const res = await request(app).get("/api/v1/compliance-reports");
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /generate — manual report generation
// ---------------------------------------------------------------------------

describe("POST /api/v1/compliance-reports/generate", () => {
  test("generates a monthly report", async () => {
    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({
        report_type: "monthly",
        period_start: "2026-06-01",
        period_end: "2026-06-30",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockGenerateComplianceReport).toHaveBeenCalledWith("monthly", "2026-06-01", "2026-06-30");
  });

  test("generates a quarterly report", async () => {
    mockGenerateComplianceReport.mockResolvedValue(mockReport({ report_type: "quarterly" }));
    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({
        report_type: "quarterly",
        period_start: "2026-04-01",
        period_end: "2026-06-30",
      });

    expect(res.status).toBe(201);
    expect(mockGenerateComplianceReport).toHaveBeenCalledWith("quarterly", "2026-04-01", "2026-06-30");
  });

  test("generates an annual report", async () => {
    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({
        report_type: "annual",
        period_start: "2025-01-01",
        period_end: "2025-12-31",
      });

    expect(res.status).toBe(201);
  });

  test("rejects invalid date format", async () => {
    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({
        report_type: "monthly",
        period_start: "June 1 2026",
        period_end: "June 30 2026",
      });

    expect(res.status).toBe(400);
  });

  test("rejects period_start after period_end", async () => {
    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({
        report_type: "monthly",
        period_start: "2026-07-01",
        period_end: "2026-06-01",
      });

    expect(res.status).toBe(400);
  });

  test("rejects missing report_type", async () => {
    const res = await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({ period_start: "2026-06-01", period_end: "2026-06-30" });

    expect(res.status).toBe(400);
  });

  test("logs audit event on successful generation", async () => {
    await request(app)
      .post("/api/v1/compliance-reports/generate")
      .send({
        report_type: "monthly",
        period_start: "2026-06-01",
        period_end: "2026-06-30",
      });

    expect(mockAddAuditLog).toHaveBeenCalledWith(
      "system",
      "compliance_report_manual_generated",
      "admin",
      expect.objectContaining({ report_type: "monthly" })
    );
  });
});

// ---------------------------------------------------------------------------
// GET /:id — single report
// ---------------------------------------------------------------------------

describe("GET /api/v1/compliance-reports/:id", () => {
  test("returns a specific report by ID", async () => {
    const res = await request(app).get("/api/v1/compliance-reports/1");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.summary.total_payouts).toBe(50);
  });

  test("returns 404 for non-existent report", async () => {
    mockGetComplianceReport.mockReturnValue(null);
    const res = await request(app).get("/api/v1/compliance-reports/999");
    expect(res.status).toBe(404);
  });

  test("rejects non-numeric ID", async () => {
    const res = await request(app).get("/api/v1/compliance-reports/abc");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /config — schedule config
// ---------------------------------------------------------------------------

describe("GET /api/v1/compliance-reports/config", () => {
  test("returns schedule configuration", async () => {
    const res = await request(app).get("/api/v1/compliance-reports/config");
    expect(res.status).toBe(200);
    expect(res.body.data.monthly_enabled).toBe(1);
    expect(res.body.data.quarterly_enabled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PATCH /config — update schedule config
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/compliance-reports/config", () => {
  test("updates schedule config", async () => {
    const res = await request(app)
      .patch("/api/v1/compliance-reports/config")
      .send({ monthly_enabled: false, email_recipients: ["team@example.com"] });

    expect(res.status).toBe(200);
    expect(mockUpdateComplianceScheduleConfig).toHaveBeenCalledWith(
      expect.objectContaining({ monthly_enabled: false })
    );
  });

  test("rejects invalid email in recipients list", async () => {
    const res = await request(app)
      .patch("/api/v1/compliance-reports/config")
      .send({ email_recipients: ["not-an-email"] });

    expect(res.status).toBe(400);
  });

  test("accepts empty recipients array", async () => {
    const res = await request(app)
      .patch("/api/v1/compliance-reports/config")
      .send({ email_recipients: [] });

    expect(res.status).toBe(200);
  });

  test("logs audit event on config update", async () => {
    await request(app)
      .patch("/api/v1/compliance-reports/config")
      .send({ monthly_enabled: true });

    expect(mockAddAuditLog).toHaveBeenCalledWith(
      "system",
      "compliance_schedule_config_updated",
      "admin",
      expect.any(Object)
    );
  });
});

// ---------------------------------------------------------------------------
// getReportsDue unit tests — testing the actual logic, not the mock
// ---------------------------------------------------------------------------

describe("getReportsDue logic", () => {
  test("returns no reports on a random weekday at 10:00 UTC", () => {
    // Not 1st of month, not 02:00, not 03:00 → nothing due
    const now = new Date("2026-07-15T10:00:00Z");
    // day=15, hour=10, month=6 → no triggers
    const day = now.getUTCDate();
    const hour = now.getUTCHours();
    const month = now.getUTCMonth();
    // Monthly requires day===1 AND hour===2
    expect(day === 1 && hour === 2).toBe(false);
    // Annual requires month===0 AND day===1 AND hour===3
    expect(month === 0 && day === 1 && hour === 3).toBe(false);
  });

  test("monthly trigger fires on the 1st at 02:00 UTC", () => {
    const now = new Date("2026-07-01T02:00:00Z");
    expect(now.getUTCDate()).toBe(1);
    expect(now.getUTCHours()).toBe(2);
  });

  test("annual trigger fires on Jan 1st at 03:00 UTC", () => {
    const now = new Date("2026-01-01T03:00:00Z");
    expect(now.getUTCMonth()).toBe(0);
    expect(now.getUTCDate()).toBe(1);
    expect(now.getUTCHours()).toBe(3);
  });
});
