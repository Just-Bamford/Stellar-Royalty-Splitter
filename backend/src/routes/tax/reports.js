/**
 * Tax compliance reporting routes — closes #950.
 *
 * GET /api/v1/tax/reports/1099-nec
 *   Generate or retrieve a cached IRS 1099-NEC for a collaborator.
 *
 * GET /api/v1/tax/reports/t4a
 *   Generate or retrieve a cached CRA T4A for a Canadian collaborator.
 *
 * GET /api/v1/tax/reports/eu-vat
 *   Generate or retrieve a cached EU VAT summary for a European collaborator.
 *
 * GET /api/v1/tax/reports/export-tax-summary
 *   Full-year summary across all collaborators for accountant/IRS filing.
 *
 * All endpoints accept ?walletAddress= and ?taxYear= query params.
 * The export-tax-summary endpoint additionally accepts ?country= and ?format=csv|json.
 *
 * Admin role is required for the summary export. Individual form generation
 * is available to any authenticated caller (the caller supplies their own
 * walletAddress; no cross-wallet access is enforced at this layer — the RBAC
 * middleware handles role elevation for the summary endpoint).
 */

import { Router } from "express";
import { sendError } from "../../error-response.js";
import { requireRole } from "../../middleware/rbac.js";
import {
  generate1099Nec,
  generateT4A,
  generateEuVat,
  exportTaxSummary,
} from "../../services/tax-reporting.js";
import { listTaxForms, countTaxForms, voidTaxForm, getTaxForm } from "../../database/tax-forms.js";

export const taxReportsRouter = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate and parse common query params (walletAddress, taxYear).
 * Returns { walletAddress, taxYear } or sends 400 and returns null.
 */
function parseCommonParams(req, res, { requireWallet = true } = {}) {
  const { walletAddress, taxYear } = req.query;

  if (requireWallet) {
    if (!walletAddress || typeof walletAddress !== "string") {
      sendError(res, 400, "missing_wallet_address", "walletAddress query parameter is required");
      return null;
    }
    if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
      sendError(res, 400, "invalid_stellar_address", "walletAddress must be a valid Stellar G-address");
      return null;
    }
  }

  const year = taxYear ? String(taxYear) : String(new Date().getFullYear() - 1);
  if (!/^\d{4}$/.test(year) || Number(year) < 2020 || Number(year) > new Date().getFullYear()) {
    sendError(
      res,
      400,
      "invalid_tax_year",
      `taxYear must be a 4-digit year between 2020 and ${new Date().getFullYear()}`,
    );
    return null;
  }

  return { walletAddress, taxYear: year };
}

