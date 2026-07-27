/**
 * ContractUpgrade — closes #604.
 *
 * Provides a UI for admins to upgrade the contract WASM without redeployment.
 * State and distributions are fully preserved.  The user supplies the WASM
 * hash of the pre-uploaded replacement blob, signs the XDR with Freighter,
 * and submits.
 */
import { useState, useEffect } from "react";
import { api } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
import FormStatus from "./FormStatus";
import { useFormStatus } from "../hooks/useFormStatus";

interface Props {
  contractId: string;
  walletAddress: string;
}

const WASM_HASH_RE = /^[0-9a-fA-F]{64}$/;

export function ContractUpgrade({ contractId, walletAddress }: Props) {
  const { network } = useNetwork();
  const { status, setStatus, clearStatus } = useFormStatus();
  const [wasmHash, setWasmHash] = useState("");
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!contractId) return;
    api
      .getContractVersion(contractId)
      .then((res) => setCurrentVersion(res.data.version))
      .catch(() => setCurrentVersion(null));
  }, [contractId]);

  const wasmHashError =
    wasmHash && !WASM_HASH_RE.test(wasmHash)
      ? "WASM hash must be a 64-character hex string"
      : null;

  const canSubmit =
    !!contractId && !!walletAddress && WASM_HASH_RE.test(wasmHash) && !loading;

  async function handleUpgrade(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setStatus("info", "Building upgrade transaction…");

    try {
      const res = await api.upgradeContract({ contractId, walletAddress, wasmHash });

      setStatus("info", "Signing transaction with Freighter…");
      const hash = await signAndSubmitTransaction(res.xdr, network);

      setStatus("ok", `Contract upgraded successfully. TX: ${hash.slice(0, 12)}…`);
      setWasmHash("");

      // Re-fetch version after upgrade
      api
        .getContractVersion(contractId)
        .then((r) => setCurrentVersion(r.data.version))
        .catch(() => {});
    } catch (e: unknown) {
      setStatus("error", e instanceof Error ? e.message : "Upgrade failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="card" onSubmit={handleUpgrade} aria-label="Contract upgrade form">
      <span className="badge">Contract Upgrade</span>

      {currentVersion && (
        <p className="description">
          Current on-chain version: <strong>{currentVersion}</strong>
        </p>
      )}

      <p className="description">
        Replace the contract WASM without redeployment. All collaborator shares,
        admin settings, and distribution history are preserved.
      </p>

      <label htmlFor="upgrade-wasm-hash">New WASM hash (64-char hex)</label>
      <input
        id="upgrade-wasm-hash"
        placeholder="e.g. a1b2c3d4e5f6..."
        value={wasmHash}
        autoComplete="off"
        spellCheck={false}
        disabled={loading}
        aria-invalid={wasmHashError ? "true" : undefined}
        aria-describedby={wasmHashError ? "upgrade-wasm-hash-error" : undefined}
        onChange={(e) => { setWasmHash(e.target.value); clearStatus(); }}
      />
      {wasmHashError && (
        <p className="field-error" id="upgrade-wasm-hash-error" role="alert">
          {wasmHashError}
        </p>
      )}

      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary btn-with-spinner"
          disabled={!canSubmit}
          aria-busy={loading}
        >
          {loading && <span className="btn-spinner" aria-hidden="true" />}
          {loading ? "Upgrading…" : "Upgrade contract"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => { setWasmHash(""); clearStatus(); }}
          disabled={loading || !wasmHash}
        >
          Clear
        </button>
      </div>

      {status && (
        <FormStatus
          type={status.type}
          message={status.message}
          network={network}
        />
      )}
    </form>
  );
}
