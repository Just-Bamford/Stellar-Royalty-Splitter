/**
 * DAO Treasury Management API Routes (#1076)
 *
 * REST surface for budget categories, allocations, expense tracking, the
 * approval workflow, IPFS receipts, the treasury dashboard, alerts, and
 * report exports.
 */

import { Router } from "express";
import {
  validate,
  treasurySetCategoriesSchema,
  treasuryAllocationSchema,
  treasuryExpenseSchema,
  treasuryApprovalSchema,
  treasuryReceiptSchema,
} from "../../validation.js";

import {
  setBudgetCategories,
  getBudgetCategories,
  allocateBudget,
  listBudgetAllocations,
  recordExpense,
  listTreasuryExpenses,
  getExpenseDetails,
  getPendingExpenses,
  approveExpense,
  rejectExpense,
  markExpensePaid,
  attachExpenseReceipt,
  deleteTreasuryExpense,
  getBudgetVsActual,
  getSpendingTrends,
  forecastSpending,
  getBudgetAlerts,
  getTreasuryDashboard,
  generateTreasuryReport,
} from "../../services/treasury-manager.js";

import { sendError } from "../../error-response.js";
import logger from "../../logger.js";

export const treasuryRouter = Router();

/** Return true when the message is a client (4xx) error we can surface. */
function isClientError(message) {
  return /not found|Unknown|already|must be|must sum|sum to 100|requires|is required|Duplicate|non-empty|Unknown budget|ipfsCid or url/i.test(
    String(message)
  );
}

function handleError(res, err, next, fallbackCode, fallbackMessage) {
  if (isClientError(err.message)) {
    const status = /not found/.test(err.message) ? 404 : 400;
    const code = status === 404 ? "not_found" : fallbackCode;
    return sendError(res, status, code, err.message);
  }
  logger.error("Treasury route error", { error: err.message });
  if (fallbackMessage) {
    return sendError(res, 400, fallbackCode, fallbackMessage);
  }
  return next(err);
}

// ── Budget categories ────────────────────────────────────────────────────────

/**
 * GET /api/v1/treasury/categories
 * List configured budget categories.
 */
