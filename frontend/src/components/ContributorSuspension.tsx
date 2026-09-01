import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import "./ContributorSuspension.css";

type StatusEntry = {
  contractId: string;
  address: string;
  status: "active" | "suspended" | "deactivated";
  reason: string | null;
  suspendedAt: string | null;
  deactivatedAt: string | null;
  updatedBy: string | null;
  updatedAt?: string;
};

interface ContributorSuspensionProps {
  contractId: string;
  walletAddress: string | null;
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "cs-badge--active" },
  suspended: { label: "Suspended", cls: "cs-badge--suspended" },
  deactivated: { label: "Deactivated", cls: "cs-badge--deactivated" },
};

function StatusBadge({ status }: { status: string }) {
  const { label, cls } = STATUS_LABELS[status] ?? { label: status, cls: "" };
  return <span className={`cs-badge ${cls}`}>{label}</span>;
}

export function ContributorSuspension({ contractId, walletAddress }: ContributorSuspensionProps) {
  const [entries, setEntries] = useState<StatusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeActive, setIncludeActive] = useState(false);

  // Inline edit state
  const [editAddress, setEditAddress] = useState("");
  const [editStatus, setEditStatus] = useState<"active" | "suspended" | "deactivated">("suspended");
  const [editReason, setEditReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getContributorStatuses(contractId, includeActive);
      setEntries(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load statuses");
    } finally {
      setLoading(false);
    }
  }, [contractId, includeActive]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editAddress.trim()) return;

    setSubmitting(true);
    setSubmitMsg(null);

    try {
      await api.setContributorStatus(contractId, editAddress.trim(), {
        status: editStatus,
        reason: editReason.trim() || undefined,
        updatedBy: walletAddress ?? undefined,
      });
      setSubmitMsg({ type: "ok", text: `Status updated to "${editStatus}"` });
      setEditAddress("");
      setEditReason("");
      void load();
    } catch (err) {
      setSubmitMsg({
        type: "err",
        text: err instanceof Error ? err.message : "Failed to update status",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="cs">
      <div className="cs-header">
        <h2 className="cs-title">Contributor Status Management</h2>
        <p className="cs-subtitle">
          Suspend or deactivate contributors without losing their transaction history.
        </p>
      </div>

      {/* Update form */}
      <div className="cs-form-card">
        <h3 className="cs-form-title">Update Contributor Status</h3>
        <form className="cs-form" onSubmit={handleSubmit}>
          <div className="cs-field">
            <label htmlFor="cs-address">Contributor Address</label>
            <input
              id="cs-address"
              type="text"
              placeholder="G..."
              value={editAddress}
              onChange={(e) => setEditAddress(e.target.value)}
              pattern="^G[A-Z2-7]{55}$"
              required
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="cs-field">
            <label htmlFor="cs-status">New Status</label>
            <select
              id="cs-status"
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value as typeof editStatus)}
            >
              <option value="active">Active — resume payouts</option>
              <option value="suspended">Suspended — pause payouts temporarily</option>
              <option value="deactivated">Deactivated — remove from payouts permanently</option>
            </select>
          </div>

          <div className="cs-field">
            <label htmlFor="cs-reason">Reason (optional)</label>
            <input
              id="cs-reason"
              type="text"
              placeholder="e.g. Terms violation, payment dispute…"
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              maxLength={500}
            />
          </div>

          <button
            type="submit"
            className="cs-submit-btn"
            disabled={submitting || !editAddress.trim()}
          >
            {submitting ? "Saving…" : "Update Status"}
          </button>

          {submitMsg && (
            <p className={`cs-submit-msg cs-submit-msg--${submitMsg.type}`} role="status">
              {submitMsg.text}
            </p>
          )}
        </form>
      </div>

      {/* List */}
      <div className="cs-list-header">
        <h3 className="cs-list-title">Current Statuses</h3>
        <div className="cs-list-controls">
          <label className="cs-toggle">
            <input
              type="checkbox"
              checked={includeActive}
              onChange={(e) => setIncludeActive(e.target.checked)}
            />
            Show active
          </label>
          <button
            type="button"
            className="cs-refresh-btn"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "…" : "↺ Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="cs-error" role="alert">{error}</div>}

      {loading && entries.length === 0 && (
        <div className="cs-loading" aria-busy="true">Loading…</div>
      )}

      {!loading && entries.length === 0 && (
        <div className="cs-empty">
          {includeActive
            ? "No contributors found for this contract."
            : "No suspended or deactivated contributors."}
        </div>
      )}

      {entries.length > 0 && (
        <div className="cs-table-wrapper">
          <table className="cs-table">
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Status</th>
                <th scope="col">Reason</th>
                <th scope="col">Updated</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.address}>
                  <td>
                    <code className="cs-address" title={e.address}>
                      {e.address.slice(0, 8)}…{e.address.slice(-6)}
                    </code>
                  </td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="cs-reason">{e.reason ?? "—"}</td>
                  <td>
                    {e.updatedAt ? new Date(e.updatedAt).toLocaleDateString() : "—"}
                  </td>
                  <td>
                    {e.updatedBy ? (
                      <code className="cs-address" title={e.updatedBy}>
                        {e.updatedBy.slice(0, 8)}…{e.updatedBy.slice(-6)}
                      </code>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
