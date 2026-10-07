/**
 * Tax compliance reporting tests — closes #950.
 *
 * Covers:
 *  - Database layer (tax-forms.js): createTaxForm, listTaxForms, voidTaxForm, getTaxYearSummary
 *  - Service layer (tax-reporting.js): generate1099Nec, generateT4A, generateEuVat, exportTaxSummary
 *  - Route layer (routes/tax/reports.js): all endpoints + E2E: generate 1099, verify PDF fields
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mock database modules ────────────────────────────────────────────────────

const mockCreateTaxForm = jest.fn();
const mockGetTaxForm = jest.fn();
const mockGetLatestTaxForm = jest.fn();
const mockListTaxForms = jest.fn();
const mockCountTaxForms = jest.fn();
const mockVoidTaxForm = jest.fn();
const mockGetTaxYearSummary = jest.fn();

await jest.unstable_mockModule("../src/database/tax-forms.js", () => ({
  createTaxForm: mockCreateTaxForm,
  getTaxForm: mockGetTaxForm,
  getLatestTaxForm: mockGetLatestTaxForm,
  listTaxForms: mockListTaxForms,
  countTaxForms: mockCountTaxForms,
  voidTaxForm: mockVoidTaxForm,
  getTaxYearSummary: mockGetTaxYearSummary,
  TAX_FORM_TYPES: ["1099-NEC", "T4A", "EU-VAT"],
  TAX_FORM_STATUSES: ["generated", "void", "amended"],
  SUPPORTED_COUNTRIES: ["US", "CA", "EU"],
  IRS_1099_THRESHOLD_USD: 600,
  CRA_T4A_THRESHOLD_USD: 500,
}));

const mockGetContributorTax = jest.fn();

await jest.unstable_mockModule("../src/database/contributor-tax.js", () => ({
  getContributorTax: mockGetContributorTax,
  upsertContributorTax: jest.fn(),
  getTaxComplianceReport: jest.fn(),
  getContributorsMissingTaxInfo: jest.fn(),
  getAllWalletAddresses: jest.fn(),
}));

const mockGetXlmUsdPrice = jest.fn();
const mockXlmToUsdCents = jest.fn((xlm, rate) => Math.round(xlm * rate * 100));

await jest.unstable_mockModule("../src/services/price-oracle.js", () => ({
  getXlmUsdPrice: mockGetXlmUsdPrice,
  xlmToUsdCents: mockXlmToUsdCents,
  resetPriceCache: jest.fn(),
  DEFAULT_PRICE_ORACLE_URL: "https://mock.oracle.test",
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 18),
}));

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (req, _res, next) => {
    req.role = "admin";
    next();
  },
  requireRole: () => (req, _res, next) => {
    req.role = "admin";
    next();
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";
const WALLET2 = "GBHWKBPP3O4H2BUUKSFXE4PK5WHLQYVZIZUNUJ4AU3P7WQCAPADSOVN";
const TAX_YEAR = "2024";
const XLM_RATE = 0.12; // $0.12 per XLM in tests

/** A sample 1099-NEC formData payload that the service would produce. */
const sample1099 = {
  formType: "1099-NEC",
  taxYear: TAX_YEAR,
  country: "US",
  payerName: "Stellar Royalty Splitter",
  recipientAddress: WALLET,
  box1NonemployeeCompensation: "750.00",
  box4FederalIncomeTaxWithheld: "0.00",
  totalIncomeUsd: "750.00",
  totalIncomeUsdCents: 75000,
  withheldUsdCents: 0,
  meetsFilingThreshold: true,
  backupWithholdingApplied: false,
  pdfReady: true,
  generatedAt: new Date().toISOString(),
};

/** Stored DB record wrapping the above form. */
const sampleRecord = {
  id: 1,
  walletAddress: WALLET,
  taxYear: TAX_YEAR,
  formType: "1099-NEC",
  country: "US",
  totalIncomeUsd: 75000,
  withheldUsd: 0,
  formData: sample1099,
  paymentBreakdown: [],
  status: "generated",
  generatedBy: "system",
  createdAt: "2025-01-15T00:00:00.000Z",
  updatedAt: null,
};

