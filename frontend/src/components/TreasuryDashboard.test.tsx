import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TreasuryDashboard } from "./TreasuryDashboard";

const dashboardPayload = {
  generatedAt: "2026-09-29T00:00:00.000Z",
  budgetVsActual: {
    period: "all-time",
    totalBudget: 10000,
    totalActual: 4000,
    totalPending: 5000,
    remaining: 6000,
    utilization: 40,
    categories: [
      {
        categoryId: 1,
        category: "development",
        percentage: 40,
        budget: 10000,
        actual: 4000,
        pending: 5000,
        remaining: 6000,
        utilization: 40,
        overBudget: false,
        budgetSource: "allocations",
      },
    ],
  },
  trends: { points: [{ period: "2026-09", amount: 4000 }], total: 4000, granularity: "month" },
  forecast: {
    category: null,
    lookbackDays: 30,
    horizonDays: 30,
    dailyRate: 133.33,
    forecast: 4000,
    budget: 10000,
    actual: 4000,
    projectedTotal: 8000,
    projectedOverBudget: false,
    confidence: "medium",
    sampleSize: 2,
  },
  alerts: [],
  pendingApprovals: 1,
  pendingAmount: 5000,
};

const expensesPayload = {
  expenses: [
    {
      id: 7,
      date: "2026-09-29",
      category: "development",
      amount: 5000,
      status: "pending",
      description: "Contractor invoice",
      requestedBy: "GABC",
      receiptCid: null,
    },
  ],
};

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/dashboard")
      ? dashboardPayload
      : url.includes("/expenses")
        ? expensesPayload
        : {};
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response);
  });
}

describe("TreasuryDashboard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders budget vs actual and totals from the treasury API", async () => {
    render(<TreasuryDashboard />);

    expect(screen.getByTestId("treasury-dashboard")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("budget-table")).toBeInTheDocument();
    });

    expect(screen.getByText("development")).toBeInTheDocument();
    expect(screen.getAllByText("40%").length).toBeGreaterThan(0);
    expect(screen.getByTestId("forecast-card")).toBeInTheDocument();
  });

  it("lists pending expenses and exposes approval actions", async () => {
    render(<TreasuryDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId("treasury-dashboard")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Approvals/ }));

    expect(screen.getByTestId("treasury-approvals")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("shows the record-expense form on the expenses tab", async () => {
    render(<TreasuryDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId("treasury-dashboard")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Expenses" }));

    expect(screen.getByTestId("treasury-expenses")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record expense" })).toBeInTheDocument();
    expect(screen.getByTestId("expenses-table")).toBeInTheDocument();
  });

  it("rejects nonnumeric, negative, zero and fractional-cent amounts before submission", async () => {
    render(<TreasuryDashboard />);
    fireEvent.click(await screen.findByRole("button", { name: "Expenses" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Expense" } });
    const amount = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Amount in XLM" });
    const submit = screen.getByRole("button", { name: "Record expense" });

    fireEvent.change(amount, { target: { value: "abc" } });
    expect(amount.value).toBe("");
    for (const invalid of ["-1", "0", "1.001"]) {
      fireEvent.change(amount, { target: { value: invalid } });
      expect(amount.validity.valid).toBe(false);
      fireEvent.click(submit);
      expect(amount).toHaveAccessibleDescription(/positive amount/i);
    }
    expect(fetch).toHaveBeenCalledTimes(2);

    fireEvent.change(amount, { target: { value: "1.25" } });
    expect(amount.validity.valid).toBe(true);
    expect(amount).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.click(submit);
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/v1/treasury/expenses", expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"amount":1.25'),
      }));
    });
  });
});