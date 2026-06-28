import React, { useEffect, useMemo, useState } from "react";
import { api, type CollaboratorSuggestion } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
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
const MAX_COLLABORATORS = 50;
const PERCENTAGE_INPUT_RE = /^(\d+(\.\d*)?|\.\d+)?$/;
const SIGNED_PERCENTAGE_INPUT_RE = /^-(\d+(\.\d*)?|\.\d+)$/;
const PERCENTAGE_NAVIGATION_KEYS = [
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "Enter",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
];

function getPercentageError(value: string) {
  if (value === "") return "Percentage is required.";
  if (SIGNED_PERCENTAGE_INPUT_RE.test(value)) {
    return "Percentage must be between 0 and 100.";
  }
  if (!PERCENTAGE_INPUT_RE.test(value)) return "Percentage must be a number.";

  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) return "Percentage must be a number.";
  if (numericValue < 0 || numericValue > 100) {
    return "Percentage must be between 0 and 100.";
  }

  return "";
}

function isAllowedPercentageInput(value: string) {
  return PERCENTAGE_INPUT_RE.test(value);
}

function updatePercentageError(
  setErrors: React.Dispatch<
    React.SetStateAction<Record<number, { address?: string; basisPoints?: string }>>
  >,
  i: number,
  error: string,
) {
  setErrors((prev) => ({
    ...prev,
    [i]: {
      ...prev[i],
      basisPoints: error,
    },
  }));
}

function handlePercentageKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
  if (
    event.ctrlKey ||
    event.metaKey ||
    PERCENTAGE_NAVIGATION_KEYS.includes(event.key)
  ) {
    return;
  }

  if (!/^[0-9.]$/.test(event.key)) {
    event.preventDefault();
    return;
  }

  if (event.key === "." && event.currentTarget.value.includes(".")) {
    event.preventDefault();
  }
}