// ─── Build express app for route tests ───────────────────────────────────────

import express from "express";
const { taxReportsRouter } = await import("../src/routes/tax/reports.js");

const app = express();
app.use(express.json());

// Attach a default admin role to all requests in tests
app.use((req, _res, next) => {
  req.role = "admin";
  next();
});
app.use("/api/v1/tax/reports", taxReportsRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ─── Route tests: GET /1099-nec ───────────────────────────────────────────────

describe("GET /api/v1/tax/reports/1099-nec", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: XLM_RATE, source: "mock" });
    mockGetLatestTaxForm.mockReturnValue(null);
    mockGetContributorTax.mockReturnValue({
      walletAddress: WALLET,
      tax_status: "completed",
      tax_id: "12-3456789",
    });
    mockCreateTaxForm.mockReturnValue(sampleRecord);
  });

  test("returns 400 when walletAddress is missing", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ taxYear: TAX_YEAR });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("returns 400 when walletAddress is invalid", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: "INVALID", taxYear: TAX_YEAR });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("returns 400 when taxYear is out of range", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: "1990" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("returns cached form when one exists", async () => {
    mockGetLatestTaxForm.mockReturnValue(sampleRecord);
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cached).toBe(true);
    expect(res.body.data.formType).toBe("1099-NEC");
    // Should NOT call price oracle for cached results
    expect(mockGetXlmUsdPrice).not.toHaveBeenCalled();
  });

  test("generates a new form when distributions are provided and no cache exists", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({
        distributions: [
          { amountXlm: 7000, timestamp: "2024-06-01T00:00:00Z", txHash: "abc123" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.formType).toBe("1099-NEC");
    expect(mockCreateTaxForm).toHaveBeenCalledTimes(1);
  });

  test("returns 503 when price oracle is unavailable", async () => {
    mockGetXlmUsdPrice.mockResolvedValue({ ok: false, reason: "network_error" });
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 7000, timestamp: "2024-06-01T00:00:00Z" }] });
    expect(res.status).toBe(503);
  });

  test("below-threshold income returns ok:true with belowThreshold flag", async () => {
    // $0.12/XLM * 100 XLM = $12 — well below $600
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 100, timestamp: "2024-03-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.belowThreshold).toBe(true);
    expect(res.body.data.formType).toBe("1099-NEC");
    // No DB record stored for below-threshold
    expect(mockCreateTaxForm).not.toHaveBeenCalled();
  });

  test("force=true bypasses cache and regenerates", async () => {
    mockGetLatestTaxForm.mockReturnValue(sampleRecord); // cache exists
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR, force: "true" })
      .send({ distributions: [{ amountXlm: 7000, timestamp: "2024-06-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    // Cache should have been bypassed
    expect(mockGetXlmUsdPrice).toHaveBeenCalledTimes(1);
    expect(mockCreateTaxForm).toHaveBeenCalledTimes(1);
  });
});

// ─── E2E: generate 1099, verify PDF contains correct totals ──────────────────

