/**
 * DAO Treasury Manager Service (#1076)
 *
 * Structured treasury management for the DAO:
 *   - budget categories with percentage allocations
 *   - funding allocations per category/period
 *   - expense recording with an approval workflow for large expenses
 *   - IPFS-backed receipt management
 *   - budget-vs-actual dashboard, spend trends, forecasting, and reports
 *
 * The service is a thin business-logic layer over
 * backend/src/database/treasury-schema.js so the API routes stay declarative
 * and every rule is unit-testable without HTTP.
 */

import {
  initializeTreasuryTables,
  clearTreasuryTables,
  createCategoryRecord,
  getCategoryById,
  getCategoryByName,
  listCategories,
  updateCategoryRecord,
  createAllocationRecord,
  listAllocations,
  createExpenseRecord,
  getExpenseById,
  listExpenses as dbListExpenses,
  updateExpenseRecord,
  deleteExpenseRecord,
  createApprovalRecord,
  listApprovalsByExpense,
  createReceiptRecord,
  listReceiptsByExpense,
} from "../database/treasury-schema.js";

import logger from "../logger.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Canonical budget categories required by the DAO treasury spec. */
export const DEFAULT_CATEGORIES = ["development", "marketing", "operations", "reserves"];

/** Sensible starting allocation used when the treasury is first initialised. */
export const DEFAULT_ALLOCATION_PERCENTAGES = {
  development: 40,
  marketing: 25,
  operations: 20,
  reserves: 15,
};

/** Expenses strictly above this amount require explicit approval. */
export const DEFAULT_APPROVAL_THRESHOLD = 1000;

export const EXPENSE_STATUSES = ["pending", "approved", "rejected", "paid"];

export const PERCENTAGE_TOLERANCE = 0.01;

/**
 * Resolve the approval threshold. Read per call so tests can override the
 * environment variable without reloading the module.
 */
export function getApprovalThreshold() {
  const raw = process.env.TREASURY_APPROVAL_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_APPROVAL_THRESHOLD;
}

function normalizeCategoryName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/**
 * Resolve a category from an id or name reference.
 * @returns {Object|null}
 */
export function resolveCategory(ref) {
  if (ref == null) return null;
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
    return getCategoryById(Number(ref));
  }
  return getCategoryByName(normalizeCategoryName(ref));
}

/**
 * Ensure the canonical categories exist. No-op when categories are already
 * configured, so repeated calls are safe.
 */
export function ensureDefaultCategories() {
  initializeTreasuryTables();
  const existing = listCategories();
  if (existing.length > 0) return existing;

  const created = DEFAULT_CATEGORIES.map((name) =>
    createCategoryRecord({
      name,
      description: null,
      percentage: DEFAULT_ALLOCATION_PERCENTAGES[name] ?? 0,
    })
  );
  logger.info("Initialized default treasury budget categories", {
    categories: DEFAULT_CATEGORIES,
  });
  return created;
}

// ── Budget categories ────────────────────────────────────────────────────────

/**
 * Replace the treasury budget configuration.
 *
 * @param {Array<{name:string, description?:string, percentage:number}>} categories
 * @returns {Array} persisted categories
 */
export function setBudgetCategories(categories) {
  initializeTreasuryTables();

  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("categories must be a non-empty array");
  }

  const seen = new Set();
  const normalized = [];
  let total = 0;
  for (const category of categories) {
    const name = normalizeCategoryName(category?.name);
    if (!name) throw new Error("Each category requires a name");
    if (seen.has(name)) throw new Error(`Duplicate category name: ${name}`);
    seen.add(name);

    const percentage = Number(category.percentage);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new Error(`percentage for '${name}' must be a number between 0 and 100`);
    }
    normalized.push({ name, description: category.description ?? null, percentage });
    total += percentage;
  }

  if (Math.abs(total - 100) > PERCENTAGE_TOLERANCE) {
    throw new Error(`Category percentages must sum to 100 (got ${round(total)})`);
  }

  const result = [];
  for (const { name, description, percentage } of normalized) {
    const existing = getCategoryByName(name);
    if (existing) {
      result.push(updateCategoryRecord(existing.id, { description, percentage, isActive: true }));
    } else {
      result.push(createCategoryRecord({ name, description, percentage }));
    }
  }

  // Deactivate categories that were dropped from the configuration.
  for (const existing of listCategories()) {
    if (!seen.has(existing.name) && existing.isActive) {
      updateCategoryRecord(existing.id, { isActive: false });
    }
  }

  logger.info("Treasury budget categories updated", { categories: [...seen] });
  return listCategories();
}

