import { useState, useRef } from "react";
import { api } from "../api";
import "./BulkContributorUpload.css";

interface BulkContributorUploadProps {
  contractId: string;
  onSuccess?: (importId: number) => void;
}

interface PreviewRow {
  rowIndex: number;
  address: string;
  share: number;
  error?: string;
}

export function BulkContributorUpload({ contractId, onSuccess }: BulkContributorUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<"upload" | "preview" | "importing" | "done">("upload");
  const [preview, setPreview] = useState<{
    validRows: PreviewRow[];
    errorRows: PreviewRow[];
    summary: { total: number; valid: number; errors: number };
  } | null>(null);
  const [importResult, setImportResult] = useState<{
    importId: number;
    summary: { total: number; successCount: number; errorCount: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    if (!selected.name.endsWith(".csv")) {
      setError("Please select a CSV file");
      return;
    }

    setFile(selected);
    setError(null);
    handlePreview(selected);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files?.[0];
    if (!dropped) return;

    if (!dropped.name.endsWith(".csv")) {
      setError("Please drop a CSV file");
      return;
    }

    setFile(dropped);
    setError(null);
    handlePreview(dropped);
  };

  const handlePreview = async (file: File) => {
    setStep("preview");
    setError(null);
    try {
      const result = await api.previewCsv(file, contractId);
      setPreview(result.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to preview CSV";
      setError(message);
      setStep("upload");
    }
  };

  const handleImport = async () => {
    if (!file) return;
    setStep("importing");
    setError(null);
    try {
      const result = await api.importCsv(file, contractId);
      setImportResult(result.data);
      setStep("done");
      if (onSuccess) onSuccess(result.data.importId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to import CSV";
      setError(message);
      setStep("preview");
    }
  };

  const handleDownloadTemplate = () => {
    api.downloadCsvTemplate();
  };

  const handleReset = () => {
    setFile(null);
    setPreview(null);
    setImportResult(null);
    setError(null);
    setStep("upload");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="bulk-contributor-upload">
      <div className="upload-header">
        <h3>Bulk Contributor Upload</h3>
        <button className="download-template-btn" onClick={handleDownloadTemplate}>
          Download CSV Template
        </button>
      </div>

      <p className="upload-description">
        Upload a CSV file with contributor addresses and share percentages.
        The CSV must have <code>address</code> and <code>share_percentage</code> columns.
      </p>

      {error && <div className="upload-error">{error}</div>}

      {step === "upload" && (
        <div
          className="upload-dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            aria-label="Upload CSV file"
            accept=".csv"
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
          <div className="dropzone-content">
            <span className="dropzone-icon">📄</span>
            <p>Drag and drop a CSV file here, or click to select</p>
            <span className="dropzone-hint">Only .csv files are accepted</span>
          </div>
        </div>
      )}

      {step === "preview" && preview && (
        <div className="upload-preview">
          <div className="preview-summary">
            <span className="summary-valid">✓ {preview.summary.valid} valid rows</span>
            {preview.summary.errors > 0 && (
              <span className="summary-errors">✗ {preview.summary.errors} errors</span>
            )}
            <span className="summary-total">Total: {preview.summary.total} rows</span>
          </div>

          {preview.validRows.length > 0 && (
            <div className="preview-table-section">
              <h4>Valid Rows ({preview.validRows.length})</h4>
              <div className="preview-table-wrapper">
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Address</th>
                      <th>Share (%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.validRows.map((row) => (
                      <tr key={row.rowIndex}>
                        <td>{row.rowIndex}</td>
                        <td><code>{row.address}</code></td>
                        <td>{row.share}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {preview.errorRows.length > 0 && (
            <div className="preview-errors-section">
              <h4>Errors ({preview.errorRows.length})</h4>
              {preview.errorRows.map((row) => (
                <div key={row.rowIndex} className="error-row">
                  <span className="error-row-line">Row {row.rowIndex}:</span>
                  <span className="error-row-address">{row.address || "(empty)"}</span>
                  <span className="error-row-message">{row.error}</span>
                </div>
              ))}
            </div>
          )}

          <div className="preview-actions">
            <button className="btn-import" onClick={handleImport} disabled={preview.validRows.length === 0}>
              Import {preview.validRows.length} Contributors
            </button>
            <button className="btn-cancel" onClick={handleReset}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === "importing" && (
        <div className="upload-importing">
          <div className="importing-spinner" />
          <p>Importing contributors...</p>
        </div>
      )}

      {step === "done" && importResult && (
        <div className="upload-done">
          <div className="done-icon">✅</div>
          <h4>Import Complete</h4>
          <div className="done-summary">
            <div className="done-stat">
              <span className="done-stat-label">Total</span>
              <span className="done-stat-value">{importResult.summary.total}</span>
            </div>
            <div className="done-stat success">
              <span className="done-stat-label">Success</span>
              <span className="done-stat-value">{importResult.summary.successCount}</span>
            </div>
            {importResult.summary.errorCount > 0 && (
              <div className="done-stat error">
                <span className="done-stat-label">Errors</span>
                <span className="done-stat-value">{importResult.summary.errorCount}</span>
              </div>
            )}
          </div>
          <button className="btn-import-another" onClick={handleReset}>
            Import Another File
          </button>
        </div>
      )}
    </div>
  );
}