describe("E2E: generate 1099-NEC with correct totals", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestTaxForm.mockReturnValue(null);
    mockGetContributorTax.mockReturnValue({
      walletAddress: WALLET,
      tax_status: "completed",
      tax_id: "12-3456789",
    });
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: XLM_RATE, source: "mock" });
    // Make createTaxForm return a record with the correct computed formData
    mockCreateTaxForm.mockImplementation((data) => ({
      id: 42,
      ...data,
      formData: data.formData,
      paymentBreakdown: data.paymentBreakdown,
      status: "generated",
      createdAt: new Date().toISOString(),
      updatedAt: null,
    }));
  });

  test("generates 1099-NEC with correct income totals across multiple distributions", async () => {
    // 5000 XLM + 1500 XLM = 6500 XLM at $0.12 = $780 USD (above $600 threshold)
    const distributions = [
      { amountXlm: 5000, timestamp: "2024-03-15T00:00:00Z", txHash: "tx001" },
      { amountXlm: 1500, timestamp: "2024-09-20T00:00:00Z", txHash: "tx002" },
    ];

    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: "2024" })
      .send({ distributions });

    expect(res.status).toBe(200);
    const form = res.body.data;

    // Verify PDF-ready flag is set
    expect(form.pdfReady).toBe(true);

    // Verify IRS form fields are present
    expect(form.formType).toBe("1099-NEC");
    expect(form.taxYear).toBe("2024");
    expect(form.box1NonemployeeCompensation).toBeDefined();
    expect(form.box4FederalIncomeTaxWithheld).toBeDefined();

    // Verify total income: 6500 XLM * $0.12 = $780.00
    expect(form.totalIncomeUsd).toBe("780.00");
    expect(form.totalIncomeUsdCents).toBe(78000);

    // Tax ID is on file so NO backup withholding
    expect(form.backupWithholdingApplied).toBe(false);
    expect(form.box4FederalIncomeTaxWithheld).toBe("0.00");

    // Verify filing threshold is met
    expect(form.meetsFilingThreshold).toBe(true);

    // Verify payment breakdown is included with correct structure
    expect(form.paymentBreakdown).toHaveLength(2);
    expect(form.paymentBreakdown[0].txHash).toBe("tx001");
    expect(form.paymentBreakdown[0].xlmAmount).toBe("5000.0000000");
    expect(form.paymentBreakdown[0].usdAmount).toBe("600.00");
    expect(form.paymentBreakdown[1].xlmAmount).toBe("1500.0000000");
    expect(form.paymentBreakdown[1].usdAmount).toBe("180.00");

    // Verify collaborator address is in the form
    expect(form.recipientAddress).toBe(WALLET);
  });

  test("applies 24% backup withholding when no tax ID is on file", async () => {
    mockGetContributorTax.mockReturnValue({
      walletAddress: WALLET,
      tax_status: "not_collected",
      tax_id: null,
    });

    // 7000 XLM * $0.12 = $840 — above $600 threshold
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: "2024" })
      .send({ distributions: [{ amountXlm: 7000, timestamp: "2024-06-01T00:00:00Z" }] });

    expect(res.status).toBe(200);
    const form = res.body.data;

    // 24% backup withholding: $840 * 0.24 = $201.60
    expect(form.backupWithholdingApplied).toBe(true);
    const withheld = parseFloat(form.box4FederalIncomeTaxWithheld);
    expect(withheld).toBeCloseTo(840 * 0.24, 0);

    // TIN should be masked/null
    expect(form.recipientTin).toBeNull();
  });

  test("PDF payload contains all required IRS 1099-NEC fields", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: "2024" })
      .send({
        distributions: [{ amountXlm: 7000, timestamp: "2024-06-01T00:00:00Z" }],
      });

    expect(res.status).toBe(200);
    const form = res.body.data;

    // IRS-required fields
    const requiredFields = [
      "formType",
      "taxYear",
      "country",
      "payerName",
      "recipientAddress",
      "box1NonemployeeCompensation",
      "box4FederalIncomeTaxWithheld",
      "totalIncomeUsd",
      "meetsFilingThreshold",
      "pdfReady",
      "generatedAt",
      "paymentBreakdown",
    ];

    for (const field of requiredFields) {
      expect(form).toHaveProperty(field);
    }
  });
});

// ─── Route tests: GET /t4a ────────────────────────────────────────────────────