export function getBudgetCategories() {
  initializeTreasuryTables();
  if (listCategories().length === 0) return ensureDefaultCategories();
  return listCategories();
}

// ── Allocations ──────────────────────────────────────────────────────────────

/**
 * Allocate funds to a budget category.
 */
/**
 * Allocate funds to the treasury.
 *
 * When a category is supplied the funds are earmarked for that category and
 * used as its budget directly. When no category is supplied the allocation
 * contributes to the general pool, which is split across categories by their
 * configured percentages.
 */
export function allocateBudget({
  category = null,
  categoryId = null,
  amount,
  period = "all-time",
  note = null,
  allocatedBy = "system",
}) {
  initializeTreasuryTables();
  ensureDefaultCategories();

  const hasCategory = category != null || categoryId != null;
  let resolved = null;
  if (hasCategory) {
    resolved = resolveCategory(categoryId ?? category);
    if (!resolved) throw new Error(`Unknown budget category: ${category ?? categoryId}`);
  }

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("amount must be a positive number");
  }

  const allocation = createAllocationRecord({
    categoryId: resolved ? resolved.id : null,
    amount: parsedAmount,
    period,
    note,
    allocatedBy,
  });

  logger.info("Treasury funds allocated", {
    category: resolved ? resolved.name : "treasury",
    amount: parsedAmount,
    period,
  });

  return { ...allocation, category: resolved ? resolved.name : "treasury" };
}

export function listBudgetAllocations(filters = {}) {
  initializeTreasuryTables();
  const allocations = listAllocations(filters);
  return allocations.map((allocation) => {
    const category = getCategoryById(allocation.categoryId);
    return { ...allocation, category: category ? category.name : null };
  });
}

// ── Expenses ─────────────────────────────────────────────────────────────────

/**
 * Record an expense. Expenses above the approval threshold (or explicitly
 * flagged) start in `pending`; everything else is auto-approved.
 */
export function recordExpense({
  category,
  categoryId,
  amount,
  description,
  date = null,
  requestedBy = "system",
  requiresApproval,
  receiptCid = null,
  receiptUrl = null,
  receiptName = null,
  receiptHash = null,
}) {
  initializeTreasuryTables();
  ensureDefaultCategories();

  const resolved = resolveCategory(categoryId ?? category);
  if (!resolved) throw new Error(`Unknown budget category: ${category ?? categoryId}`);

  const parsedAmount = Number(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("amount must be a positive number");
  }
  if (!description || typeof description !== "string" || description.trim() === "") {
    throw new Error("description is required");
  }

  const threshold = getApprovalThreshold();
  const needsApproval =
    typeof requiresApproval === "boolean" ? requiresApproval : parsedAmount > threshold;

  const expense = createExpenseRecord({
    categoryId: resolved.id,
    amount: parsedAmount,
    description: description.trim(),
    date: date || todayIso(),
    status: needsApproval ? "pending" : "approved",
    requestedBy,
    requiresApproval: needsApproval,
    approver: needsApproval ? null : "system:auto",
    approvalNotes: needsApproval ? null : `Auto-approved: amount <= threshold (${threshold})`,
    approvedAt: needsApproval ? null : new Date().toISOString(),
    receiptCid,
    receiptUrl,
    receiptName,
    receiptHash,
  });

  if (!needsApproval) {
    createApprovalRecord({
      expenseId: expense.id,
      approver: "system:auto",
      decision: "approved",
      notes: `Auto-approved: amount <= threshold (${threshold})`,
    });
  }

  logger.info("Treasury expense recorded", {
    expenseId: expense.id,
    category: resolved.name,
    amount: parsedAmount,
    status: expense.status,
  });

  return getExpenseDetails(expense.id);
}

