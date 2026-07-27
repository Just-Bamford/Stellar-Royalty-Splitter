// #588 Admin Key Rotation
import { useState, useEffect } from "react";
import { Skeleton } from "./Skeleton";
import "./KeyRotationPanel.css";

interface KeyStatus {
  configured: boolean;
  publicKey: string | null;
  lastRotationAt: string | null;
  lastRotationSource: string | null;
  secretsProvider: string;
  encryptionEnabled: boolean;
}

type RotateMethod = "secretKey" | "reloadFromFile" | "reloadFromProvider";

async function fetchKeyStatus(token: string): Promise<KeyStatus> {
  const res = await fetch("/api/admin/key-status", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  return res.json();
}

async function rotateKey(
  token: string,
  body: Record<string, unknown>,
): Promise<{ publicKey: string; rotatedAt: string; source: string }> {
  const res = await fetch("/api/admin/rotate-key", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
  return data;
}

interface KeyRotationPanelProps {
  adminToken: string;
}

export const KeyRotationPanel: React.FC<KeyRotationPanelProps> = ({ adminToken }) => {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [method, setMethod] = useState<RotateMethod>("secretKey");
  const [secretInput, setSecretInput] = useState("");
  const [rotating, setRotating] = useState(false);
  const [rotateResult, setRotateResult] = useState<{ ok: boolean; message: string } | null>(null);

  const loadStatus = async () => {
    if (!adminToken) return;
    setStatusLoading(true);
    setStatusError(null);
    try {
      setStatus(await fetchKeyStatus(adminToken));
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "Failed to load key status");
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, [adminToken]);

  const handleRotate = async () => {
    setRotating(true);
    setRotateResult(null);
    try {
      const body: Record<string, unknown> =
        method === "secretKey"
          ? { secretKey: secretInput.trim() }
          : method === "reloadFromFile"
          ? { reloadFromFile: true }
          : { reloadFromProvider: true };

      const result = await rotateKey(adminToken, body);
      setRotateResult({
        ok: true,
        message: `Key rotated — new public key: ${result.publicKey.slice(0, 16)}… (${result.source})`,
      });
      setSecretInput("");
      loadStatus();
    } catch (e) {
      setRotateResult({
        ok: false,
        message: e instanceof Error ? e.message : "Rotation failed",
      });
    } finally {
      setRotating(false);
    }
  };

  const canRotate =
    !rotating &&
    (method !== "secretKey" || secretInput.trim().startsWith("S"));

  return (
    <div className="key-rotation-panel">
      <h3>🔑 Signing Key Rotation</h3>

      {/* Status grid */}
      <div className="key-status-row">
        {statusLoading ? (
          [1, 2, 3].map((i) => (
            <div key={i} className="key-status-item">
              <Skeleton width="60%" height="0.75rem" className="mb-2" />
              <Skeleton width="80%" height="0.875rem" />
            </div>
          ))
        ) : statusError ? (
          <p style={{ color: "var(--color-danger, red)", fontSize: "0.82rem" }}>{statusError}</p>
        ) : status ? (
          <>
            <div className="key-status-item">
              <div className="key-status-label">Status</div>
              <div className={`key-status-value ${status.configured ? "configured" : "unconfigured"}`}>
                {status.configured ? "Configured" : "Not configured"}
              </div>
            </div>
            <div className="key-status-item">
              <div className="key-status-label">Public Key</div>
              <div className="key-status-value">
                {status.publicKey
                  ? `${status.publicKey.slice(0, 10)}…${status.publicKey.slice(-6)}`
                  : "—"}
              </div>
            </div>
            <div className="key-status-item">
              <div className="key-status-label">Last Rotated</div>
              <div className="key-status-value" style={{ fontFamily: "inherit" }}>
                {status.lastRotationAt
                  ? new Date(status.lastRotationAt).toLocaleString()
                  : "Never"}
              </div>
            </div>
            <div className="key-status-item">
              <div className="key-status-label">Source</div>
              <div className="key-status-value" style={{ fontFamily: "inherit" }}>
                {status.secretsProvider ?? status.lastRotationSource ?? "—"}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* Rotation form */}
      <div className="key-rotate-form">
        <div className="rotate-method-tabs">
          {(
            [
              { id: "secretKey", label: "Direct Secret Key" },
              { id: "reloadFromFile", label: "Reload from File" },
              { id: "reloadFromProvider", label: "Reload from Provider" },
            ] as { id: RotateMethod; label: string }[]
          ).map((m) => (
            <button
              key={m.id}
              className={`rotate-method-tab ${method === m.id ? "active" : ""}`}
              onClick={() => { setMethod(m.id); setRotateResult(null); }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {method === "secretKey" && (
          <div className="key-input-row">
            <input
              className="key-input"
              type="password"
              placeholder="SXXXXXXXXXXXXXXXXXXXXXXX…"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              aria-label="New Stellar secret key"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        {method === "reloadFromFile" && (
          <p className="rotate-hint">
            Reads the key from the path configured in <code>SIGNING_KEY_FILE</code>.
          </p>
        )}

        {method === "reloadFromProvider" && (
          <p className="rotate-hint">
            Pulls the latest key from the configured secrets provider (AWS Secrets Manager / HashiCorp Vault).
          </p>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <button className="rotate-btn" onClick={handleRotate} disabled={!canRotate}>
            {rotating ? "Rotating…" : "Rotate Key"}
          </button>
          {rotateResult && (
            <div className={`rotate-result ${rotateResult.ok ? "success" : "error"}`}>
              {rotateResult.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