describe("GET /api/v1/tax/reports/t4a", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: XLM_RATE, source: "mock" });
    mockGetLatestTaxForm.mockReturnValue(null);
    mockGetContributorTax.mockReturnValue(null);
    mockCreateTaxForm.mockReturnValue({
      id: 2,
      walletAddress: WALLET,
      taxYear: TAX_YEAR,
      formType: "T4A",
      country: "CA",
      totalIncomeUsd: 90000,
      withheldUsd: 0,
      formData: {
        formType: "T4A",
        taxYear: TAX_YEAR,
        country: "CA",
        box048FeesForServices: "900.00",
        totalIncomeUsd: "900.00",
        totalIncomeUsdCents: 90000,
        meetsFilingThreshold: true,
        pdfReady: true,
        generatedAt: new Date().toISOString(),
      },
      paymentBreakdown: [],
      status: "generated",
    });
  });

  test("returns 400 when walletAddress is missing", async () => {
    const res = await request(app).get("/api/v1/tax/reports/t4a").query({ taxYear: TAX_YEAR });
    expect(res.status).toBe(400);
  });

  test("generates T4A successfully", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/t4a")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 7500, timestamp: "2024-08-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.formType).toBe("T4A");
    expect(res.body.data.country).toBe("CA");
    expect(res.body.data.box048FeesForServices).toBeDefined();
  });

  test("T4A has no withholding", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/t4a")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 7500, timestamp: "2024-08-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.withheldUsdCents).toBe(0);
  });

  test("T4A meets filing threshold for $900 income", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/t4a")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 7500, timestamp: "2024-08-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.meetsFilingThreshold).toBe(true);
  });
});

// ─── Route tests: GET /eu-vat ─────────────────────────────────────────────────

describe("GET /api/v1/tax/reports/eu-vat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: XLM_RATE, source: "mock" });
    mockGetLatestTaxForm.mockReturnValue(null);
    mockCreateTaxForm.mockReturnValue({
      id: 3,
      walletAddress: WALLET,
      taxYear: TAX_YEAR,
      formType: "EU-VAT",
      country: "EU",
      totalIncomeUsd: 60000,
      withheldUsd: 0,
      formData: {
        formType: "EU-VAT",
        taxYear: TAX_YEAR,
        country: "EU",
        totalIncomeUsd: "600.00",
        totalIncomeUsdCents: 60000,
        withheldUsdCents: 0,
        pdfReady: true,
        generatedAt: new Date().toISOString(),
      },
      paymentBreakdown: [],
      status: "generated",
    });
  });

  test("generates EU-VAT summary successfully", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/eu-vat")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 5000, timestamp: "2024-05-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.formType).toBe("EU-VAT");
    expect(res.body.data.country).toBe("EU");
    expect(res.body.data.withheldUsdCents).toBe(0);
  });

  test("EU-VAT includes SEPA/VAT note", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/eu-vat")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 5000, timestamp: "2024-05-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.vatNote).toBeDefined();
    expect(res.body.data.pdfReady).toBe(true);
  });
});

// ─── Route tests: GET /export-tax-summary ─────────────────────────────────────

