/**
 * ContributorVerification — closes #602.
 *
 * Multi-step verification UI: email → KYC → manual review → verified.
 * Contributors can start and track their own verification; admins can
 * advance or reject from the admin dashboard.
 */
import { useState, useEffect } from "react";
import { api } from "../api";

type VerificationStep = "email" | "kyc" | "manual_review" | "verified" | "rejected";
type VerificationStatus = "pending" | "in_progress" | "completed" | "failed";

interface VerificationRecord {
  walletAddress: string;
  step: VerificationStep;
  status: VerificationStatus;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  walletAddress: string;
  /** If true, admin controls (advance/reject) are shown */
  isAdmin?: boolean;
}

const STEP_LABELS: Record<VerificationStep, string> = {
  email:         "Email Confirmation",
  kyc:           "Identity Verification (KYC)",
  manual_review: "Manual Review",
  verified:      "Verified",
  rejected:      "Rejected",
};

const STEP_ORDER: VerificationStep[] = ["email", "kyc", "manual_review", "verified"];

function StepIndicator({ current }: { current: VerificationStep }) {
  const currentIdx = STEP_ORDER.indexOf(current as VerificationStep);

  return (
    <ol className="verification-steps" aria-label="Verification progress">
      {STEP_ORDER.map((step, idx) => {
        const done = idx < currentIdx;
        const active = idx === currentIdx && current !== "rejected";
        return (
          <li
            key={step}
            className={`verification-step${done ? " done" : ""}${active ? " active" : ""}`}
            aria-current={active ? "step" : undefined}
          >
            <span className="step-dot" aria-hidden="true">
              {done ? "✓" : idx + 1}
            </span>
            <span className="step-label">{STEP_LABELS[step]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function ContributorVerification({ walletAddress, isAdmin = false }: Props) {
  const [record, setRecord] = useState<VerificationRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminNote, setAdminNote] = useState("");

  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getVerification(walletAddress)
      .then((res) => {
        if (!cancelled) setRecord(res.data);
      })
      .catch(() => {
        if (!cancelled) setRecord(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  async function handleStart() {
    setActionLoading(true);
    setError(null);
    try {
      const res = await api.startVerification(walletAddress);
      setRecord(res.data as VerificationRecord);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to start verification");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleAdvance(step: VerificationStep, status: VerificationStatus) {
    setActionLoading(true);
    setError(null);
    try {
      const res = await api.advanceVerification({
        walletAddress,
        step,
        status,
        adminNote: adminNote || null,
      });
      setRecord(res.data as VerificationRecord);
      setAdminNote("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update verification");
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="card" aria-live="polite" aria-busy="true">
        <p className="description">Loading verification status…</p>
      </div>
    );
  }

  return (
    <div className="card contributor-verification" aria-label="Contributor verification">
      <span className="badge">Contributor Verification</span>

      {!record ? (
        <div>
          <p className="description">
            Start the verification process to confirm your identity and unlock
            full contributor features.
          </p>
          <button
            className="btn-primary"
            onClick={handleStart}
            disabled={actionLoading || !walletAddress}
            aria-busy={actionLoading}
          >
            {actionLoading ? "Starting…" : "Start verification"}
          </button>
        </div>
      ) : (
        <div>
          <StepIndicator current={record.step} />

          <div className="verification-status">
            <p>
              <strong>Current step:</strong> {STEP_LABELS[record.step]}
            </p>
            <p>
              <strong>Status:</strong>{" "}
              <span className={`status-badge status-badge--${record.status}`}>
                {record.status.replace("_", " ")}
              </span>
            </p>
            {record.adminNote && (
              <p>
                <strong>Note:</strong> {record.adminNote}
              </p>
            )}
            <p className="description">
              Last updated: {new Date(record.updatedAt).toLocaleString()}
            </p>
          </div>

          {/* Admin controls */}
          {isAdmin && record.step !== "verified" && record.step !== "rejected" && (
            <div className="admin-controls">
              <label htmlFor="admin-note">Admin note (optional)</label>
              <input
                id="admin-note"
                type="text"
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                placeholder="Add a note…"
                disabled={actionLoading}
              />
              <div className="form-actions">
                {record.step === "email" && (
                  <button
                    className="btn-primary"
                    onClick={() => handleAdvance("kyc", "pending")}
                    disabled={actionLoading}
                  >
                    Advance to KYC
                  </button>
                )}
                {record.step === "kyc" && (
                  <button
                    className="btn-primary"
                    onClick={() => handleAdvance("manual_review", "pending")}
                    disabled={actionLoading}
                  >
                    Send to Manual Review
                  </button>
                )}
                {record.step === "manual_review" && (
                  <button
                    className="btn-primary"
                    onClick={() => handleAdvance("verified", "completed")}
                    disabled={actionLoading}
                  >
                    Approve
                  </button>
                )}
                <button
                  className="btn-secondary"
                  onClick={() => handleAdvance("rejected", "failed")}
                  disabled={actionLoading}
                >
                  Reject
                </button>
              </div>
            </div>
          )}

          {record.step === "verified" && (
            <p className="description" style={{ color: "var(--color-success, green)" }}>
              ✅ This contributor has been fully verified.
            </p>
          )}

          {record.step === "rejected" && (
            <p className="description" style={{ color: "var(--color-error, red)" }}>
              ❌ Verification was rejected.
              {record.adminNote && ` Reason: ${record.adminNote}`}
            </p>
          )}
        </div>
      )}

      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
