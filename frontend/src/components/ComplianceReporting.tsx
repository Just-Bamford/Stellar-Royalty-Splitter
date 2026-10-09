import { useState, useEffect } from "react";
import { api } from "../api";

export function ComplianceReporting() {
  const [activeTab, setActiveTab] = useState<"generate" | "audit" | "verify">("generate");
  const [reportType, setReportType] = useState<
    "form-8949" | "turbotax" | "csv" | "ledger" | "sec-form-d" | "finra-trace" | "export"
  >("csv");
  const [walletAddress, setWalletAddress] = useState("");
  const [taxYear, setTaxYear] = useState(new Date().getFullYear() - 1);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [costBasis, setCostBasis] = useState(0);
  const [shortTerm, setShortTerm] = useState(true);
  const [country, setCountry] = useState("");
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [download, setDownload] = useState(false);
  const [distributions, setDistributions] = useState<
    Array<{ amountXlm: number; timestamp: string; txHash: string }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    reportId?: number;
    verified?: boolean;
    calculatedTotal?: string;
    storedTotal?: string;
    difference?: string;
    tolerance?: string;
    checkedAt?: string;
  } | null>(null);
  const [auditTrail, setAuditTrail] = useState<Array<Record<string, unknown>>>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      let data;
      const dists = distributions.length > 0 ? distributions : undefined;

      switch (reportType) {
        case "form-8949": {
          const res = await fetch(
            `/api/v1/compliance/form-8949?walletAddress=${encodeURIComponent(walletAddress)}&taxYear=${taxYear}&costBasisUsdPerXlm=${costBasis}&shortTerm=${shortTerm}`,
            { method: "GET", headers: { "Content-Type": "application/json" } }
          );
          data = await res.json();
          break;
        }
        case "turbotax": {
          const res = await fetch(
            `/api/v1/compliance/turbotax?walletAddress=${encodeURIComponent(walletAddress)}&taxYear=${taxYear}&costBasisUsdPerXlm=${costBasis}`,
            { method: "GET", headers: { "Content-Type": "application/json" } }
          );
          data = await res.json();
          break;
        }
        case "csv": {
          const url = new URL("/api/v1/compliance/csv-export", window.location.origin);
          url.searchParams.set("taxYear", String(taxYear));
          if (walletAddress) url.searchParams.set("walletAddress", walletAddress);
          if (country) url.searchParams.set("country", country);
          url.searchParams.set("download", String(download));
          const res = await fetch(url.toString());
          if (download) {
            const blob = await res.blob();
            const url2 = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url2;
            a.download = `tax-export-${taxYear}.csv`;
            a.click();
            window.URL.revokeObjectURL(url2);
            setResult({ downloaded: true });
            setLoading(false);
            return;
          }
          data = await res.json();
          break;
        }
        case "ledger": {
          if (!startDate || !endDate) {
            throw new Error("Start date and end date are required for generic ledger");
          }
          const url = new URL("/api/v1/compliance/generic-ledger", window.location.origin);
          url.searchParams.set("startDate", startDate);
          url.searchParams.set("endDate", endDate);
          if (walletAddress) url.searchParams.set("walletAddress", walletAddress);
          url.searchParams.set("format", format);
          url.searchParams.set("download", String(download && format === "csv"));
          const res = await fetch(url.toString());
          if (download && format === "csv") {
            const blob = await res.blob();
            const url2 = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url2;
            a.download = `generic-ledger-${startDate}-to-${endDate}.csv`;
            a.click();
            window.URL.revokeObjectURL(url2);
            setResult({ downloaded: true });
            setLoading(false);
            return;
          }
          data = await res.json();
          break;
        }
        case "sec-form-d": {
          const res = await fetch(
            `/api/v1/compliance/sec-form-d?walletAddress=${encodeURIComponent(walletAddress)}&taxYear=${taxYear}`,
            { method: "GET", headers: { "Content-Type": "application/json" } }
          );
          data = await res.json();
          break;
        }
        case "finra-trace": {
          if (!startDate || !endDate) {
            throw new Error("Start date and end date are required for FINRA TRACE");
          }
          const url = new URL("/api/v1/compliance/finra-trace", window.location.origin);
          url.searchParams.set("startDate", startDate);
          url.searchParams.set("endDate", endDate);
          if (walletAddress) url.searchParams.set("walletAddress", walletAddress);
          const res = await fetch(url.toString());
          data = await res.json();
          break;
        }
        case "export": {
          const url = new URL("/api/v1/compliance/export", window.location.origin);
          url.searchParams.set("taxYear", String(taxYear));
          if (walletAddress) url.searchParams.set("walletAddress", walletAddress);
          if (country) url.searchParams.set("country", country);
          url.searchParams.set("format", format);
          url.searchParams.set("download", String(download));
          const res = await fetch(url.toString());
          if (download && format === "csv") {
            const blob = await res.blob();
            const url2 = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url2;
            a.download = `compliance-export-${taxYear}.csv`;
            a.click();
            window.URL.revokeObjectURL(url2);
            setResult({ downloaded: true });
            setLoading(false);
            return;
          }
          data = await res.json();
          break;
        }
        default:
          throw new Error("Unknown report type");
      }

      if (!data.success) {
        throw new Error(data.error || "Failed to generate report");
      }

      setResult(data.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to generate report");
    } finally {
      setLoading(false);
    }
  };

  const loadAuditTrail = async () => {
    setAuditLoading(true);
    try {
      const url = new URL("/api/v1/compliance/audit-trail", window.location.origin);
      if (walletAddress) url.searchParams.set("walletAddress", walletAddress);
      if (startDate) url.searchParams.set("startDate", startDate);
      if (endDate) url.searchParams.set("endDate", endDate);
      const res = await fetch(url.toString());
      const data = await res.json();
      if (data.success) {
        setAuditTrail(data.data.reports);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit trail");
    } finally {
      setAuditLoading(false);
    }
  };

  const handleVerify = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/compliance/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportId: Number(result?.reportId || 0),
          walletAddress,
          taxYear,
          distributions,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Verification failed");
      setResult(data.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const addDistribution = () => {
    setDistributions([...distributions, { amountXlm: 0, timestamp: "", txHash: "" }]);
  };

  const removeDistribution = (index: number) => {
    setDistributions(distributions.filter((_, i) => i !== index));
  };

  const updateDistribution = (index: number, field: string, value: string | number) => {
    const newDists = [...distributions];
    newDists[index] = { ...newDists[index], [field]: value };
    setDistributions(newDists);
  };

  const tabs = [
    { id: "generate", label: "Generate Reports" },
    { id: "audit", label: "Audit Trail" },
    { id: "verify", label: "Verify Report" },
  ] as const;

  const reportTypes = [
    { id: "csv", label: "CSV Export", needsWallet: false, needsDates: false, adminOnly: false },
    {
      id: "form-8949",
      label: "Form 8949 (IRS)",
      needsWallet: true,
      needsDates: false,
      adminOnly: false,
    },
    {
      id: "turbotax",
      label: "TurboTax Import",
      needsWallet: true,
      needsDates: false,
      adminOnly: false,
    },
    {
      id: "ledger",
      label: "Generic Ledger",
      needsWallet: false,
      needsDates: true,
      adminOnly: false,
    },
    {
      id: "export",
      label: "Full Compliance Export",
      needsWallet: false,
      needsDates: false,
      adminOnly: true,
    },
    {
      id: "sec-form-d",
      label: "SEC Form D",
      needsWallet: true,
      needsDates: false,
      adminOnly: true,
    },
    {
      id: "finra-trace",
      label: "FINRA TRACE",
      needsWallet: false,
      needsDates: true,
      adminOnly: true,
    },
  ] as const;

  return (
    <div className="compliance-reporting">
      <div className="report-header">
        <h3>Compliance & Regulatory Reporting</h3>
      </div>

      <div className="tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "generate" && (
        <div className="generate-panel">
          <div className="form-section">
            <h4>Report Type</h4>
            <div className="report-type-grid">
              {reportTypes.map((rt) => (
                <button
                  key={rt.id}
                  className={`report-type-btn ${reportType === rt.id ? "selected" : ""}`}
                  onClick={() => setReportType(rt.id)}
                  disabled={rt.adminOnly && false}
                >
                  {rt.label} {rt.adminOnly && <span className="admin-badge">Admin</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="form-section">
            <h4>Parameters</h4>
            <div className="form-grid">
              {reportTypes.find((rt) => rt.id === reportType)?.needsWallet && (
                <div className="form-field">
                  <label>Wallet Address (G...)</label>
                  <input
                    type="text"
                    value={walletAddress}
                    onChange={(e) => setWalletAddress(e.target.value)}
                    placeholder="GABC123..."
                    maxLength={56}
                  />
                </div>
              )}

              <div className="form-field">
                <label>Tax Year</label>
                <input
                  type="number"
                  value={taxYear}
                  onChange={(e) =>
                    setTaxYear(parseInt(e.target.value) || new Date().getFullYear() - 1)
                  }
                  min={2020}
                  max={new Date().getFullYear()}
                />
              </div>

              {reportTypes.find((rt) => rt.id === reportType)?.needsDates && (
                <>
                  <div className="form-field">
                    <label>Start Date</label>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </div>
                  <div className="form-field">
                    <label>End Date</label>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </div>
                </>
              )}

              {["form-8949", "turbotax"].includes(reportType) && (
                <>
                  <div className="form-field">
                    <label>Cost Basis (USD per XLM)</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={costBasis}
                      onChange={(e) => setCostBasis(parseFloat(e.target.value) || 0)}
                      placeholder="0 (auto-calculate)"
                    />
                  </div>
                  {reportType === "form-8949" && (
                    <div className="form-field checkbox-field">
                      <label>
                        <input
                          type="checkbox"
                          checked={shortTerm}
                          onChange={(e) => setShortTerm(e.target.checked)}
                        />
                        Short Term (Part I)
                      </label>
                    </div>
                  )}
                </>
              )}

              {["csv", "export"].includes(reportType) && (
                <div className="form-field">
                  <label>Country Filter</label>
                  <select value={country} onChange={(e) => setCountry(e.target.value)}>
                    <option value="">All Countries</option>
                    <option value="US">US</option>
                    <option value="CA">Canada</option>
                    <option value="EU">EU</option>
                  </select>
                </div>
              )}

              {["ledger", "export"].includes(reportType) && (
                <div className="form-field">
                  <label>Format</label>
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value as "json" | "csv")}
                  >
                    <option value="json">JSON</option>
                    <option value="csv">CSV</option>
                  </select>
                </div>
              )}

              {format === "csv" && (
                <div className="form-field checkbox-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={download}
                      onChange={(e) => setDownload(e.target.checked)}
                    />
                    Download as file
                  </label>
                </div>
              )}
            </div>
          </div>

          {["form-8949", "turbotax", "sec-form-d"].includes(reportType) && (
            <div className="form-section">
              <h4>Distributions (Optional - for live calculation)</h4>
              <div className="distributions-table">
                <table>
                  <thead>
                    <tr>
                      <th>XLM Amount</th>
                      <th>Timestamp</th>
                      <th>Tx Hash</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {distributions.map((d, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            type="number"
                            step="0.0000001"
                            value={d.amountXlm}
                            onChange={(e) =>
                              updateDistribution(i, "amountXlm", parseFloat(e.target.value) || 0)
                            }
                            placeholder="0"
                          />
                        </td>
                        <td>
                          <input
                            type="datetime-local"
                            value={d.timestamp}
                            onChange={(e) => updateDistribution(i, "timestamp", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={d.txHash}
                            onChange={(e) => updateDistribution(i, "txHash", e.target.value)}
                            placeholder="Optional"
                          />
                        </td>
                        <td>
                          <button className="remove-btn" onClick={() => removeDistribution(i)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button className="add-dist-btn" onClick={addDistribution}>
                  + Add Distribution
                </button>
              </div>
            </div>
          )}

          <div className="form-actions">
            <button className="generate-btn" onClick={handleGenerate} disabled={loading}>
              {loading ? "Generating..." : "Generate Report"}
            </button>
          </div>

          {error && <div className="error-banner">{error}</div>}

          {result && !loading && (
            <div className="result-panel">
              <h4>Result</h4>
              <pre>{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}

      {activeTab === "audit" && (
        <div className="audit-panel">
          <div className="form-section">
            <h4>Filters</h4>
            <div className="form-grid">
              <div className="form-field">
                <label>Wallet Address (optional)</label>
                <input
                  type="text"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                  placeholder="GABC123..."
                  maxLength={56}
                />
              </div>
              <div className="form-field">
                <label>Start Date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="form-field">
                <label>End Date</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
            </div>
            <button onClick={loadAuditTrail} disabled={auditLoading}>
              {auditLoading ? "Loading..." : "Load Audit Trail"}
            </button>
          </div>

          {auditTrail.length > 0 && (
            <div className="audit-table">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Type</th>
                    <th>Period</th>
                    <th>Contract</th>
                    <th>Status</th>
                    <th>Generated</th>
                    <th>Completed</th>
                    <th>Emailed To</th>
                  </tr>
                </thead>
                <tbody>
                  {auditTrail.map((report, i) => (
                    <tr key={i}>
                      <td>{report.id}</td>
                      <td>{report.type}</td>
                      <td>
                        {report.periodStart} to {report.periodEnd}
                      </td>
                      <td>{report.contractId}</td>
                      <td>
                        <span className={`status-badge ${report.status}`}>{report.status}</span>
                      </td>
                      <td>
                        {report.createdAt
                          ? new Date(report.createdAt as string).toLocaleString()
                          : "-"}
                      </td>
                      <td>
                        {report.completedAt
                          ? new Date(report.completedAt as string).toLocaleString()
                          : "-"}
                      </td>
                      <td>{(report.emailedTo as string[])?.join(", ") || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {auditTrail.length === 0 && !auditLoading && (
            <div className="empty-state">No audit trail entries found</div>
          )}
        </div>
      )}

      {activeTab === "verify" && (
        <div className="verify-panel">
          <div className="form-section">
            <h4>Verify Report Accuracy</h4>
            <div className="form-grid">
              <div className="form-field">
                <label>Report ID</label>
                <input
                  type="number"
                  value={result?.reportId || ""}
                  onChange={(e) =>
                    setResult({ ...(result || {}), reportId: parseInt(e.target.value) || 0 })
                  }
                  placeholder="Enter report ID"
                />
              </div>
              <div className="form-field">
                <label>Wallet Address</label>
                <input
                  type="text"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                  placeholder="GABC123..."
                  maxLength={56}
                />
              </div>
              <div className="form-field">
                <label>Tax Year</label>
                <input
                  type="number"
                  value={taxYear}
                  onChange={(e) =>
                    setTaxYear(parseInt(e.target.value) || new Date().getFullYear() - 1)
                  }
                  min={2020}
                  max={new Date().getFullYear()}
                />
              </div>
            </div>
            <button className="verify-btn" onClick={handleVerify} disabled={loading}>
              {loading ? "Verifying..." : "Verify Accuracy"}
            </button>

            {error && <div className="error-banner">{error}</div>}

            {result && result.verified !== undefined && !loading && (
              <div className={`verification-result ${result.verified ? "verified" : "mismatch"}`}>
                <h5>
                  {result.verified ? "✓ Verified - Report is Accurate" : "✗ Mismatch Detected"}
                </h5>
                <div className="verification-details">
                  <p>Calculated Total: ${result.calculatedTotal}</p>
                  <p>Stored Total: ${result.storedTotal}</p>
                  <p>Difference: ${result.difference}</p>
                  <p>Tolerance: ${result.tolerance}</p>
                  <p>Checked At: {new Date(result.checkedAt as string).toLocaleString()}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