describe("GET /api/v1/tax/reports/export-tax-summary", () => {
  const sampleSummaryData = {
    taxYear: TAX_YEAR,
    country: "ALL",
    summary: [
      { walletAddress: WALLET, country: "US", formType: "1099-NEC", totalIncomeUsd: 75000, totalWithheldUsd: 0, formCount: 1 },
      { walletAddress: WALLET2, country: "CA", formType: "T4A", totalIncomeUsd: 90000, totalWithheldUsd: 0, formCount: 1 },
    ],
    forms: [
      { id: 1, walletAddress: WALLET, formType: "1099-NEC", country: "US", totalIncomeUsd: "750.00", withheldUsd: "0.00", status: "generated", createdAt: "2025-01-15T00:00:00.000Z" },
    ],
    totals: { totalIncomeUsdCents: 165000, totalIncomeUsd: "1650.00", totalWithheldUsdCents: 0, totalWithheldUsd: "0.00", collaboratorCount: 2, formCount: 1 },
    generatedAt: new Date().toISOString(),
    pdfReady: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTaxYearSummary.mockReturnValue(sampleSummaryData.summary);
    mockListTaxForms.mockReturnValue([sampleRecord]);
  });

  test("returns JSON summary by default", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/export-tax-summary")
      .query({ taxYear: TAX_YEAR });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.taxYear).toBe(TAX_YEAR);
    expect(res.body.data.totals).toBeDefined();
    expect(res.body.data.pdfReady).toBe(true);
  });

  test("returns CSV with correct headers and rows when format=csv", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/export-tax-summary")
      .query({ taxYear: TAX_YEAR, format: "csv" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/tax-summary-2024\.csv/);
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toContain("Wallet Address");
    expect(lines[0]).toContain("Form Type");
    expect(lines[0]).toContain("Total Income (USD)");
    expect(lines[0]).toContain("Withheld (USD)");
    expect(lines.length).toBeGreaterThan(1);
  });

  test("filters by country when country param is provided", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/export-tax-summary")
      .query({ taxYear: TAX_YEAR, country: "US" });
    expect(res.status).toBe(200);
    expect(mockListTaxForms).toHaveBeenCalledWith(
      expect.objectContaining({ country: "US", taxYear: TAX_YEAR }),
      expect.any(Number),
      expect.any(Number),
    );
  });

  test("returns 400 for invalid country param", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/export-tax-summary")
      .query({ taxYear: TAX_YEAR, country: "NARNIA" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("includes generatedAt timestamp in output", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/export-tax-summary")
      .query({ taxYear: TAX_YEAR });
    expect(res.status).toBe(200);
    expect(res.body.data.generatedAt).toBeDefined();
    expect(new Date(res.body.data.generatedAt).getFullYear()).toBeGreaterThanOrEqual(2025);
  });
});

// ─── Route tests: GET /list ───────────────────────────────────────────────────

describe("GET /api/v1/tax/reports/list", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListTaxForms.mockReturnValue([sampleRecord]);
    mockCountTaxForms.mockReturnValue(1);
  });

  test("returns list of forms", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/list")
      .query({ walletAddress: WALLET });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  test("supports filtering by formType and taxYear", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/list")
      .query({ walletAddress: WALLET, formType: "1099-NEC", taxYear: TAX_YEAR });
    expect(res.status).toBe(200);
    expect(mockListTaxForms).toHaveBeenCalledWith(
      expect.objectContaining({ formType: "1099-NEC", taxYear: TAX_YEAR }),
      expect.any(Number),
      expect.any(Number),
    );
  });

  test("returns empty list when no forms exist", async () => {
    mockListTaxForms.mockReturnValue([]);
    mockCountTaxForms.mockReturnValue(0);
    const res = await request(app)
      .get("/api/v1/tax/reports/list")
      .query({ walletAddress: WALLET });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

// ─── Route tests: GET /:id ────────────────────────────────────────────────────

describe("GET /api/v1/tax/reports/:id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTaxForm.mockReturnValue(sampleRecord);
  });

  test("returns form by id", async () => {
    const res = await request(app).get("/api/v1/tax/reports/1");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.formType).toBe("1099-NEC");
  });

  test("returns 404 when form does not exist", async () => {
    mockGetTaxForm.mockReturnValue(null);
    const res = await request(app).get("/api/v1/tax/reports/999");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  test("returns 400 for non-numeric id", async () => {
    const res = await request(app).get("/api/v1/tax/reports/abc");
    expect(res.status).toBe(400);
  });

  test("returns 400 for id of 0", async () => {
    const res = await request(app).get("/api/v1/tax/reports/0");
    expect(res.status).toBe(400);
  });
});

// ─── Route tests: POST /:id/void ──────────────────────────────────────────────