export function getExpenseDetails(id) {
  const expense = getExpenseById(id);
  if (!expense) return null;

  const category = getCategoryById(expense.categoryId);
  return {
    ...expense,
    category: category ? category.name : null,
    approvals: listApprovalsByExpense(id),
    receipts: listReceiptsByExpense(id),
  };
}

export function listTreasuryExpenses(filters = {}) {
  initializeTreasuryTables();
  const expenses = dbListExpenses(filters);
  const categories = new Map(listCategories().map((c) => [c.id, c.name]));
  return expenses.map((expense) => ({
    ...expense,
    category: categories.get(expense.categoryId) ?? null,
  }));
}

/**
 * Approve a pending expense.
 */
export function approveExpense(id, { approver = "admin", notes = null } = {}) {
  const expense = getExpenseById(id);
  if (!expense) throw new Error(`Expense ${id} not found`);
  if (expense.status === "approved" || expense.status === "paid") {
    throw new Error(`Expense ${id} is already approved`);
  }
  if (expense.status === "rejected") {
    throw new Error(`Expense ${id} has already been rejected`);
  }

  const now = new Date().toISOString();
  updateExpenseRecord(id, { status: "approved", approver, approvalNotes: notes, approvedAt: now });
  createApprovalRecord({ expenseId: id, approver, decision: "approved", notes });

  logger.info("Treasury expense approved", { expenseId: id, approver });
  return getExpenseDetails(id);
}

/**
 * Reject a pending expense.
 */
export function rejectExpense(id, { approver = "admin", notes = null } = {}) {
  const expense = getExpenseById(id);
  if (!expense) throw new Error(`Expense ${id} not found`);
  if (expense.status === "rejected") {
    throw new Error(`Expense ${id} has already been rejected`);
  }
  if (expense.status === "paid") {
    throw new Error(`Expense ${id} has already been paid`);
  }

  const now = new Date().toISOString();
  updateExpenseRecord(id, { status: "rejected", approver, approvalNotes: notes, approvedAt: now });
  createApprovalRecord({ expenseId: id, approver, decision: "rejected", notes });

  logger.info("Treasury expense rejected", { expenseId: id, approver });
  return getExpenseDetails(id);
}

/**
 * Mark an approved expense as paid.
 */
export function markExpensePaid(id, { paidBy = "admin" } = {}) {
  const expense = getExpenseById(id);
  if (!expense) throw new Error(`Expense ${id} not found`);
  if (expense.status !== "approved") {
    throw new Error(`Expense ${id} must be approved before it can be paid`);
  }

  updateExpenseRecord(id, { status: "paid", approver: expense.approver ?? paidBy });
  logger.info("Treasury expense marked paid", { expenseId: id, paidBy });
  return getExpenseDetails(id);
}

export function getPendingExpenses() {
  return listTreasuryExpenses({ status: "pending" });
}

/**
 * Attach an IPFS receipt (or hosted URL) to an expense.
 */
