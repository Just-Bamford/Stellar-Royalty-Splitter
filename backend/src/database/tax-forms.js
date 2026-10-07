/**
 * Tax form storage — closes #950.
 *
 * Persists generated 1099-NEC records and tax-year summaries so the API can
 * return previously generated forms without re-calculating them every request.
 *
 * Schema is created via migration version 18 in core.js.
 */

import { db, countWrite } from "./core.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const TAX_FORM_TYPES = /** @type {const} */ (["1099-NEC", "T4A", "EU-VAT"]);
export const TAX_FORM_STATUSES = /** @type {const} */ (["generated", "void", "amended"]);
export const SUPPORTED_COUNTRIES = /** @type {const} */ (["US", "CA", "EU"]);

/** IRS 1099-NEC threshold: payments of $600 or more require a 1099-NEC. */
export const IRS_1099_THRESHOLD_USD = 600;

/** Canada CRA T4A threshold (CAD equivalent, using conservative USD approximation). */
export const CRA_T4A_THRESHOLD_USD = 500;

// ─── Row parsing ─────────────────────────────────────────────────────────────

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    formData: row.formData ? JSON.parse(row.formData) : null,
    paymentBreakdown: row.paymentBreakdown ? JSON.parse(row.paymentBreakdown) : [],
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Store a newly generated tax form record.
 *
 * @param {object} params
 * @param {string}  params.walletAddress  - Collaborator's Stellar address
 * @param {string}  params.taxYear        - e.g. "2025"
 * @param {string}  params.formType       - "1099-NEC" | "T4A" | "EU-VAT"
 * @param {string}  params.country        - "US" | "CA" | "EU"
 * @param {number}  params.totalIncomeUsd - Total income in USD (cents)
 * @param {number}  params.withheldUsd    - Federal withholding in USD (cents)
 * @param {object}  params.formData       - Full structured form data
 * @param {object[]} params.paymentBreakdown - Per-transaction breakdown
 * @param {string}  [params.generatedBy]  - "system" or walletAddress of requester
 * @returns {object} The inserted record
 */
export function createTaxForm({
  walletAddress,
  taxYear,
  formType,
  country,
  totalIncomeUsd,
  withheldUsd = 0,
  formData = {},
  paymentBreakdown = [],
  generatedBy = "system",
}) {
  const result = db
    .prepare(
      `INSERT INTO tax_forms
        (walletAddress, taxYear, formType, country, totalIncomeUsd, withheldUsd,
         formData, paymentBreakdown, status, generatedBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?, CURRENT_TIMESTAMP)`,
    )
    .run(
      walletAddress,
      String(taxYear),
      formType,
      country,
      totalIncomeUsd,
      withheldUsd,
      JSON.stringify(formData),
      JSON.stringify(paymentBreakdown),
      generatedBy,
    );

  countWrite();
  return getTaxForm(result.lastInsertRowid);
}

/**
 * Fetch a single tax form by id.
 *
 * @param {number} id
 * @returns {object|null}
 */
export function getTaxForm(id) {
  return parseRow(
    db
      .prepare(
        `SELECT id, walletAddress, taxYear, formType, country,
                totalIncomeUsd, withheldUsd, formData, paymentBreakdown,
                status, generatedBy, createdAt, updatedAt
         FROM tax_forms WHERE id = ?`,
      )
      .get(id),
  );
}

/**
 * Fetch the most recent generated form for a wallet + year + type combo.
 *
 * @param {string} walletAddress
 * @param {string} taxYear
 * @param {string} formType
 * @returns {object|null}
 */
export function getLatestTaxForm(walletAddress, taxYear, formType) {
  return parseRow(
    db
      .prepare(
        `SELECT id, walletAddress, taxYear, formType, country,
                totalIncomeUsd, withheldUsd, formData, paymentBreakdown,
                status, generatedBy, createdAt, updatedAt
         FROM tax_forms
         WHERE walletAddress = ? AND taxYear = ? AND formType = ? AND status = 'generated'
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(walletAddress, String(taxYear), formType),
  );
}

/**
 * List tax forms with optional filters.
 *
 * @param {object}  filters
 * @param {string}  [filters.walletAddress]
 * @param {string}  [filters.taxYear]
 * @param {string}  [filters.formType]
 * @param {string}  [filters.country]
 * @param {string}  [filters.status]
 * @param {number}  limit
 * @param {number}  offset
 * @returns {object[]}
 */
export function listTaxForms(
  { walletAddress = null, taxYear = null, formType = null, country = null, status = null } = {},
  limit = 50,
  offset = 0,
) {
  let sql = `
    SELECT id, walletAddress, taxYear, formType, country,
           totalIncomeUsd, withheldUsd, formData, paymentBreakdown,
           status, generatedBy, createdAt, updatedAt
    FROM tax_forms WHERE 1=1`;
  const params = [];

  if (walletAddress) {
    sql += " AND walletAddress = ?";
    params.push(walletAddress);
  }
  if (taxYear) {
    sql += " AND taxYear = ?";
    params.push(String(taxYear));
  }
  if (formType) {
    sql += " AND formType = ?";
    params.push(formType);
  }
  if (country) {
    sql += " AND country = ?";
    params.push(country);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }

  sql += " ORDER BY createdAt DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  return db
    .prepare(sql)
    .all(...params)
    .map(parseRow);
}

/**
 * Count tax forms matching filters.
 *
 * @param {object} filters
 * @returns {number}
 */
export function countTaxForms(
  { walletAddress = null, taxYear = null, formType = null, country = null, status = null } = {},
) {
  let sql = "SELECT COUNT(*) as total FROM tax_forms WHERE 1=1";
  const params = [];

  if (walletAddress) {
    sql += " AND walletAddress = ?";
    params.push(walletAddress);
  }
  if (taxYear) {
    sql += " AND taxYear = ?";
    params.push(String(taxYear));
  }
  if (formType) {
    sql += " AND formType = ?";
    params.push(formType);
  }
  if (country) {
    sql += " AND country = ?";
    params.push(country);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }

  return db.prepare(sql).get(...params)?.total ?? 0;
}

/**
 * Void (supersede) a previously issued tax form.
 *
 * @param {number} id
 * @param {string} [reason]
 * @returns {void}
 */
export function voidTaxForm(id, reason = null) {
  db.prepare(
    `UPDATE tax_forms SET status = 'void', updatedAt = CURRENT_TIMESTAMP,
     formData = json_patch(COALESCE(formData, '{}'), json_object('voidReason', ?))
     WHERE id = ?`,
  ).run(reason ?? "voided", id);
  countWrite();
}

/**
 * Retrieve the aggregate income summary for a given tax year across all
 * collaborators — used by the export-tax-summary endpoint.
 *
 * @param {string} taxYear
 * @returns {object[]}
 */
export function getTaxYearSummary(taxYear) {
  return db
    .prepare(
      `SELECT walletAddress, country, formType,
              SUM(totalIncomeUsd) AS totalIncomeUsd,
              SUM(withheldUsd)    AS totalWithheldUsd,
              COUNT(*)            AS formCount
       FROM tax_forms
       WHERE taxYear = ? AND status = 'generated'
       GROUP BY walletAddress, country, formType
       ORDER BY totalIncomeUsd DESC`,
    )
    .all(String(taxYear));
}