describe("POST /api/v1/tax/reports/:id/void", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTaxForm.mockReturnValue(sampleRecord);
    mockVoidTaxForm.mockReturnValue(undefined);
  });

  test("voids a form successfully", async () => {
    const res = await request(app)
      .post("/api/v1/tax/reports/1/void")
      .send({ reason: "Duplicate filing" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockVoidTaxForm).toHaveBeenCalledWith(1, "Duplicate filing");
  });

  test("voids a form without reason", async () => {
    const res = await request(app)
      .post("/api/v1/tax/reports/1/void")
      .send({});
    expect(res.status).toBe(200);
    expect(mockVoidTaxForm).toHaveBeenCalledWith(1, null);
  });

  test("returns 404 for non-existent form", async () => {
    mockGetTaxForm.mockReturnValue(null);
    const res = await request(app)
      .post("/api/v1/tax/reports/999/void")
      .send({});
    expect(res.status).toBe(404);
  });

  test("returns 409 when form is already voided", async () => {
    mockGetTaxForm.mockReturnValue({ ...sampleRecord, status: "void" });
    const res = await request(app)
      .post("/api/v1/tax/reports/1/void")
      .send({});
    expect(res.status).toBe(409);
  });

  test("returns 400 for invalid id", async () => {
    const res = await request(app)
      .post("/api/v1/tax/reports/notanid/void")
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─── Service unit tests: generate1099Nec ─────────────────────────────────────

describe("Service: generate1099Nec", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestTaxForm.mockReturnValue(null);
    mockGetContributorTax.mockReturnValue(null);
    mockCreateTaxForm.mockImplementation((data) => ({
      id: 99,
      ...data,
      formData: data.formData,
      paymentBreakdown: data.paymentBreakdown,
      status: "generated",
      createdAt: new Date().toISOString(),
    }));
  });

  test("returns ok:false when walletAddress is missing", async () => {
    const { generate1099Nec } = await import("../src/services/tax-reporting.js");
    const result = await generate1099Nec({ taxYear: "2024", distributions: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_wallet_address");
  });

  test("returns ok:false when price oracle fails", async () => {
    const { generate1099Nec } = await import("../src/services/tax-reporting.js");
    const result = await generate1099Nec({
      walletAddress: WALLET,
      taxYear: "2024",
      distributions: [{ amountXlm: 7000, timestamp: "2024-06-01" }],
      priceOracleFn: async () => ({ ok: false, reason: "network_error" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("price_oracle_unavailable");
  });

  test("returns cached:false and persists when generating new form", async () => {
    const { generate1099Nec } = await import("../src/services/tax-reporting.js");
    const result = await generate1099Nec({
      walletAddress: WALLET,
      taxYear: "2024",
      distributions: [{ amountXlm: 7000, timestamp: "2024-06-01T00:00:00Z" }],
      priceOracleFn: async () => ({ ok: true, rate: 0.12, source: "mock" }),
    });
    expect(result.ok).toBe(true);
    expect(result.cached).toBe(false);
    expect(mockCreateTaxForm).toHaveBeenCalledTimes(1);
    // Verify createTaxForm received country=US
    expect(mockCreateTaxForm).toHaveBeenCalledWith(
      expect.objectContaining({ country: "US", formType: "1099-NEC" }),
    );
  });

  test("returns cached:true and skips generation when cache exists", async () => {
    mockGetLatestTaxForm.mockReturnValue(sampleRecord);
    const { generate1099Nec } = await import("../src/services/tax-reporting.js");
    const result = await generate1099Nec({
      walletAddress: WALLET,
      taxYear: "2024",
      distributions: [],
      priceOracleFn: async () => ({ ok: true, rate: 0.12, source: "mock" }),
    });
    expect(result.ok).toBe(true);
    expect(result.cached).toBe(true);
    expect(mockCreateTaxForm).not.toHaveBeenCalled();
  });

  test("stroop-based distributions are correctly converted to XLM", async () => {
    const { generate1099Nec } = await import("../src/services/tax-reporting.js");
    // 70_000_000 stroops = 7 XLM at $0.12 = $0.84 — below $600 threshold
    const result = await generate1099Nec({
      walletAddress: WALLET,
      taxYear: "2024",
      distributions: [{ amountStroops: 70_000_000_000, timestamp: "2024-06-01" }],
      priceOracleFn: async () => ({ ok: true, rate: 0.12, source: "mock" }),
    });
    expect(result.ok).toBe(true);
    // 70_000_000_000 stroops / 10_000_000 = 7000 XLM * $0.12 = $840 > $600
    expect(result.form.meetsFilingThreshold).toBe(true);
  });

  test("withholding correct: 24% applied when no TIN on file", async () => {
    mockGetContributorTax.mockReturnValue({ walletAddress: WALLET, tax_status: "not_collected", tax_id: null });
    const { generate1099Nec } = await import("../src/services/tax-reporting.js");
    const result = await generate1099Nec({
      walletAddress: WALLET,
      taxYear: "2024",
      distributions: [{ amountXlm: 7000, timestamp: "2024-06-01" }],
      priceOracleFn: async () => ({ ok: true, rate: 0.12, source: "mock" }),
    });
    expect(result.ok).toBe(true);
    expect(result.form.backupWithholdingApplied).toBe(true);
    // 7000 * 0.12 * 100 = 84000 cents; 24% of 84000 = 20160 cents
    expect(result.form.withheldUsdCents).toBe(Math.round(84000 * 0.24));
  });

  test("withholding not applied when valid TIN exists", async () => {
    mockGetContributorTax.mockReturnValue({ walletAddress: WALLET, tax_status: "completed", tax_id: "12-3456789" });
    const { generate1099Nec } = await import("../src/services/tax-reporting.js");
    const result = await generate1099Nec({
      walletAddress: WALLET,
      taxYear: "2024",
      distributions: [{ amountXlm: 7000, timestamp: "2024-06-01" }],
      priceOracleFn: async () => ({ ok: true, rate: 0.12, source: "mock" }),
    });
    expect(result.ok).toBe(true);
    expect(result.form.backupWithholdingApplied).toBe(false);
    expect(result.form.withheldUsdCents).toBe(0);
  });
});

// ─── Service unit tests: exportTaxSummary ────────────────────────────────────

describe("Service: exportTaxSummary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTaxYearSummary.mockReturnValue([
      { walletAddress: WALLET, country: "US", formType: "1099-NEC", totalIncomeUsd: 75000, totalWithheldUsd: 0, formCount: 1 },
      { walletAddress: WALLET2, country: "CA", formType: "T4A", totalIncomeUsd: 90000, totalWithheldUsd: 0, formCount: 1 },
    ]);
    mockListTaxForms.mockReturnValue([sampleRecord]);
  });

  test("returns summary with correct structure", async () => {
    const { exportTaxSummary } = await import("../src/services/tax-reporting.js");
    const result = exportTaxSummary({ taxYear: "2024" });
    expect(result.taxYear).toBe("2024");
    expect(result.summary).toHaveLength(2);
    expect(result.totals.totalIncomeUsdCents).toBe(165000);
    expect(result.totals.totalIncomeUsd).toBe("1650.00");
    expect(result.pdfReady).toBe(true);
    expect(result.generatedAt).toBeDefined();
  });

  test("filters summary by country", async () => {
    const { exportTaxSummary } = await import("../src/services/tax-reporting.js");
    const result = exportTaxSummary({ taxYear: "2024", country: "US" });
    expect(result.country).toBe("US");
    expect(result.summary.every((r) => r.country === "US")).toBe(true);
  });

  test("returns forms list for accountant review", async () => {
    const { exportTaxSummary } = await import("../src/services/tax-reporting.js");
    const result = exportTaxSummary({ taxYear: "2024" });
    expect(result.forms).toHaveLength(1);
    expect(result.forms[0].walletAddress).toBe(WALLET);
    expect(result.forms[0].totalIncomeUsd).toBeDefined();
    expect(result.forms[0].withheldUsd).toBeDefined();
  });
});

// ─── Tax year selection ───────────────────────────────────────────────────────

describe("Tax year selection", () => {
  test("defaults to prior year when taxYear is not specified", async () => {
    jest.clearAllMocks();
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: XLM_RATE, source: "mock" });
    mockGetLatestTaxForm.mockReturnValue(null);
    mockGetContributorTax.mockReturnValue(null);
    mockCreateTaxForm.mockReturnValue(sampleRecord);

    const currentYear = new Date().getFullYear();
    const expectedDefaultYear = String(currentYear - 1);

    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET })
      .send({ distributions: [{ amountXlm: 7000, timestamp: `${expectedDefaultYear}-06-01T00:00:00Z` }] });

    expect(res.status).toBe(200);
    expect(mockGetLatestTaxForm).toHaveBeenCalledWith(WALLET, expectedDefaultYear, "1099-NEC");
  });

  test("accepts taxYear=2024", async () => {
    jest.clearAllMocks();
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: XLM_RATE, source: "mock" });
    mockGetLatestTaxForm.mockReturnValue(null);
    mockGetContributorTax.mockReturnValue(null);
    mockCreateTaxForm.mockReturnValue(sampleRecord);

    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: "2024" })
      .send({ distributions: [{ amountXlm: 7000, timestamp: "2024-06-01T00:00:00Z" }] });

    expect(res.status).toBe(200);
    expect(mockGetLatestTaxForm).toHaveBeenCalledWith(WALLET, "2024", "1099-NEC");
  });

  test("returns 400 for taxYear before 2020", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: "2019" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("accepts taxYear=2025", async () => {
    jest.clearAllMocks();
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: XLM_RATE, source: "mock" });
    mockGetLatestTaxForm.mockReturnValue(null);
    mockGetContributorTax.mockReturnValue(null);
    mockCreateTaxForm.mockReturnValue(sampleRecord);

    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: "2025" })
      .send({ distributions: [{ amountXlm: 7000, timestamp: "2025-03-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
  });
});