export function attachExpenseReceipt(id, { ipfsCid = null, url = null, fileName = null, documentHash = null, uploadedBy = "system" } = {}) {
  const expense = getExpenseById(id);
  if (!expense) throw new Error(`Expense ${id} not found`);

  if (!ipfsCid && !url) {
    throw new Error("A receipt requires an ipfsCid or url");
  }
  if (ipfsCid && typeof ipfsCid !== "string") {
    throw new Error("ipfsCid must be a string");
  }

  const receipt = createReceiptRecord({
    expenseId: id,
    ipfsCid,
    url,
    fileName,
    documentHash,
    uploadedBy,
  });

  updateExpenseRecord(id, {
    receiptCid: ipfsCid ?? expense.receiptCid,
    receiptUrl: url ?? expense.receiptUrl,
    receiptName: fileName ?? expense.receiptName,
    receiptHash: documentHash ?? expense.receiptHash,
  });

  logger.info("Treasury expense receipt attached", {
    expenseId: id,
    ipfsCid: ipfsCid ?? null,
  });

  return receipt;
}

/** Remove an expense (used to correct mis-keyed entries). */
export function deleteTreasuryExpense(id) {
  const removed = deleteExpenseRecord(id);
  if (!removed) throw new Error(`Expense ${id} not found`);
  return true;
}

// ── Analytics: budget vs actual, trends, forecasts ───────────────────────────

/** Expenditure statuses that count as "actual" spending. */
const ACTUAL_STATUSES = ["approved", "paid"];

function sumExpenses(expenses, statuses = ACTUAL_STATUSES) {
  return expenses
    .filter((expense) => statuses.includes(expense.status))
    .reduce((total, expense) => total + Number(expense.amount || 0), 0);
}

/**
 * Budget for a category: explicit earmarked allocations plus the category's
 * configured percentage share of the general (non-earmarked) pool.
 */
function computeCategoryBudget(category, allocations, generalPool) {
  const explicit = allocations
    .filter((allocation) => allocation.categoryId === category.id)
    .reduce((total, allocation) => total + Number(allocation.amount || 0), 0);

  const percentageShare =
    generalPool > 0 ? (Number(category.percentage || 0) / 100) * generalPool : 0;
  const budget = explicit + percentageShare;

  let source = "none";
  if (explicit > 0 && percentageShare > 0) source = "mixed";
  else if (explicit > 0) source = "allocations";
  else if (percentageShare > 0) source = "percentage";

  return { budget, source };
}

/**
 * Budget vs actual for every active category.
 */
export function getBudgetVsActual({ period = null, from = null, to = null } = {}) {
  initializeTreasuryTables();
  const categories = getBudgetCategories().filter((category) => category.isActive);

  const allocations = listAllocations(period ? { period } : {});
  const totalPool = allocations.reduce((total, allocation) => total + Number(allocation.amount || 0), 0);
  const generalPool = allocations
    .filter((allocation) => allocation.categoryId == null)
    .reduce((total, allocation) => total + Number(allocation.amount || 0), 0);
  const expenses = dbListExpenses({ from, to });

  const rows = categories.map((category) => {
    const { budget, source } = computeCategoryBudget(category, allocations, generalPool);
    const categoryExpenses = expenses.filter((expense) => expense.categoryId === category.id);
    const actual = sumExpenses(categoryExpenses);
    const pending = sumExpenses(categoryExpenses, ["pending"]);
    const remaining = budget - actual;
    const utilization = budget > 0 ? round((actual / budget) * 100) : actual > 0 ? 100 : 0;

    return {
      categoryId: category.id,
      category: category.name,
      percentage: category.percentage,
      budget: round(budget),
      actual: round(actual),
      pending: round(pending),
      remaining: round(remaining),
      utilization,
      overBudget: actual > budget,
      budgetSource: source,
    };
  });

  const totalBudget = round(rows.reduce((total, row) => total + row.budget, 0));
  const totalActual = round(rows.reduce((total, row) => total + row.actual, 0));
  const totalPending = round(rows.reduce((total, row) => total + row.pending, 0));

  return {
    period: period ?? "all-time",
    from: from ?? null,
    to: to ?? null,
    totalPool: round(totalPool),
    totalBudget,
    totalActual,
    totalPending,
    remaining: round(totalBudget - totalActual),
    utilization: totalBudget > 0 ? round((totalActual / totalBudget) * 100) : 0,
    categories: rows,
  };
}

