import React, { useState } from "react";
import { api } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import FormStatus from "./FormStatus";
import { useFormStatus } from "../hooks/useFormStatus";


interface Collaborator {
  address: string;
  basisPoints: string;
}

interface Props {
  contractId: string;
  walletAddress: string;
  onSuccess: () => void;
}

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export default function InitializeForm({
  contractId,
  walletAddress,
  onSuccess,
}: Props) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([
    { address: "", basisPoints: "" },
  ]);
  const [errors, setErrors] = useState<
    Record<number, { address?: string; basisPoints?: string }>
  >({});
  const { status, setStatus } = useFormStatus();
  const [loading, setLoading] = useState(false);

  function update(i: number, field: keyof Collaborator, value: string) {
    setCollaborators((prev: Collaborator[]) =>
      prev.map((c: Collaborator, idx: number) => (idx === i ? { ...c, [field]: value } : c)),
    );
  }

  function validateRow(
    i: number,
    field: "address" | "basisPoints",
    value: string,
  ) {
    const rowErrors = { ...errors };
    if (field === "address") {
      if (value && !STELLAR_ADDRESS_RE.test(value)) {
        rowErrors[i] = {
          ...rowErrors[i],
          address: "Must be a valid Stellar address (G..., 56 chars)",
        };
      } else {
        const { address: _, ...rest } = rowErrors[i] ?? {};
        rowErrors[i] = rest;
      }
    }
    setErrors(rowErrors);
  }

  function handleBlur(i: number, field: "address" | "basisPoints", value: string) {
    validateRow(i, field, value);
  }

  function addRow() {
    setCollaborators((prev: Collaborator[]) => [...prev, { address: "", basisPoints: "" }]);
  }

  function removeRow(i: number) {
    setCollaborators((prev: Collaborator[]) => prev.filter((_: Collaborator, idx: number) => idx !== i));
    setErrors((prev: Record<number, { address?: string; basisPoints?: string }>) => {
      const next: Record<number, { address?: string; basisPoints?: string }> = {};
      Object.entries(prev).forEach(([key, val]) => {
        const k = parseInt(key);
        if (k < i) next[k] = val;
        else if (k > i) next[k - 1] = val;
      });
      return next;
    });
  }

  const total = collaborators.reduce(
    (sum: number, c: Collaborator) => sum + (parseInt(c.basisPoints) || 0),
    0,
  );

  const hasErrors = Object.values(errors).some((e) => (e as { address?: string; basisPoints?: string })?.address || (e as { address?: string; basisPoints?: string })?.basisPoints);
  const hasEmptyFields = collaborators.some((c: Collaborator) => !c.address || !c.basisPoints);

  async function submit() {
    if (!contractId)
      return setStatus("error", "Enter a contract ID first.");
    if (total !== 10_000)
      return setStatus("error", `Shares must sum to 10,000 bp (currently ${total}).`);

    const addresses = collaborators.map((c: Collaborator) => c.address);
    const hasDuplicates = new Set(addresses).size !== addresses.length;
    if (hasDuplicates) {
      return setStatus("error", "Duplicate addresses are not allowed.");
    }

    setLoading(true);
    setStatus("info", "Building transaction…");

    try {
      const res = await api.initialize({
        contractId,
        walletAddress,
        collaborators: addresses,
        shares: collaborators.map((c: Collaborator) => parseInt(c.basisPoints)),
      });

      setStatus("info", "Signing transaction with Freighter...");
      const hash = await signAndSubmitTransaction(res.xdr);

      setStatus("info", "Waiting for confirmation...");
      await api.confirmTransaction(hash, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      setStatus("ok", `Initialized. Tx: ${hash}`);
      onSuccess();

    } catch (e: unknown) {
      // Handle 409 Conflict error specifically
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      if (errorMessage.includes('409') || errorMessage.includes('already initialized')) {
        setStatus("error", "⚠️ This contract is already initialized. You cannot re-initialize an existing contract.");
      } else {
        setStatus("error", errorMessage);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <span className="badge">Initialize</span>

      {collaborators.map((c: Collaborator, i: number) => (
        <div key={i}>
          <div className="collaborator-row">
            <div style={{ flex: 3, display: "flex", flexDirection: "column" }}>
              <input
                placeholder="Wallet address (G...)"
                value={c.address}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => update(i, "address", e.target.value)}
                onBlur={(e: React.FocusEvent<HTMLInputElement>) => handleBlur(i, "address", e.target.value)}
                style={{ marginBottom: errors[i]?.address ? "0.25rem" : undefined }}
              />
              {errors[i]?.address && (
                <span className="field-error">{errors[i].address}</span>
              )}
            </div>
            <input
              placeholder="Basis pts"
              type="number"
              min={1}
              max={10000}
              value={c.basisPoints}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => update(i, "basisPoints", e.target.value)}
              onBlur={(e: React.FocusEvent<HTMLInputElement>) => handleBlur(i, "basisPoints", e.target.value)}
              style={{ flex: 1 }}
            />
            {collaborators.length > 1 && (
              <button className="btn-danger" onClick={() => removeRow(i)}>
                ✕
              </button>
            )}
          </div>
        </div>
      ))}

      <div className={`share-total ${total === 10_000 ? "share-total--valid" : "share-total--invalid"}`}>
        Total: {total} / 10,000 bp ({(total / 100).toFixed(2)}%)
      </div>

      <div className="row">
        <button className="btn-add" onClick={addRow}>
          + Add collaborator
        </button>
        <button
          className="btn-primary"
          onClick={submit}
          disabled={loading || hasErrors || hasEmptyFields}
        >
          {loading ? "Submitting…" : "Initialize contract"}
        </button>
      </div>

      {status && <FormStatus type={status.type} message={status.message} />}
    </div>
  );
}
