import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { api } from "../api";
import type {
  TreasuryDashboardData,
  ExpenseRow,
} from "../api";
import "./TreasuryDashboard.css";

/**
 * DAO Treasury Management dashboard (#1076).
 *
 * Consumes the backend treasury API:
 *   GET  /api/v1/treasury/dashboard
 *   GET  /api/v1/treasury/expenses
 *   POST /api/v1/treasury/expenses
 *   POST /api/v1/treasury/expenses/:id/approve|reject
 *   GET  /api/v1/treasury/reports?format=csv
 */

type Tab = "overview" | "expenses" | "approvals" | "reports";

const AMOUNT_ERROR = "Enter a positive amount with at most two decimal places.";
const CATEGORY_OPTIONS = ["development", "marketing", "operations", "reserves"];

function formatAmount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

export function TreasuryDashboard() {
  const [data, setData] = useState<TreasuryDashboardData | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyExpenseId, setBusyExpenseId] = useState<number | null>(null);

  // New expense form
  const [category, setCategory] = useState("development");
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const amountErrorId = useId();
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [receiptCid, setReceiptCid] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // `load` intentionally has an empty dependency array. The treasury is a single
  // DAO-wide ledger: GET /api/v1/treasury/dashboard and /expenses are not scoped
  // to a contract, and this component takes no props and passes no filters, so
  // nothing it reads can change between renders. Keeping `load` stable means the
  // mount effect below runs exactly once, and the refresh button and mutations
  // (create/approve/reject) re-run it explicitly.
  //
  // If you add a prop or state that changes the request (e.g. `contractId`,
  // `period`, or the backend's `from`/`to`/`granularity` query params), pass it
  // in the URL and add it to this dependency array so the data is refetched.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dashboard, expenseList] = await Promise.all([
        api.getTreasuryDashboard(),
        api.getTreasuryExpenses(),
      ]);
      setData(dashboard);
      setExpenses(expenseList.expenses);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load treasury data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingExpenses = useMemo(
    () => expenses.filter((expense) => expense.status === "pending"),
    [expenses]
  );

  const handleRecordExpense = async (event: FormEvent) => {
    event.preventDefault();
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setAmountError(AMOUNT_ERROR);
      return;
    }
    setAmountError(null);
    setSubmitting(true);
    setError(null);
    try {
      await api.recordTreasuryExpense({
        category,
        amount: parsedAmount,
        description,
        date,
        receiptCid: receiptCid || undefined,
      });
      setAmount("");
      setDescription("");
      setReceiptCid("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record expense");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecision = async (id: number, decision: "approve" | "reject") => {
    setBusyExpenseId(id);
    setError(null);
    try {
      if (decision === "approve") {
        await api.approveTreasuryExpense(id);
      } else {
        await api.rejectTreasuryExpense(id);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update expense");
    } finally {
      setBusyExpenseId(null);
    }
  };

  const downloadReport = () => {
    window.open("/api/v1/treasury/reports?format=csv", "_blank", "noopener");
  };

  if (loading && !data) {
    return (
      <div className="treasury-dashboard" data-testid="treasury-dashboard">
        <p className="treasury-muted">Loading treasury data…</p>
      </div>
    );
  }

  return (
    <div className="treasury-dashboard" data-testid="treasury-dashboard">
      <header className="treasury-header">
        <div>
          <h2>🏦 DAO Treasury</h2>
          <p className="treasury-muted">
            Budget allocations, expenses, approvals, trends and forecasts.
          </p>
        </div>
        <div className="treasury-header-actions">
          <button type="button" className="treasury-btn" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className="treasury-btn" onClick={downloadReport}>
            Export CSV
          </button>
        </div>
      </header>

      {error && (
        <div className="treasury-error" role="alert" data-testid="treasury-error">
          {error}
        </div>
      )}

      <nav className="treasury-tabs" aria-label="Treasury sections">
        {(["overview", "expenses", "approvals", "reports"] as Tab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`treasury-tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "approvals" && pendingExpenses.length > 0
              ? `Approvals (${pendingExpenses.length})`
              : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>

      {data && activeTab === "overview" && (
        <section data-testid="treasury-overview">
          <div className="treasury-summary-grid">
            <div className="treasury-card">
              <span className="treasury-card-label">Total Budget</span>
              <span className="treasury-card-value">{formatAmount(data.budgetVsActual.totalBudget)}</span>
            </div>
            <div className="treasury-card">
              <span className="treasury-card-label">Spent</span>
              <span className="treasury-card-value">{formatAmount(data.budgetVsActual.totalActual)}</span>
            </div>
            <div className="treasury-card">
              <span className="treasury-card-label">Remaining</span>
              <span
                className={`treasury-card-value ${
                  data.budgetVsActual.remaining < 0 ? "negative" : ""
                }`}
              >
                {formatAmount(data.budgetVsActual.remaining)}
              </span>
            </div>
            <div className="treasury-card">
              <span className="treasury-card-label">Utilization</span>
              <span className="treasury-card-value">{data.budgetVsActual.utilization}%</span>
            </div>
          </div>

          <h3>Budget vs Actual</h3>
          <table className="treasury-table" data-testid="budget-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>%</th>
                <th>Budget</th>
                <th>Actual</th>
                <th>Pending</th>
                <th>Remaining</th>
                <th>Utilization</th>
              </tr>
            </thead>
            <tbody>
              {data.budgetVsActual.categories.map((row) => (
                <tr key={row.categoryId} className={row.overBudget ? "over-budget" : ""}>
                  <td>{row.category}</td>
                  <td>{row.percentage}%</td>
                  <td>{formatAmount(row.budget)}</td>
                  <td>{formatAmount(row.actual)}</td>
                  <td>{formatAmount(row.pending)}</td>
                  <td className={row.remaining < 0 ? "negative" : ""}>
                    {formatAmount(row.remaining)}
                  </td>
                  <td>
                    <div className="treasury-progress" title={`${row.utilization}%`}>
                      <div
                        className={`treasury-progress-bar ${
                          row.utilization >= 100 ? "danger" : row.utilization >= 80 ? "warning" : ""
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, row.utilization))}%` }}
                      />
                    </div>
                    <span className="treasury-progress-label">{row.utilization}%</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="treasury-two-column">
            <div>
              <h3>Spending Trends</h3>
              {data.trends.points.length === 0 ? (
                <p className="treasury-muted">No spending recorded yet.</p>
              ) : (
                <table className="treasury-table" data-testid="trends-table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trends.points.map((point) => (
                      <tr key={point.period}>
                        <td>{point.period}</td>
                        <td>{formatAmount(point.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <h3>Forecast</h3>
              <div className="treasury-forecast" data-testid="forecast-card">
                <p>
                  At the current rate of{" "}
                  <strong>{formatAmount(data.forecast.dailyRate)}</strong>/day, the next{" "}
                  {data.forecast.horizonDays} days are projected to cost{" "}
                  <strong>{formatAmount(data.forecast.forecast)}</strong>.
                </p>
                <p>
                  Projected total: <strong>{formatAmount(data.forecast.projectedTotal)}</strong>{" "}
                  against a budget of <strong>{formatAmount(data.forecast.budget)}</strong>.
                </p>
                <p className="treasury-muted">Confidence: {data.forecast.confidence}</p>
                {data.forecast.projectedOverBudget && (
                  <p className="negative">Projected to exceed budget.</p>
                )}
              </div>
            </div>
          </div>

          <h3>Alerts</h3>
          {data.alerts.length === 0 ? (
            <p className="treasury-muted">No budget alerts. 🎉</p>
          ) : (
            <ul className="treasury-alerts" data-testid="alert-list">
              {data.alerts.map((alert, index) => (
                <li key={`${alert.type}-${alert.category}-${index}`} className={alert.severity}>
                  <strong>{alert.category}</strong>: {alert.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeTab === "expenses" && (
        <section data-testid="treasury-expenses">
          <h3>Record Expense</h3>
          <form className="treasury-form" onSubmit={handleRecordExpense}>
            <label>
              Category
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Amount
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAmountError(null);
                }}
                onInvalid={() => setAmountError(AMOUNT_ERROR)}
                placeholder="0.00"
                aria-label="Amount in XLM"
                aria-invalid={Boolean(amountError)}
                aria-describedby={amountError ? amountErrorId : undefined}
                required
              />
              {amountError && (
                <span id={amountErrorId} className="treasury-error" role="alert">
                  {amountError}
                </span>
              )}
            </label>
            <label>
              Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="treasury-form-wide">
              Description
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </label>
            <label className="treasury-form-wide">
              Receipt IPFS CID (optional)
              <input
                type="text"
                value={receiptCid}
                onChange={(e) => setReceiptCid(e.target.value)}
                placeholder="bafy…"
              />
            </label>
            <button type="submit" className="treasury-btn primary" disabled={submitting}>
              {submitting ? "Saving…" : "Record expense"}
            </button>
          </form>

          <h3>All Expenses</h3>
          <table className="treasury-table" data-testid="expenses-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Category</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Description</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 ? (
                <tr>
                  <td colSpan={6} className="treasury-muted">
                    No expenses recorded.
                  </td>
                </tr>
              ) : (
                expenses.map((expense) => (
                  <tr key={expense.id}>
                    <td>{expense.date}</td>
                    <td>{expense.category}</td>
                    <td>{formatAmount(expense.amount)}</td>
                    <td>
                      <span className={`treasury-status ${expense.status}`}>{expense.status}</span>
                    </td>
                    <td>{expense.description}</td>
                    <td>
                      {expense.receiptCid ? (
                        <span title={expense.receiptCid}>📎 IPFS</span>
                      ) : (
                        <span className="treasury-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      )}

      {activeTab === "approvals" && (
        <section data-testid="treasury-approvals">
          <h3>Pending Approval ({pendingExpenses.length})</h3>
          {pendingExpenses.length === 0 ? (
            <p className="treasury-muted">Nothing awaiting approval.</p>
          ) : (
            <table className="treasury-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Amount</th>
                  <th>Description</th>
                  <th>Requested By</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingExpenses.map((expense) => (
                  <tr key={expense.id}>
                    <td>{expense.date}</td>
                    <td>{expense.category}</td>
                    <td>{formatAmount(expense.amount)}</td>
                    <td>{expense.description}</td>
                    <td>{expense.requestedBy ?? "—"}</td>
                    <td className="treasury-actions">
                      <button
                        type="button"
                        className="treasury-btn approve"
                        disabled={busyExpenseId === expense.id}
                        onClick={() => void handleDecision(expense.id, "approve")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="treasury-btn reject"
                        disabled={busyExpenseId === expense.id}
                        onClick={() => void handleDecision(expense.id, "reject")}
                      >
                        Reject
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeTab === "reports" && data && (
        <section data-testid="treasury-reports">
          <h3>Reports</h3>
          <p className="treasury-muted">
            Generated at {new Date(data.generatedAt).toLocaleString()}.
          </p>
          <pre className="treasury-report" data-testid="report-summary">
            {JSON.stringify(
              {
                totalBudget: data.budgetVsActual.totalBudget,
                totalActual: data.budgetVsActual.totalActual,
                totalPending: data.budgetVsActual.totalPending,
                remaining: data.budgetVsActual.remaining,
                utilization: data.budgetVsActual.utilization,
                forecast: {
                  dailyRate: data.forecast.dailyRate,
                  forecast: data.forecast.forecast,
                  projectedOverBudget: data.forecast.projectedOverBudget,
                },
              },
              null,
              2
            )}
          </pre>
          <button type="button" className="treasury-btn primary" onClick={downloadReport}>
            Download CSV report
          </button>
        </section>
      )}
    </div>
  );
}

export default TreasuryDashboard;