export default function InitializeForm({
  contractId,
  walletAddress,
  onSuccess,
}: Props) {
  const { network } = useNetwork();
  const [collaborators, setCollaborators] = useState<Collaborator[]>([
    { address: "", basisPoints: "" },
  ]);
  const [errors, setErrors] = useState<
    Record<number, { address?: string; basisPoints?: string }>
  >({});
  const { status, setStatus } = useFormStatus();
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Record<number, CollaboratorSuggestion[]>>({});
  const [focusedAddressIndex, setFocusedAddressIndex] = useState<number | null>(null);
  const [lookupLoading, setLookupLoading] = useState<Record<number, boolean>>({});

  const selectedAddresses = useMemo(
    () => new Set(collaborators.map((c) => c.address.trim()).filter(Boolean)),
    [collaborators],
  );

  useEffect(() => {
    const timers = collaborators.map((collaborator, index) => {
      const query = collaborator.address.trim();
      setLookupLoading((prev) => ({ ...prev, [index]: true }));

      return window.setTimeout(async () => {
        try {
          const result = await api.lookupCollaborators(query, 8);
          setSuggestions((prev) => ({
            ...prev,
            [index]: result.suggestions.filter(
              (suggestion) => suggestion.address === query || !selectedAddresses.has(suggestion.address),
            ),
          }));
        } catch {
          setSuggestions((prev) => ({ ...prev, [index]: [] }));
        } finally {
          setLookupLoading((prev) => ({ ...prev, [index]: false }));
        }
      }, 250);
    });

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [collaborators, selectedAddresses]);

  function update(i: number, field: keyof Collaborator, value: string) {
    setCollaborators((prev: Collaborator[]) =>
      prev.map((c: Collaborator, idx: number) => (idx === i ? { ...c, [field]: value } : c)),
    );
  }

  function selectSuggestion(i: number, address: string) {
    update(i, "address", address);
    validateRow(i, "address", address);
    setFocusedAddressIndex(null);
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
    if (field === "basisPoints") {
      const percentageError = getPercentageError(value);
      if (percentageError) {
        rowErrors[i] = {
          ...rowErrors[i],
          basisPoints: percentageError,
        };
      } else {
        const { basisPoints: _, ...rest } = rowErrors[i] ?? {};
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
    (sum: number, c: Collaborator) => sum + (parseFloat(c.basisPoints) || 0),
    0,
  );

  const hasErrors = Object.values(errors).some((e) => (e as { address?: string; basisPoints?: string })?.address || (e as { address?: string; basisPoints?: string })?.basisPoints);
  const hasEmptyFields = collaborators.some((c: Collaborator) => !c.address || !c.basisPoints);
  const hasInvalidPercentages = collaborators.some((c: Collaborator) => getPercentageError(c.basisPoints));

  async function submit() {
    if (!contractId)
      return setStatus("error", "Enter a contract ID first.");
    const nextErrors = collaborators.reduce<
      Record<number, { address?: string; basisPoints?: string }>
    >((acc, c, i) => {
      if (!c.address || !STELLAR_ADDRESS_RE.test(c.address)) {
        acc[i] = {
          ...acc[i],
          address: "Must be a valid Stellar address (G..., 56 chars)",
        };
      }

      const percentageError = getPercentageError(c.basisPoints);
      if (percentageError) {
        acc[i] = {
          ...acc[i],
          basisPoints: percentageError,
        };
      }

      return acc;
    }, {});
    if (Object.keys(nextErrors).length > 0) {
      setErrors((prev) => ({ ...prev, ...nextErrors }));
      return setStatus("error", "Please fix all field errors before submitting.");
    }
    if (Math.round(total * 100) !== 10_000)
      return setStatus("error", `Percentages must sum to 100% (currently ${total.toFixed(2)}%).`);

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
        shares: collaborators.map((c: Collaborator) => Math.round(parseFloat(c.basisPoints) * 100)),
      });

      setStatus("info", "Signing transaction with Freighter...");
      const hash = await signAndSubmitTransaction(res.xdr, network);

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
              <div className="autocomplete-field">
              <input
                placeholder="Wallet address (G...)"
                value={c.address}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={focusedAddressIndex === i && (suggestions[i]?.length ?? 0) > 0}
                aria-controls={`collaborator-${i}-suggestions`}
                aria-label={`Wallet address for collaborator ${i + 1}`}
                aria-invalid={Boolean(errors[i]?.address)}
                aria-describedby={errors[i]?.address ? `collaborator-${i}-address-error` : `collaborator-${i}-lookup-help`}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => update(i, "address", e.target.value)}
                onFocus={() => setFocusedAddressIndex(i)}
                onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
                  handleBlur(i, "address", e.target.value);
                  window.setTimeout(() => setFocusedAddressIndex(null), 150);
                }}
                style={{ marginBottom: errors[i]?.address ? "0.25rem" : undefined }}
              />
              <span id={`collaborator-${i}-lookup-help`} className="sr-only">
                Start typing to search previous collaborators. Suggestions are filtered to avoid duplicate addresses.
              </span>
              {focusedAddressIndex === i && (suggestions[i]?.length ?? 0) > 0 && (
                <ul
                  id={`collaborator-${i}-suggestions`}
                  className="autocomplete-list"
                  role="listbox"
                  aria-label={`Collaborator suggestions for row ${i + 1}`}
                >
                  {suggestions[i].map((suggestion) => (
                    <li key={suggestion.address} role="option" aria-selected={false}>
                      <button
                        type="button"
                        className="autocomplete-option"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectSuggestion(i, suggestion.address)}
                      >
                        <span>{suggestion.label}</span>
                        <small>{suggestion.sources.includes("initialize_history") ? "History" : "Payout"}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {focusedAddressIndex === i && lookupLoading[i] && (
                <span className="autocomplete-loading" aria-live="polite">Searching collaborators…</span>
              )}
              </div>
              {errors[i]?.address && (
                <span id={`collaborator-${i}-address-error`} className="field-error">{errors[i].address}</span>
              )}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              <input
                placeholder="% (0–100)"
                type="number"
                min={0}
                max={100}
                step="any"
                value={c.basisPoints}
                className={errors[i]?.basisPoints ? "input-error" : ""}
                aria-label={`Royalty percentage for collaborator ${i + 1}`}
                aria-invalid={Boolean(errors[i]?.basisPoints)}
                aria-describedby={errors[i]?.basisPoints ? `collaborator-${i}-percentage-error` : undefined}
                onKeyDown={handlePercentageKeyDown}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const { value } = e.target;
                  if (!isAllowedPercentageInput(value)) {
                    updatePercentageError(setErrors, i, getPercentageError(value));
                    return;
                  }
                  update(i, "basisPoints", value);
                  validateRow(i, "basisPoints", value);
                }}
                onBlur={(e: React.FocusEvent<HTMLInputElement>) => handleBlur(i, "basisPoints", e.target.value)}
                style={{ marginBottom: errors[i]?.basisPoints ? "0.25rem" : undefined }}
              />
              {errors[i]?.basisPoints && (
                <span id={`collaborator-${i}-percentage-error`} className="field-error">{errors[i].basisPoints}</span>
              )}
            </div>
            {collaborators.length > 1 && (
              <button className="btn-danger" onClick={() => removeRow(i)}>
                ✕
              </button>
            )}
          </div>
        </div>
      ))}

      <div className={`share-total ${Math.round(total * 100) === 10_000 ? "share-total--valid" : "share-total--invalid"}`}>
        Total: {total.toFixed(2)}% / 100%
      </div>

      {collaborators.length >= MAX_COLLABORATORS - 5 && collaborators.length < MAX_COLLABORATORS && (
        <div className="status info">
          Approaching the limit — max {MAX_COLLABORATORS} collaborators allowed ({MAX_COLLABORATORS - collaborators.length} remaining).
        </div>
      )}
      {collaborators.length >= MAX_COLLABORATORS && (
        <div className="status error">
          Maximum of {MAX_COLLABORATORS} collaborators reached. Remove one to add another.
        </div>
      )}

      <div className="row">
        <button className="btn-add" onClick={addRow} disabled={collaborators.length >= MAX_COLLABORATORS}>
          + Add collaborator
        </button>
        <button
          className="btn-primary"
          onClick={submit}
          disabled={loading || hasErrors || hasEmptyFields || hasInvalidPercentages}
        >
          {loading ? "Submitting…" : "Initialize contract"}
        </button>
      </div>

      {status && <FormStatus type={status.type} message={status.message} />}
    </div>
  );
}
