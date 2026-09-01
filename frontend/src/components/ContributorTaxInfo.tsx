import { useState, useEffect, useRef } from "react";
import { api } from "../api";
import "./ContributorTaxInfo.css";

interface ContributorTaxInfoProps {
  walletAddress: string;
  isAdmin?: boolean;
}

export function ContributorTaxInfo({ walletAddress, isAdmin = false }: ContributorTaxInfoProps) {
  const [taxStatus, setTaxStatus] = useState<string>("not_collected");
  const [taxId, setTaxId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [hasDocument, setHasDocument] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadTaxInfo();
  }, [walletAddress]);

  const loadTaxInfo = async () => {
    setLoading(true);
    try {
      const result = await api.getContributorTax(walletAddress);
      if (result.data) {
        setTaxStatus(result.data.tax_status ?? "not_collected");
        setTaxId(result.data.tax_id ?? "");
        setHasDocument(!!result.data.w9_file_name);
      }
    } catch {
      /* not yet set up */
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.saveContributorTax(walletAddress, taxStatus, taxId || undefined);
      setMessage({ type: "success", text: "Tax information saved successfully" });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : "Failed to save tax information";
      setMessage({ type: "error", text });
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = async () => {
    if (!file) return;
    setSaving(true);
    setMessage(null);
    try {
      await api.uploadTaxDocument(walletAddress, file);
      setHasDocument(true);
      setFile(null);
      setTaxStatus("pending");
      setMessage({ type: "success", text: "Tax document uploaded successfully" });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : "Failed to upload document";
      setMessage({ type: "error", text });
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadDocument = () => {
    api.getTaxDocument(walletAddress);
  };

  if (loading) {
    return <div className="tax-info-loading">Loading tax information...</div>;
  }

  return (
    <div className="contributor-tax-info">
      <h3>Tax Information</h3>

      {message && (
        <div className={`tax-message tax-message--${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="tax-form-group">
        <label htmlFor="taxStatus">Tax Status</label>
        <select
          id="taxStatus"
          value={taxStatus}
          onChange={(e) => setTaxStatus(e.target.value)}
          className="tax-select"
        >
          <option value="not_collected">Not Collected</option>
          <option value="pending">Pending</option>
          <option value="completed">Completed</option>
          <option value="exempt">Exempt</option>
        </select>
      </div>

      <div className="tax-form-group">
        <label htmlFor="taxId">Tax ID (EIN/SSN)</label>
        <input
          id="taxId"
          type="text"
          value={taxId}
          onChange={(e) => setTaxId(e.target.value)}
          placeholder="Enter tax ID"
          className="tax-input"
        />
      </div>

      {isAdmin && (
        <div className="tax-form-group">
          <label>Tax Document (W-9)</label>
          <div className="tax-document-upload">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ display: "none" }}
            />
            <button
              className="tax-upload-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              {file ? `Selected: ${file.name}` : "Upload Tax Document"}
            </button>
            {file && (
              <button className="tax-upload-submit" onClick={handleFileUpload} disabled={saving}>
                Upload
              </button>
            )}
          </div>
          {hasDocument && (
            <button className="tax-download-btn" onClick={handleDownloadDocument}>
              Download Current Document
            </button>
          )}
        </div>
      )}

      <button className="tax-save-btn" onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save Tax Information"}
      </button>
    </div>
  );
}