treasuryRouter.get("/categories", (req, res, next) => {
  try {
    res.json({ categories: getBudgetCategories() });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/treasury/categories
 * Replace the budget configuration. Percentages must sum to 100.
 */
treasuryRouter.put("/categories", validate(treasurySetCategoriesSchema), (req, res, next) => {
  try {
    const categories = setBudgetCategories(req.body.categories);
    res.json({ categories });
  } catch (err) {
    handleError(res, err, next, "invalid_budget_categories");
  }
});

/**
 * POST /api/v1/treasury/categories
 * Alias of PUT for clients that cannot issue PUT.
 */
treasuryRouter.post("/categories", validate(treasurySetCategoriesSchema), (req, res, next) => {
  try {
    const categories = setBudgetCategories(req.body.categories);
    res.status(201).json({ categories });
  } catch (err) {
    handleError(res, err, next, "invalid_budget_categories");
  }
});

// ── Allocations ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/treasury/allocations
 */
treasuryRouter.get("/allocations", (req, res, next) => {
  try {
    const { category, categoryId, period } = req.query;
    res.json({
      allocations: listBudgetAllocations({
        categoryId: categoryId != null ? Number(categoryId) : null,
        period: period ?? null,
      }),
      filterCategory: category ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/treasury/allocations
 * Allocate funds to a budget category.
 */
treasuryRouter.post("/allocations", validate(treasuryAllocationSchema), (req, res, next) => {
  try {
    const allocatedBy = req.headers["x-wallet-address"] || "system";
    const allocation = allocateBudget({ ...req.body, allocatedBy });
    res.status(201).json(allocation);
  } catch (err) {
    handleError(res, err, next, "invalid_allocation");
  }
});

// ── Expenses ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/treasury/expenses
 */
treasuryRouter.get("/expenses", (req, res, next) => {
  try {
    const { category, categoryId, status, from, to } = req.query;
    const expenses = listTreasuryExpenses({
      categoryId: categoryId != null ? Number(categoryId) : null,
      status: status ?? null,
      from: from ?? null,
      to: to ?? null,
    });
    res.json({
      expenses,
      count: expenses.length,
      filterCategory: category ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/treasury/expenses/pending
 * List expenses awaiting approval.
 */
treasuryRouter.get("/expenses/pending", (req, res, next) => {
  try {
    const pending = getPendingExpenses();
    res.json({ expenses: pending, count: pending.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/treasury/expenses
 * Record a new expense. Amounts above the threshold enter `pending`.
 */
treasuryRouter.post("/expenses", validate(treasuryExpenseSchema), (req, res, next) => {
  try {
    const requestedBy = req.headers["x-wallet-address"] || "system";
    const expense = recordExpense({ ...req.body, requestedBy });
    res.status(201).json(expense);
  } catch (err) {
    handleError(res, err, next, "invalid_expense");
  }
});

/**
 * GET /api/v1/treasury/expenses/:id
 */
treasuryRouter.get("/expenses/:id", (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return sendError(res, 400, "invalid_id", "ID must be an integer");
    const expense = getExpenseDetails(id);
    if (!expense) return sendError(res, 404, "not_found", `Expense ${id} not found`);
    res.json(expense);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/treasury/expenses/:id
 */
treasuryRouter.delete("/expenses/:id", (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return sendError(res, 400, "invalid_id", "ID must be an integer");
    deleteTreasuryExpense(id);
    res.json({ success: true, message: `Expense ${id} deleted` });
  } catch (err) {
    handleError(res, err, next, "invalid_expense");
  }
});

/**
 * POST /api/v1/treasury/expenses/:id/approve
 */
treasuryRouter.post("/expenses/:id/approve", validate(treasuryApprovalSchema), (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return sendError(res, 400, "invalid_id", "ID must be an integer");
    const approver = req.headers["x-wallet-address"] || req.body.approver || "admin";
    const expense = approveExpense(id, { approver, notes: req.body.notes ?? null });
    res.json(expense);
  } catch (err) {
    handleError(res, err, next, "invalid_approval");
  }
});

/**
 * POST /api/v1/treasury/expenses/:id/reject
 */
treasuryRouter.post("/expenses/:id/reject", validate(treasuryApprovalSchema), (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return sendError(res, 400, "invalid_id", "ID must be an integer");
    const approver = req.headers["x-wallet-address"] || req.body.approver || "admin";
    const expense = rejectExpense(id, { approver, notes: req.body.notes ?? null });
    res.json(expense);
  } catch (err) {
    handleError(res, err, next, "invalid_approval");
  }
});

/**
 * POST /api/v1/treasury/expenses/:id/pay
 * Mark an approved expense as paid.
 */
treasuryRouter.post("/expenses/:id/pay", (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return sendError(res, 400, "invalid_id", "ID must be an integer");
    const paidBy = req.headers["x-wallet-address"] || "admin";
    const expense = markExpensePaid(id, { paidBy });
    res.json(expense);
  } catch (err) {
    handleError(res, err, next, "invalid_expense");
  }
});

/**
 * POST /api/v1/treasury/expenses/:id/receipt
 * Attach an IPFS receipt (or hosted URL) to an expense.
 */
treasuryRouter.post("/expenses/:id/receipt", validate(treasuryReceiptSchema), (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return sendError(res, 400, "invalid_id", "ID must be an integer");
    const uploadedBy = req.headers["x-wallet-address"] || "system";
    const receipt = attachExpenseReceipt(id, { ...req.body, uploadedBy });
    res.status(201).json(receipt);
  } catch (err) {
    handleError(res, err, next, "invalid_receipt");
  }
});

// ── Analytics & reports ──────────────────────────────────────────────────────

/**
 * GET /api/v1/treasury/dashboard
 * Budget vs actual, trends, forecast, alerts, and pending approvals.
 */
treasuryRouter.get("/dashboard", (req, res, next) => {
  try {
    const { from, to, granularity } = req.query;
    res.json(
      getTreasuryDashboard({
        from: from ?? null,
        to: to ?? null,
        granularity: granularity === "day" ? "day" : "month",
      })
    );
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/treasury/budget
 * Budget vs actual only.
 */
treasuryRouter.get("/budget", (req, res, next) => {
  try {
    const { from, to, period } = req.query;
    res.json(getBudgetVsActual({ from: from ?? null, to: to ?? null, period: period ?? null }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/treasury/trends
 */
treasuryRouter.get("/trends", (req, res, next) => {
  try {
    const { category, categoryId, from, to, granularity } = req.query;
    res.json(
      getSpendingTrends({
        category: category ?? null,
        categoryId: categoryId != null ? Number(categoryId) : null,
        from: from ?? null,
        to: to ?? null,
        granularity: granularity === "day" ? "day" : "month",
      })
    );
  } catch (err) {
    handleError(res, err, next, "invalid_trend_query");
  }
});

/**
 * GET /api/v1/treasury/forecast
 */
treasuryRouter.get("/forecast", (req, res, next) => {
  try {
    const { category, categoryId, lookbackDays, horizonDays } = req.query;
    res.json(
      forecastSpending({
        category: category ?? null,
        categoryId: categoryId != null ? Number(categoryId) : null,
        lookbackDays: lookbackDays != null ? Number(lookbackDays) : undefined,
        horizonDays: horizonDays != null ? Number(horizonDays) : undefined,
      })
    );
  } catch (err) {
    handleError(res, err, next, "invalid_forecast_query");
  }
});

/**
 * GET /api/v1/treasury/alerts
 */
treasuryRouter.get("/alerts", (req, res, next) => {
  try {
    const alerts = getBudgetAlerts();
    res.json({ alerts, count: alerts.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/treasury/reports
 * Export a treasury report. `format=csv|json` (default json).
 */
treasuryRouter.get("/reports", (req, res, next) => {
  try {
    const { format, from, to } = req.query;
    const report = generateTreasuryReport({
      format: format === "csv" ? "csv" : "json",
      from: from ?? null,
      to: to ?? null,
    });

    if (report.format === "csv") {
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", 'attachment; filename="treasury-report.csv"');
      return res.send(report.files.budgetVsActual);
    }

    res.json(report);
  } catch (err) {
    next(err);
  }
});
