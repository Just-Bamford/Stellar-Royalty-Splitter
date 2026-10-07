import { useMemo, useState } from "react";
import type { Dispute, DisputeStatus } from "../hooks/queries/useDisputes";
import { DisputeTimeline } from "./DisputeTimeline";

interface DisputeDetailProps {
  dispute: Dispute;
  onClose: () => void;
  onStatusChange: (disputeId: string, nextStatus: DisputeStatus, adminResponse?: string) => void;
}

export function DisputeDetail({
  dispute,
  onClose,
  onStatusChange,
}: DisputeDetailProps) {
  const [response, setResponse] = useState(dispute.adminResponse ?? "");

  const statusLabel = useMemo(() => {
    return dispute.status === "clawed-back"
      ? "Clawed back"
      : dispute.status === "resolved"
        ? "Resolved"
        : "Open";
  }, [dispute.status]);

  return (
    <div className="dispute-modal-backdrop" onClick={onClose}>
      <div className="dispute-modal" onClick={(event) => event.stopPropagation()}>
        <div className="dispute-modal-header">
          <div>
            <div className="modal-kicker">Dispute case</div>
            <h3>{dispute.title}</h3>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close dispute detail">
            ×
          </button>
        </div>

        <div className="dispute-modal-grid">
          <div>
            <div className="dispute-meta-row">
              <span className={`status-badge status-${dispute.status}`}>{statusLabel}</span>
              <span className="dispute-id">{dispute.id}</span>
            </div>
            <p className="dispute-modal-description">{dispute.description}</p>

            <div className="info-grid">
              <div>
                <span className="info-label">Collaborator</span>
                <strong>{dispute.collaborator}</strong>
              </div>
              <div>
                <span className="info-label">Amount</span>
                <strong>${dispute.amount.toLocaleString()}</strong>
              </div>
              <div>
                <span className="info-label">Category</span>
                <strong>{dispute.category}</strong>
              </div>
              <div>
                <span className="info-label">Created</span>
                <strong>{new Date(dispute.createdAt).toLocaleString()}</strong>
              </div>
            </div>

            <label className="field-label" htmlFor="admin-response">
              Admin response
            </label>
            <textarea
              id="admin-response"
              className="dispute-response"
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              rows={4}
              placeholder="Add the admin response or resolution note"
            />

            <div className="urgent-actions">
              <button
                type="button"
                className="action-btn primary"
                onClick={() => onStatusChange(dispute.id, "resolved", response || dispute.adminResponse)}
              >
                Resolve
              </button>
              <button
                type="button"
                className="action-btn warn"
                onClick={() => onStatusChange(dispute.id, "clawed-back", response || dispute.adminResponse)}
              >
                Clawback
              </button>
              <button
                type="button"
                className="action-btn secondary"
                onClick={() => onStatusChange(dispute.id, "open", response || dispute.adminResponse)}
              >
                Reopen
              </button>
            </div>
          </div>

          <div className="dispute-modal-sidebar">
            <h4>Lifecycle</h4>
            <DisputeTimeline dispute={dispute} />
            <div className="note-stack">
              <h4>History</h4>
              {dispute.notes.map((note) => (
                <div key={note.id} className="note-card">
                  <div className="note-card-header">
                    <strong>{note.author}</strong>
                    <span>{new Date(note.timestamp).toLocaleString()}</span>
                  </div>
                  <p>{note.message}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DisputeDetail;