/**
 * Spending grouped by day/month within a range.
 */
export function getSpendingTrends({ category = null, categoryId = null, from = null, to = null, granularity = "month" } = {}) {
  initializeTreasuryTables();

  const resolved = category || categoryId ? resolveCategory(categoryId ?? category) : null;
  if ((category || categoryId) && !resolved) {
    throw new Error(`Unknown budget category: ${category ?? categoryId}`);
  }

  const expenses = dbListExpenses({
    categoryId: resolved ? resolved.id : null,
    from,
    to,
  }).filter((expense) => ACTUAL_STATUSES.includes(expense.status));

  const buckets = new Map();
  for (const expense of expenses) {
    const key =
      granularity === "day" ? String(expense.date).slice(0, 10) : String(expense.date).slice(0, 7);
    buckets.set(key, round((buckets.get(key) ?? 0) + Number(expense.amount || 0)));
  }

  const points = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, amount]) => ({ period: bucket, amount }));

  return {
    category: resolved ? resolved.name : null,
    granularity,
    from: from ?? null,
    to: to ?? null,
    points,
    total: round(points.reduce((total, point) => total + point.amount, 0)),
  };
}

/**
 * Forecast spend if the current run-rate continues.
 *
 * Uses the average daily spend over the lookback window (default 30 days) and
 * projects it `horizonDays` (default 30) into the future.
 */
export function forecastSpending({ category = null, categoryId = null, lookbackDays = 30, horizonDays = 30, asOf = null } = {}) {
  initializeTreasuryTables();

  const resolved = category || categoryId ? resolveCategory(categoryId ?? category) : null;
  if ((category || categoryId) && !resolved) {
    throw new Error(`Unknown budget category: ${category ?? categoryId}`);
  }

  const now = asOf ? new Date(asOf) : new Date();
  const since = new Date(now.getTime() - lookbackDays * 86_400_000);
  const from = since.toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);

  const expenses = dbListExpenses({
    categoryId: resolved ? resolved.id : null,
    from,
    to,
  }).filter((expense) => ACTUAL_STATUSES.includes(expense.status));

  const spent = expenses.reduce((total, expense) => total + Number(expense.amount || 0), 0);
  const dailyRate = lookbackDays > 0 ? spent / lookbackDays : 0;
  const forecast = dailyRate * horizonDays;

  const budgetVsActual = getBudgetVsActual();
  const matching = resolved
    ? budgetVsActual.categories.find((row) => row.categoryId === resolved.id)
    : null;

  const budget = resolved
    ? matching?.budget ?? 0
    : budgetVsActual.totalBudget;
  const actual = resolved ? matching?.actual ?? 0 : budgetVsActual.totalActual;

  return {
    category: resolved ? resolved.name : null,
    lookbackDays,
    horizonDays,
    windowFrom: from,
    windowTo: to,
    spentInWindow: round(spent),
    dailyRate: round(dailyRate),
    forecast: round(forecast),
    budget: round(budget),
    actual: round(actual),
    projectedTotal: round(actual + forecast),
    projectedOverBudget: actual + forecast > budget && budget > 0,
    confidence: expenses.length >= 5 ? "high" : expenses.length > 0 ? "medium" : "low",
    sampleSize: expenses.length,
  };
}

/**
 * Alert when a category is over budget or is forecast to exceed it.
 */