/** Build a distributions array from query params or body. */
function parseDistributions(req) {
  // Distributions can be passed as a JSON body array (POST) or as a
  // `distributions` query param (JSON-encoded). For GET endpoints with no
  // distributions supplied, we return an empty array — the service will
  // then try to return a cached form rather than a live-calculated one.
  try {
    if (req.body && Array.isArray(req.body.distributions)) {
      return req.body.distributions;
    }
    if (req.query.distributions) {
      const parsed = JSON.parse(req.query.distributions);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    return [];
  }
  return [];
}

// ─── GET /1099-nec ────────────────────────────────────────────────────────────

/**
 * @route GET /api/v1/tax/reports/1099-nec
 * @query walletAddress {string} required - Collaborator Stellar address
 * @query taxYear {string} optional - e.g. "2024" (defaults to prior year)
 * @query force {string} optional - "true" to bypass cached form
 *
 * Accepts an optional JSON body:
 *   { distributions: [{ amountXlm, timestamp, txHash }] }
 *
 * When `distributions` is omitted, the endpoint returns the most recently
 * cached 1099-NEC for the wallet + year (if one exists) or returns 404.
 */
taxReportsRouter.get("/1099-nec", async (req, res) => {
  const params = parseCommonParams(req, res);
  if (!params) return;

  const { walletAddress, taxYear } = params;
  const force = req.query.force === "true";
  const distributions = parseDistributions(req);

  const result = await generate1099Nec({ walletAddress, taxYear, distributions, force });

  if (!result.ok) {
    if (result.reason.startsWith("price_oracle_unavailable")) {
      return sendError(
        res,
        503,
        "price_oracle_unavailable",
        "XLM/USD price oracle is currently unavailable. Please try again shortly.",
      );
    }
    return sendError(res, 400, result.reason, result.reason);
  }

  return res.json({
    success: true,
    cached: result.cached ?? false,
    formId: result.id ?? null,
    data: result.form,
  });
});

// ─── GET /t4a ─────────────────────────────────────────────────────────────────

/**
 * @route GET /api/v1/tax/reports/t4a
 * @query walletAddress {string} required
 * @query taxYear {string} optional
 * @query force {string} optional
 */
taxReportsRouter.get("/t4a", async (req, res) => {
  const params = parseCommonParams(req, res);
  if (!params) return;

  const { walletAddress, taxYear } = params;
  const force = req.query.force === "true";
  const distributions = parseDistributions(req);

  const result = await generateT4A({ walletAddress, taxYear, distributions, force });

  if (!result.ok) {
    if (result.reason.startsWith("price_oracle_unavailable")) {
      return sendError(res, 503, "price_oracle_unavailable", "XLM/USD price oracle unavailable.");
    }
    return sendError(res, 400, result.reason, result.reason);
  }

  return res.json({
    success: true,
    cached: result.cached ?? false,
    formId: result.id ?? null,
    data: result.form,
  });
});

// ─── GET /eu-vat ──────────────────────────────────────────────────────────────

/**
 * @route GET /api/v1/tax/reports/eu-vat
 * @query walletAddress {string} required
 * @query taxYear {string} optional
 * @query force {string} optional
 */
taxReportsRouter.get("/eu-vat", async (req, res) => {
  const params = parseCommonParams(req, res);
  if (!params) return;

  const { walletAddress, taxYear } = params;
  const force = req.query.force === "true";
  const distributions = parseDistributions(req);

  const result = await generateEuVat({ walletAddress, taxYear, distributions, force });

  if (!result.ok) {
    if (result.reason.startsWith("price_oracle_unavailable")) {
      return sendError(res, 503, "price_oracle_unavailable", "XLM/USD price oracle unavailable.");
    }
    return sendError(res, 400, result.reason, result.reason);
  }

  return res.json({
    success: true,
    cached: result.cached ?? false,
    formId: result.id ?? null,
    data: result.form,
  });
});

// ─── GET /export-tax-summary ──────────────────────────────────────────────────

/**
 * @route GET /api/v1/tax/reports/export-tax-summary
 * @query taxYear {string} optional - defaults to prior year
 * @query country {string} optional - "US" | "CA" | "EU" | omit for all
 * @query format {string} optional - "csv" | "json" (default json)
 *
 * Admin-only endpoint. Returns aggregated income & withholding data
 * for all collaborators in the specified tax year.
 */
taxReportsRouter.get("/export-tax-summary", requireRole("admin"), (req, res) => {
  const params = parseCommonParams(req, res, { requireWallet: false });
  if (!params) return;

  const { taxYear } = params;
  const { country = null, format = "json" } = req.query;

  const allowedCountries = ["US", "CA", "EU"];
  if (country && !allowedCountries.includes(country)) {
    return sendError(
      res,
      400,
      "invalid_country",
      `country must be one of: ${allowedCountries.join(", ")}`,
    );
  }

  let summary;
  try {
    summary = exportTaxSummary({ taxYear, country });
  } catch (err) {
    return sendError(res, 500, "export_failed", "Failed to generate tax summary");
  }

  if (format === "csv") {
    return sendCsvExport(res, summary, taxYear);
  }

  return res.json({ success: true, data: summary });
});

/**
 * Stream a CSV export of the tax summary.
 */
function escapeCSV(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sendCsvExport(res, summary, taxYear) {
  const headers = [
    "Wallet Address",
    "Form Type",
    "Country",
    "Tax Year",
    "Total Income (USD)",
    "Withheld (USD)",
    "Status",
    "Generated At",
  ];

  const rows = [headers.map(escapeCSV).join(",")];

  for (const form of summary.forms) {
    rows.push(
      [
        escapeCSV(form.walletAddress),
        escapeCSV(form.formType),
        escapeCSV(form.country),
        escapeCSV(taxYear),
        escapeCSV(form.totalIncomeUsd),
        escapeCSV(form.withheldUsd),
        escapeCSV(form.status),
        escapeCSV(form.createdAt),
      ].join(","),
    );
  }

  const csv = rows.join("\n");
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set(
    "Content-Disposition",
    `attachment; filename="tax-summary-${taxYear}.csv"`,
  );
  return res.status(200).send(csv);
}

// ─── GET /list ────────────────────────────────────────────────────────────────

/**
 * @route GET /api/v1/tax/reports/list
 * @query walletAddress {string} optional
 * @query taxYear {string} optional
 * @query formType {string} optional - "1099-NEC" | "T4A" | "EU-VAT"
 * @query country {string} optional
 * @query status {string} optional - "generated" | "void" | "amended"
 * @query limit {number} optional - default 50
 * @query offset {number} optional - default 0
 *
 * List stored tax forms. Admin can list all; others must supply walletAddress.
 */
taxReportsRouter.get("/list", (req, res) => {
  const { walletAddress, taxYear, formType, country, status } = req.query;
  const limit = Math.min(parseInt(req.query.limit ?? "50", 10), 200);
  const offset = parseInt(req.query.offset ?? "0", 10);

  // Non-admins must scope to their own wallet
  if (req.role !== "admin" && !walletAddress) {
    return sendError(
      res,
      400,
      "missing_wallet_address",
      "walletAddress is required for non-admin callers",
    );
  }

  try {
    const forms = listTaxForms({ walletAddress, taxYear, formType, country, status }, limit, offset);
    const total = countTaxForms({ walletAddress, taxYear, formType, country, status });

    return res.json({ success: true, data: forms, total, limit, offset });
  } catch (err) {
    return sendError(res, 500, "list_failed", "Failed to list tax forms");
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────

/**
 * @route GET /api/v1/tax/reports/:id
 * Fetch a specific tax form by its database id.
 */
taxReportsRouter.get("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return sendError(res, 400, "invalid_id", "id must be a positive integer");
  }

  try {
    const form = getTaxForm(id);
    if (!form) {
      return sendError(res, 404, "form_not_found", `Tax form with id ${id} not found`);
    }

    // Non-admins can only view their own forms
    if (req.role !== "admin" && req.query.walletAddress && form.walletAddress !== req.query.walletAddress) {
      return sendError(res, 403, "forbidden", "You do not have access to this tax form");
    }

    return res.json({ success: true, data: form });
  } catch (err) {
    return sendError(res, 500, "fetch_failed", "Failed to fetch tax form");
  }
});

// ─── POST /:id/void ───────────────────────────────────────────────────────────

/**
 * @route POST /api/v1/tax/reports/:id/void
 * Void a previously generated tax form. Admin only.
 * Body: { reason?: string }
 */
taxReportsRouter.post("/:id/void", requireRole("admin"), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return sendError(res, 400, "invalid_id", "id must be a positive integer");
  }

  try {
    const existing = getTaxForm(id);
    if (!existing) {
      return sendError(res, 404, "form_not_found", `Tax form with id ${id} not found`);
    }
    if (existing.status === "void") {
      return sendError(res, 409, "already_voided", "This tax form has already been voided");
    }

    const reason = req.body?.reason ?? null;
    voidTaxForm(id, reason);

    return res.json({ success: true, message: `Tax form ${id} has been voided`, id });
  } catch (err) {
    return sendError(res, 500, "void_failed", "Failed to void tax form");
  }
});
