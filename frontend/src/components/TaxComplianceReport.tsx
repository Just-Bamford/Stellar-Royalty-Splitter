import { useState, useEffect } from "react";
import { api } from "../api";
import "./TaxComplianceReport.css";

export function TaxComplianceReport() {
  const [report, setReport] = useState<{
    data: Array<Record<string, unknown>>;
    summary: { total: number; compliant: number; nonCompliant: number; missing: number };
  } | null>(null);
  const [missing, setMissing] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadReports();
  }, []);

  const loadReports = async () => {
    setLoading(true);
    setError(null);
    try {
      const [compliance, missingData] = await Promise.all([
        api.getTaxComplianceReport(),
        api.getContributorsMissingTaxInfo(),
      ]);
      setReport(compliance);
      setMissing(missingData.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load tax reports");
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="tax-report-loading">Loading compliance report...</div>;
  if (error) return <div className="tax-report-error">{error}</div>;

  return (
    <div className="tax-compliance-report">
      <div className="report-header">
        <h3>Tax Compliance Report</h3>
        <button className="report-refresh-btn" onClick={loadReports}>Refresh</button>
      </div>

      {report?.summary && (
        <div className="report-summary-cards">
          <div className="report-card total">
            <span className="report-card-value">{report.summary.total}</span>
            <span className="report-card-label">Total Contributors</span>
          </div>
          <div className="report-card compliant">
            <span className="report-card-value">{report.summary.compliant}</span>
            <span className="report-card-label">Compliant</span>
          </div>
          <div className="report-card non-compliant">
            <span className="report-card-value">{report.summary.nonCompliant}</span>
            <span className="report-card-label">Non-Compliant</span>
          </div>
          <div className="report-card missing">
            <span className="report-card-value">{report.summary.missing}</span>
            <span className="report-card-label">Missing Info</span>
          </div>
        </div>
      )}

      <div className="report-section">
        <h4>Compliance Details</h4>
        <div className="report-table-wrapper">
          <table className="report-table">
            <thead>
              <tr>
                <th>Wallet Address</th>
                <th>Tax Status</th>
                <th>Tax ID</th>
                <th>Document</th>
                <th>Compliance</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {report?.data.map((row, idx) => (
                <tr key={idx}>
                  <td><code>{(row.walletAddress as string)?.slice(0, 8)}...</code></td>
                  <td>{row.tax_status as string || "Not Set"}</td>
                  <td>{row.tax_id as string || "-"}</td>
                  <td>{row.w9_file_name as string ? "✓" : "✗"}</td>
                  <td>
                    <span className={`compliance-badge ${row.compliance_status as string}`}>
                      {row.compliance_status as string}
                    </span>
                  </td>
                  <td>{row.updated_at ? new Date(row.updated_at as string).toLocaleDateString() : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {missing.length > 0 && (
        <div className="report-section missing-section">
          <h4>Contributors Missing Tax Information ({missing.length})</h4>
          {missing.map((row, idx) => (
            <div key={idx} className="missing-item">
              <code>{(row.walletAddress as string)?.slice(0, 12)}...</code>
              <span className="missing-status">{row.tax_status as string || "Not collected"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