export function getBudgetAlerts() {
  const budgetVsActual = getBudgetVsActual();
  const forecast = forecastSpending();
  const alerts = [];

  for (const row of budgetVsActual.categories) {
    if (row.overBudget) {
      alerts.push({
        severity: "critical",
        type: "over_budget",
        category: row.category,
        message: `${row.category} is over budget by ${round(row.actual - row.budget)}`,
        budget: row.budget,
        actual: row.actual,
        overage: round(row.actual - row.budget),
      });
    } else if (row.budget > 0 && row.utilization >= 80) {
      alerts.push({
        severity: "warning",
        type: "budget_threshold",
        category: row.category,
        message: `${row.category} has used ${row.utilization}% of its budget`,
        budget: row.budget,
        actual: row.actual,
        utilization: row.utilization,
      });
    }
  }

  if (forecast.projectedOverBudget) {
    alerts.push({
      severity: "warning",
      type: "forecast_over_budget",
      category: forecast.category ?? "treasury",
      message: `At the current rate, treasury spending is projected to exceed budget by ${round(
        forecast.projectedTotal - forecast.budget
      )} within ${forecast.horizonDays} days`,
      projectedTotal: forecast.projectedTotal,
      budget: forecast.budget,
    });
  }

  return alerts;
}

/**
 * Full treasury dashboard payload: budget vs actual, trends, forecast, alerts.
 */
export function getTreasuryDashboard({ from = null, to = null, granularity = "month" } = {}) {
  initializeTreasuryTables();
  getBudgetCategories();

  const budgetVsActual = getBudgetVsActual({ from, to });
  const trends = getSpendingTrends({ from, to, granularity });
  const forecast = forecastSpending();
  const alerts = getBudgetAlerts();
  const pending = getPendingExpenses();

  return {
    generatedAt: new Date().toISOString(),
    budgetVsActual,
    trends,
    forecast,
    alerts,
    pendingApprovals: pending.length,
    pendingAmount: round(pending.reduce((total, expense) => total + Number(expense.amount || 0), 0)),
  };
}

// ── Reports ──────────────────────────────────────────────────────────────────

function csvEscape(value) {
  const str = value == null ? "" : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toCsv(rows, columns) {
  const header = columns.map((column) => csvEscape(column.label)).join(",");
  const body = rows
    .map((row) => columns.map((column) => csvEscape(row[column.key])).join(","))
    .join("\n");
  return body.length > 0 ? `${header}\n${body}` : header;
}

/**
 * Generate a treasury report as JSON or CSV.
 *
 * @param {Object} [options]
 * @param {"json"|"csv"} [options.format="json"]
 * @param {string|null} [options.from]
 * @param {string|null} [options.to]
 */
export function generateTreasuryReport({ format = "json", from = null, to = null } = {}) {
  initializeTreasuryTables();

  const budgetVsActual = getBudgetVsActual({ from, to });
  const forecast = forecastSpending();
  const alerts = getBudgetAlerts();
  const expenses = listTreasuryExpenses({ from, to });

  const report = {
    generatedAt: new Date().toISOString(),
    range: { from, to },
    summary: {
      totalBudget: budgetVsActual.totalBudget,
      totalActual: budgetVsActual.totalActual,
      totalPending: budgetVsActual.totalPending,
      remaining: budgetVsActual.remaining,
      utilization: budgetVsActual.utilization,
    },
    categories: budgetVsActual.categories,
    forecast,
    alerts,
    expenseCount: expenses.length,
  };

  if (format === "csv") {
    const categoryCsv = toCsv(budgetVsActual.categories, [
      { key: "category", label: "category" },
      { key: "percentage", label: "percentage" },
      { key: "budget", label: "budget" },
      { key: "actual", label: "actual" },
      { key: "pending", label: "pending" },
      { key: "remaining", label: "remaining" },
      { key: "utilization", label: "utilization" },
    ]);
    const expenseCsv = toCsv(expenses, [
      { key: "id", label: "id" },
      { key: "date", label: "date" },
      { key: "category", label: "category" },
      { key: "amount", label: "amount" },
      { key: "status", label: "status" },
      { key: "description", label: "description" },
      { key: "receiptCid", label: "receipt_ipfs_cid" },
    ]);
    return {
      format: "csv",
      generatedAt: report.generatedAt,
      range: report.range,
      files: {
        budgetVsActual: categoryCsv,
        expenses: expenseCsv,
      },
    };
  }

  report.expenses = expenses;
  return report;
}

export { clearTreasuryTables };