// ─── Multi-country support ────────────────────────────────────────────────────

describe("Multi-country support", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetXlmUsdPrice.mockResolvedValue({ ok: true, rate: XLM_RATE, source: "mock" });
    mockGetLatestTaxForm.mockReturnValue(null);
    mockGetContributorTax.mockReturnValue(null);
    mockCreateTaxForm.mockImplementation((data) => ({
      id: Math.floor(Math.random() * 1000),
      ...data,
      formData: data.formData,
      paymentBreakdown: data.paymentBreakdown,
      status: "generated",
      createdAt: new Date().toISOString(),
    }));
  });

  test("US 1099-NEC form has country=US", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/1099-nec")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 7000, timestamp: "2024-06-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.country).toBe("US");
  });

  test("CA T4A form has country=CA", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/t4a")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 7500, timestamp: "2024-08-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.country).toBe("CA");
  });

  test("EU VAT form has country=EU", async () => {
    const res = await request(app)
      .get("/api/v1/tax/reports/eu-vat")
      .query({ walletAddress: WALLET, taxYear: TAX_YEAR })
      .send({ distributions: [{ amountXlm: 5000, timestamp: "2024-05-01T00:00:00Z" }] });
    expect(res.status).toBe(200);
    expect(res.body.data.country).toBe("EU");
  });

  test("each country stores forms with createTaxForm using correct formType", async () => {
    const { generate1099Nec, generateT4A, generateEuVat } = await import("../src/services/tax-reporting.js");
    const priceOracleFn = async () => ({ ok: true, rate: 0.12, source: "mock" });
    const dists = [{ amountXlm: 7000, timestamp: "2024-06-01" }];

    await generate1099Nec({ walletAddress: WALLET, taxYear: "2024", distributions: dists, priceOracleFn });
    await generateT4A({ walletAddress: WALLET, taxYear: "2024", distributions: dists, priceOracleFn });
    await generateEuVat({ walletAddress: WALLET, taxYear: "2024", distributions: dists, priceOracleFn });

    const calls = mockCreateTaxForm.mock.calls.map((c) => c[0].formType);
    expect(calls).toContain("1099-NEC");
    expect(calls).toContain("T4A");
    expect(calls).toContain("EU-VAT");
  });
});
