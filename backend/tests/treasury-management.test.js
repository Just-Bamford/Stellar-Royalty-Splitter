import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

import { initializeTreasuryTables, clearTreasuryTables } from "../src/database/treasury-schema.js";

import {
  DEFAULT_CATEGORIES,
  getApprovalThreshold,
  ensureDefaultCategories,
  setBudgetCategories,
  getBudgetCategories,
  allocateBudget,
  listBudgetAllocations,
  recordExpense,
  getExpenseDetails,
  listTreasuryExpenses,
  getPendingExpenses,
  approveExpense,
  rejectExpense,
  markExpensePaid,
  attachExpenseReceipt,
  getBudgetVsActual,
  getSpendingTrends,
  forecastSpending,
  getBudgetAlerts,
  getTreasuryDashboard,
  generateTreasuryReport,
} from "../src/services/treasury-manager.js";

import { treasuryRouter } from "../src/routes/treasury/index.js";

const app = express();
app.use(express.json());
app.use("/api/v1/treasury", treasuryRouter);

const today = () => new Date().toISOString().slice(0, 10);

describe("DAO Treasury Management (#1076)", () => {
  beforeEach(() => {
    initializeTreasuryTables();
    clearTreasuryTables();
  });

  describe("Budget categories", () => {
    test("seeds the canonical categories on first use", () => {
      const categories = ensureDefaultCategories();
      expect(categories.map((c) => c.name).sort()).toEqual([...DEFAULT_CATEGORIES].sort());

      const total = categories.reduce((sum, c) => sum + c.percentage, 0);
      expect(total).toBeCloseTo(100, 5);
    });

    test("getBudgetCategories auto-seeds when empty", () => {
      const categories = getBudgetCategories();
      expect(categories).toHaveLength(4);
    });

    test("rejects allocations that do not sum to 100%", () => {
      expect(() =>
        setBudgetCategories([
          { name: "development", percentage: 50 },
          { name: "marketing", percentage: 30 },
        ])
      ).toThrow(/sum to 100/);
    });

    test("replaces the budget configuration and deactivates dropped categories", () => {
      setBudgetCategories(DEFAULT_CATEGORIES.map((name, index) => ({ name, percentage: index === 0 ? 70 : 10 })));

      const updated = setBudgetCategories([
        { name: "development", percentage: 60 },
        { name: "marketing", percentage: 40 },
      ]);

      const active = updated.filter((c) => c.isActive);
      expect(active.map((c) => c.name).sort()).toEqual(["development", "marketing"]);

      const operations = updated.find((c) => c.name === "operations");
      expect(operations.isActive).toBe(false);
    });
  });

  describe("Allocations", () => {
    test("allocates funds to a named category", () => {
      const allocation = allocateBudget({ category: "development", amount: 10000, period: "2026-Q3" });
      expect(allocation.category).toBe("development");
      expect(allocation.amount).toBe(10000);
      expect(allocation.period).toBe("2026-Q3");
    });

    test("rejects unknown categories and non-positive amounts", () => {
      expect(() => allocateBudget({ category: "nope", amount: 100 })).toThrow(/Unknown/);
      expect(() => allocateBudget({ category: "development", amount: 0 })).toThrow(/positive/);
    });

    test("lists allocations with resolved category names", () => {
      allocateBudget({ category: "development", amount: 5000 });
      allocateBudget({ category: "marketing", amount: 2500 });

      const allocations = listBudgetAllocations();
      expect(allocations).toHaveLength(2);
      expect(allocations.map((a) => a.category).sort()).toEqual(["development", "marketing"]);
    });
  });

  describe("Expense tracking and approval workflow", () => {
    test("auto-approves expenses at or below the threshold", () => {
      const threshold = getApprovalThreshold();
      const expense = recordExpense({
        category: "development",
        amount: threshold,
        description: "Small tooling purchase",
      });

      expect(expense.status).toBe("approved");
      expect(expense.requiresApproval).toBe(false);
      expect(expense.approvals).toHaveLength(1);
      expect(expense.approvals[0].decision).toBe("approved");
    });

    test("flags expenses above the threshold as pending approval", () => {
      const expense = recordExpense({
        category: "marketing",
        amount: getApprovalThreshold() + 1,
        description: "Sponsorship deal",
      });

      expect(expense.status).toBe("pending");
      expect(expense.requiresApproval).toBe(true);
      expect(getPendingExpenses()).toHaveLength(1);
    });

    test("allows forcing the approval requirement", () => {
      const expense = recordExpense({
        category: "operations",
        amount: 10,
        description: "Requires sign-off anyway",
        requiresApproval: true,
      });
      expect(expense.status).toBe("pending");
    });

    test("approve moves a pending expense to approved and records the decision", () => {
      const expense = recordExpense({
        category: "marketing",
        amount: 5000,
        description: "Conference",
      });

      const approved = approveExpense(expense.id, { approver: "GABC", notes: "ok" });
      expect(approved.status).toBe("approved");
      expect(approved.approver).toBe("GABC");
      expect(approved.approvals.some((a) => a.decision === "approved")).toBe(true);
      expect(getPendingExpenses()).toHaveLength(0);
    });

    test("reject moves a pending expense to rejected", () => {
      const expense = recordExpense({ category: "reserves", amount: 9000, description: "Unbudgeted" });
      const rejected = rejectExpense(expense.id, { approver: "GDEF", notes: "not now" });
      expect(rejected.status).toBe("rejected");
    });

    test("cannot approve an already approved or rejected expense", () => {
      const expense = recordExpense({ category: "marketing", amount: 5000, description: "x" });
      approveExpense(expense.id, { approver: "A" });
      expect(() => approveExpense(expense.id, { approver: "B" })).toThrow(/already approved/);

      const second = recordExpense({ category: "marketing", amount: 5000, description: "y" });
      rejectExpense(second.id, { approver: "A" });
      expect(() => approveExpense(second.id, { approver: "B" })).toThrow(/already been rejected/);
    });

    test("marks approved expenses as paid", () => {
      const expense = recordExpense({ category: "development", amount: 2000, description: "contractor" });
      approveExpense(expense.id, { approver: "A" });
      const paid = markExpensePaid(expense.id, { paidBy: "A" });
      expect(paid.status).toBe("paid");
    });

    test("cannot pay an expense that is still pending", () => {
      const expense = recordExpense({ category: "development", amount: 5000, description: "contractor" });
      expect(() => markExpensePaid(expense.id)).toThrow(/must be approved/);
    });
  });

  describe("Receipts", () => {
    test("attaches an IPFS receipt and mirrors it on the expense", () => {
      const expense = recordExpense({ category: "operations", amount: 500, description: "hosting" });
      const receipt = attachExpenseReceipt(expense.id, {
        ipfsCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        fileName: "invoice.pdf",
      });

      expect(receipt.ipfsCid).toBeTruthy();
      const details = getExpenseDetails(expense.id);
      expect(details.receiptCid).toBe(receipt.ipfsCid);
      expect(details.receipts).toHaveLength(1);
    });

    test("requires either an ipfsCid or url", () => {
      const expense = recordExpense({ category: "operations", amount: 500, description: "hosting" });
      expect(() => attachExpenseReceipt(expense.id, {})).toThrow(/ipfsCid or url/);
    });
  });

  describe("Budget vs actual", () => {
    test("uses explicit allocations as the category budget", () => {
      allocateBudget({ category: "development", amount: 10000 });
      allocateBudget({ category: "marketing", amount: 5000 });

      recordExpense({ category: "development", amount: 3000, description: "dev", requiresApproval: false });
      recordExpense({ category: "marketing", amount: 7000, description: "ads", requiresApproval: false });

      const report = getBudgetVsActual();
      const dev = report.categories.find((c) => c.category === "development");
      const mkt = report.categories.find((c) => c.category === "marketing");

      expect(dev.budget).toBe(10000);
      expect(dev.actual).toBe(3000);
      expect(dev.remaining).toBe(7000);
      expect(mkt.overBudget).toBe(true);
      expect(mkt.remaining).toBe(-2000);
    });

    test("splits a general-pool allocation by category percentage", () => {
      setBudgetCategories([
        { name: "development", percentage: 50 },
        { name: "marketing", percentage: 50 },
      ]);
      // No category => general pool, split 50/50 across active categories.
      allocateBudget({ amount: 20000 });

      const report = getBudgetVsActual();
      const mkt = report.categories.find((c) => c.category === "marketing");
      const dev = report.categories.find((c) => c.category === "development");
      expect(mkt.budget).toBe(10000);
      expect(dev.budget).toBe(10000);
      expect(mkt.budgetSource).toBe("percentage");
      expect(report.totalBudget).toBe(20000);
    });

    test("excludes pending expenses from actuals but reports them separately", () => {
      allocateBudget({ category: "development", amount: 10000 });
      recordExpense({ category: "development", amount: 1000, description: "approved" });
      recordExpense({ category: "development", amount: 9000, description: "pending" });

      const report = getBudgetVsActual();
      const dev = report.categories.find((c) => c.category === "development");
      expect(dev.actual).toBe(1000);
      expect(dev.pending).toBe(9000);
    });
  });

  describe("Trends and forecasting", () => {
    test("buckets spending by month", () => {
      allocateBudget({ category: "development", amount: 100000 });
      recordExpense({ category: "development", amount: 100, description: "a", date: "2026-01-05" });
      recordExpense({ category: "development", amount: 200, description: "b", date: "2026-01-20" });
      recordExpense({ category: "development", amount: 50, description: "c", date: "2026-02-01" });

      const trends = getSpendingTrends({ granularity: "month" });
      expect(trends.points).toEqual([
        { period: "2026-01", amount: 300 },
        { period: "2026-02", amount: 50 },
      ]);
      expect(trends.total).toBe(350);
    });

    test("forecasts the run-rate from recent approved spend", () => {
      allocateBudget({ category: "operations", amount: 100000 });
      recordExpense({ category: "operations", amount: 300, description: "daily", date: today() });

      const forecast = forecastSpending({ lookbackDays: 30, horizonDays: 30 });
      // 300 spent over the 30-day window => 10/day => 300 forecast over 30 days
      expect(forecast.dailyRate).toBeCloseTo(10, 5);
      expect(forecast.forecast).toBeCloseTo(300, 5);
      expect(forecast.projectedTotal).toBeCloseTo(600, 5);
      expect(forecast.sampleSize).toBe(1);
      expect(forecast.confidence).toBe("medium");
    });

    test("flags a projected overrun in alerts", () => {
      allocateBudget({ category: "operations", amount: 400 });
      recordExpense({ category: "operations", amount: 300, description: "big", date: today() });

      const alerts = getBudgetAlerts();
      expect(alerts.some((a) => a.type === "forecast_over_budget")).toBe(true);
    });
  });

  describe("Dashboard and reports", () => {
    test("aggregates dashboard data", () => {
      allocateBudget({ category: "development", amount: 10000 });
      recordExpense({ category: "development", amount: 1000, description: "ok" });
      recordExpense({ category: "development", amount: 6000, description: "needs approval" });

      const dashboard = getTreasuryDashboard();
      expect(dashboard.budgetVsActual.totalBudget).toBe(10000);
      expect(dashboard.budgetVsActual.totalActual).toBe(1000);
      expect(dashboard.pendingApprovals).toBe(1);
      expect(dashboard.pendingAmount).toBe(6000);
      expect(Array.isArray(dashboard.trends.points)).toBe(true);
      expect(dashboard.forecast).toBeDefined();
      expect(dashboard.generatedAt).toBeTruthy();
    });

    test("generates JSON and CSV reports", () => {
      allocateBudget({ category: "development", amount: 10000 });
      recordExpense({ category: "development", amount: 1000, description: "ok" });

      const json = generateTreasuryReport({ format: "json" });
      expect(json.summary.totalBudget).toBe(10000);
      expect(json.expenses).toHaveLength(1);

      const csv = generateTreasuryReport({ format: "csv" });
      expect(csv.format).toBe("csv");
      expect(csv.files.budgetVsActual).toContain("category");
      expect(csv.files.expenses).toContain("description");
    });
  });

  describe("HTTP routes", () => {
    test("PUT /categories rejects percentages that do not total 100", async () => {
      const res = await request(app)
        .put("/api/v1/treasury/categories")
        .send({ categories: [{ name: "development", percentage: 80 }] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("validation_failed");
    });

    test("POST /allocations then GET /budget", async () => {
      const allocRes = await request(app)
        .post("/api/v1/treasury/allocations")
        .send({ category: "development", amount: 5000 });
      expect(allocRes.status).toBe(201);
      expect(allocRes.body.category).toBe("development");

      const budgetRes = await request(app).get("/api/v1/treasury/budget");
      expect(budgetRes.status).toBe(200);
      expect(budgetRes.body.categories.find((c) => c.category === "development").budget).toBe(5000);
    });

    test("full expense approval flow over HTTP", async () => {
      const createRes = await request(app)
        .post("/api/v1/treasury/expenses")
        .send({ category: "marketing", amount: 5000, description: "Big campaign" });
      expect(createRes.status).toBe(201);
      expect(createRes.body.status).toBe("pending");

      const id = createRes.body.id;
      const approveRes = await request(app)
        .post(`/api/v1/treasury/expenses/${id}/approve`)
        .set("x-wallet-address", "GABC")
        .send({ notes: "approved" });
      expect(approveRes.status).toBe(200);
      expect(approveRes.body.status).toBe("approved");

      const dashboardRes = await request(app).get("/api/v1/treasury/dashboard");
      expect(dashboardRes.status).toBe(200);
      expect(dashboardRes.body.pendingApprovals).toBe(0);
    });

    test("GET /expenses/pending lists pending expenses", async () => {
      await request(app)
        .post("/api/v1/treasury/expenses")
        .send({ category: "operations", amount: 3000, description: "audit" });

      const res = await request(app).get("/api/v1/treasury/expenses/pending");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
    });

    test("POST /expenses/:id/receipt stores an IPFS receipt", async () => {
      const createRes = await request(app)
        .post("/api/v1/treasury/expenses")
        .send({ category: "operations", amount: 100, description: "coffee" });
      const id = createRes.body.id;

      const res = await request(app)
        .post(`/api/v1/treasury/expenses/${id}/receipt`)
        .send({ ipfsCid: "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy" });
      expect(res.status).toBe(201);
      expect(res.body.ipfsCid).toBeTruthy();
    });

    test("GET /reports?format=csv returns CSV content type", async () => {
      const res = await request(app).get("/api/v1/treasury/reports?format=csv");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
    });

    test("GET /expenses/:id returns 404 for unknown expense", async () => {
      const res = await request(app).get("/api/v1/treasury/expenses/99999");
      expect(res.status).toBe(404);
    });
  });
});
