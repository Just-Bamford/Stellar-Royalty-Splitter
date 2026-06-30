import React, { useEffect, useMemo, useState } from "react";
import { api, type CollaboratorSuggestion } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import { useNetwork } from "../context/NetworkContext";
import FormStatus from "./FormStatus";
import FormInput from "./FormInput";
import { useFormStatus } from "../hooks/useFormStatus";
import {
  bytesToHex,
  generateInitNonce,
  generateInitSalt,
  hashCollaborators,
  hashShares,
  INIT_COMMIT_STORAGE_KEY,
  type InitCommitState,
} from "../lib/init-commitment";


type InitPhase = "form" | "committed";

function loadCommitState(contractId: string): InitCommitState | null {
  try {
    const raw = localStorage.getItem(INIT_COMMIT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as InitCommitState;
    return parsed.contractId === contractId ? parsed : null;
  } catch {
    return null;
  }
}

interface Collaborator {
  address: string;
  basisPoints: string;
}

type CollaboratorField = "address" | "basisPoints";
type FieldErrors = Record<number, { address?: string; basisPoints?: string }>;

interface Props {
  contractId: string;
  walletAddress: string;
  onSuccess: () => void;
}

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const MAX_COLLABORATORS = 50;
const BASIS_POINTS_TOTAL = 10_000;
const VALIDATION_DEBOUNCE_MS = 300;
const VALIDATION_CACHE_LIMIT = 500;
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
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) return "Percentage must be a number.";
  if (numericValue < 0 || numericValue > 100) {
    return "Percentage must be between 0 and 100.";
  }

  const basisPoints = Number((numericValue * 100).toFixed(4));
  if (!Number.isInteger(basisPoints)) {
    return "Fractional basis points are not allowed.";
  }

  return "";
}

function isAllowedPercentageInput(value: string) {
  return PERCENTAGE_INPUT_RE.test(value);
}

function parsePercentageToBasisPoints(value: string) {
  const error = getPercentageError(value);
  if (error) return null;
  return Number((Number(value) * 100).toFixed(4));
}

function formatBasisPointsAsPercent(basisPoints: number) {
  return (basisPoints / 100).toFixed(2);
}

function calculateShareSummary(collaborators: Collaborator[]) {
  const allocatedBasisPoints = collaborators.reduce((sum, collaborator) => {
    return sum + (parsePercentageToBasisPoints(collaborator.basisPoints) ?? 0);
  }, 0);
  const remainingBasisPoints = BASIS_POINTS_TOTAL - allocatedBasisPoints;

  return {
    allocatedBasisPoints,
    remainingBasisPoints,
    progressPercent: Math.min(100, Math.max(0, allocatedBasisPoints / 100)),
    isComplete: allocatedBasisPoints === BASIS_POINTS_TOTAL,
    isOverAllocated: allocatedBasisPoints > BASIS_POINTS_TOTAL,
  };
}

function calculateEvenSplit(collaboratorCount: number) {
  const baseShare = Math.floor(BASIS_POINTS_TOTAL / collaboratorCount);
  const remainder = BASIS_POINTS_TOTAL % collaboratorCount;

  return Array.from({ length: collaboratorCount }, (_, index) =>
    formatBasisPointsAsPercent(baseShare + (index < remainder ? 1 : 0)),
  );
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

function getFieldValidationError(field: CollaboratorField, value: string) {
  if (field === "address") {
    return value && !STELLAR_ADDRESS_RE.test(value)
      ? "Must be a valid Stellar address (G..., 56 chars)"
      : "";
  }

  return getPercentageError(value);
}

function setFieldError(
  setErrors: React.Dispatch<React.SetStateAction<FieldErrors>>,
  i: number,
  field: CollaboratorField,
  error: string,
) {
  setErrors((prev) => {
    const nextRow = { ...(prev[i] ?? {}) };

    if (error) {
      nextRow[field] = error;
    } else {
      delete nextRow[field];
    }

    const next = { ...prev };
    if (nextRow.address || nextRow.basisPoints) {
      next[i] = nextRow;
    } else {
      delete next[i];
    }

    return next;
  });
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
  const [errors, setErrors] = useState<FieldErrors>({});
  const { status, setStatus } = useFormStatus();
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<InitPhase>("form");
  const [pendingCommit, setPendingCommit] = useState<InitCommitState | null>(null);
  const [suggestions, setSuggestions] = useState<Record<number, CollaboratorSuggestion[]>>({});
  const [focusedAddressIndex, setFocusedAddressIndex] = useState<number | null>(null);
  const [lookupLoading, setLookupLoading] = useState<Record<number, boolean>>({});
  const validationTimers = React.useRef(new Map<string, number>());
  const validationCache = React.useRef(new Map<string, string>());

  const selectedAddresses = useMemo(
    () => new Set(collaborators.map((collaborator) => collaborator.address.trim()).filter(Boolean)),
    [collaborators],
  );

  useEffect(() => {
    const saved = loadCommitState(contractId);
    if (saved) {
      setPendingCommit(saved);
      setPhase("committed");
    }
  }, [contractId]);

  useEffect(() => {
    return () => {
      validationTimers.current.forEach((timer) => window.clearTimeout(timer));
      validationTimers.current.clear();
      validationCache.current.clear();
    };
  }, []);

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
    scheduleValidation(i, "address", address);
    setFocusedAddressIndex(null);
  }

  function getCachedFieldError(field: CollaboratorField, value: string) {
    const cacheKey = `${field}:${value}`;
    const cached = validationCache.current.get(cacheKey);
    if (cached !== undefined) return cached;

    const error = getFieldValidationError(field, value);
    validationCache.current.set(cacheKey, error);
    if (validationCache.current.size > VALIDATION_CACHE_LIMIT) {
      const oldestKey = validationCache.current.keys().next().value;
      if (oldestKey) validationCache.current.delete(oldestKey);
    }

    return error;
  }

  function scheduleValidation(
    i: number,
    field: CollaboratorField,
    value: string,
  ) {
    const fieldKey = `${i}:${field}`;
    const existingTimer = validationTimers.current.get(fieldKey);
    if (existingTimer) window.clearTimeout(existingTimer);

    const timer = window.setTimeout(() => {
      validationTimers.current.delete(fieldKey);
      setFieldError(setErrors, i, field, getCachedFieldError(field, value));
    }, VALIDATION_DEBOUNCE_MS);

    validationTimers.current.set(fieldKey, timer);
  }

  function handleBlur(i: number, field: CollaboratorField, value: string) {
    scheduleValidation(i, field, value);
  }

  function addRow() {
    setCollaborators((prev: Collaborator[]) => [...prev, { address: "", basisPoints: "" }]);
  }

  function removeRow(i: number) {
    setCollaborators((prev: Collaborator[]) => prev.filter((_: Collaborator, idx: number) => idx !== i));
    validationTimers.current.forEach((timer, key) => {
      const [rowIndex] = key.split(":");
      if (Number(rowIndex) >= i) {
        window.clearTimeout(timer);
        validationTimers.current.delete(key);
      }
    });
    setErrors((prev: FieldErrors) => {
      const next: FieldErrors = {};
      Object.entries(prev).forEach(([key, val]) => {
        const k = parseInt(key);
        if (k < i) next[k] = val;
        else if (k > i) next[k - 1] = val;
      });
      return next;
    });
  }

  function splitEvenly() {
    const evenShares = calculateEvenSplit(collaborators.length);
    setCollaborators((prev) =>
      prev.map((collaborator, index) => ({
        ...collaborator,
        basisPoints: evenShares[index],
      })),
    );
    validationTimers.current.forEach((timer, key) => {
      if (key.endsWith(":basisPoints")) {
        window.clearTimeout(timer);
        validationTimers.current.delete(key);
      }
    });
    setErrors((prev) => {
      const next = { ...prev };
      collaborators.forEach((_, index) => {
        const { basisPoints: _basisPoints, ...rest } = next[index] ?? {};
        next[index] = rest;
      });
      return next;
    });
  }

  const shareSummary = calculateShareSummary(collaborators);

  const hasErrors = Object.values(errors).some((e) => e?.address || e?.basisPoints);
  const hasEmptyFields = collaborators.some((c: Collaborator) => !c.address || !c.basisPoints);
  const hasInvalidPercentages = collaborators.some((c: Collaborator) => getPercentageError(c.basisPoints));
  const canSubmit =
    !loading &&
    !hasErrors &&
    !hasEmptyFields &&
    !hasInvalidPercentages &&
    shareSummary.isComplete;

  async function submit() {
    if (phase === "committed") {
      return reveal();
    }

    if (!contractId) return setStatus("error", "Enter a contract ID first.");
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
        acc[i] = { ...acc[i], basisPoints: percentageError };
      }
      return acc;
    }, {});
    if (Object.keys(nextErrors).length > 0) {
      setErrors((prev) => ({ ...prev, ...nextErrors }));
      return setStatus("error", "Please fix all field errors before submitting.");
    }
    if (!shareSummary.isComplete) {
      return setStatus("error", `Percentages must sum to 100% (currently ${formatBasisPointsAsPercent(shareSummary.allocatedBasisPoints)}%).`);
    }
    const addresses = collaborators.map((c: Collaborator) => c.address);
    if (new Set(addresses).size !== addresses.length) {
      return setStatus("error", "Duplicate addresses are not allowed.");
    }

    setLoading(true);
    setStatus("info", "Step 1/2: Committing initialization hashes…");
    try {
      const shares = collaborators.map((c: Collaborator) =>
        parsePercentageToBasisPoints(c.basisPoints) ?? 0,
      );
      const salt = generateInitSalt();
      const nonce = generateInitNonce();
      const collaboratorsHash = await hashCollaborators(addresses, salt);
      const sharesHash = await hashShares(shares, salt);
      const res = await api.commitInitialize({
        contractId,
        walletAddress,
        collaboratorsHash: bytesToHex(collaboratorsHash),
        sharesHash: bytesToHex(sharesHash),
        nonce: bytesToHex(nonce),
      });
      setStatus("info", "Signing commit transaction with Freighter...");
      const commitHash = await signAndSubmitTransaction(res.xdr, network);
      await api.confirmTransaction(
        commitHash,
        { status: "confirmed", blockTime: new Date().toISOString() },
        walletAddress,
      );
      const commitState: InitCommitState = {
        contractId,
        saltHex: bytesToHex(salt),
        nonceHex: bytesToHex(nonce),
        collaboratorsHashHex: bytesToHex(collaboratorsHash),
        sharesHashHex: bytesToHex(sharesHash),
        committedAt: new Date().toISOString(),
      };
      localStorage.setItem(INIT_COMMIT_STORAGE_KEY, JSON.stringify(commitState));
      setPendingCommit(commitState);
      setPhase("committed");
      setStatus(
        "ok",
        `Commit confirmed (${commitHash.slice(0, 8)}…). Wait at least 1 ledger, then reveal.`,
      );
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      setStatus("error", errorMessage);
    } finally {
      setLoading(false);
    }
  }

  async function reveal() {
    if (!pendingCommit) {
      return setStatus("error", "No pending commit found. Commit first.");
    }

    setLoading(true);
    setStatus("info", "Step 2/2: Revealing collaborators and initializing…");

    try {
      const addresses = collaborators.map((c: Collaborator) => c.address);
      const shares = collaborators.map((c: Collaborator) =>
        parsePercentageToBasisPoints(c.basisPoints) ?? 0,
      );

      const res = await api.revealInitialize({
        contractId,
        walletAddress,
        collaborators: addresses,
        shares,
        salt: pendingCommit.saltHex,
      });

      setStatus("info", "Signing reveal transaction with Freighter...");
      const hash = await signAndSubmitTransaction(res.xdr, network);
      await api.confirmTransaction(
        hash,
        { status: "confirmed", blockTime: new Date().toISOString() },
        walletAddress,
      );

      localStorage.removeItem(INIT_COMMIT_STORAGE_KEY);
      setPendingCommit(null);
      setPhase("form");
      setStatus("ok", `Initialized. Tx: ${hash}`);
      onSuccess();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      setStatus("error", errorMessage);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <span className="badge">Initialize</span>

      {phase === "committed" && (
        <div className="status info" role="status">
          Commit pending — wait at least 1 ledger (~5s), then reveal with the same
          collaborator data.
        </div>
      )}

      <div className="share-calculator-layout">
        <div className="share-editor">
          {collaborators.map((c: Collaborator, i: number) => {
            const percentageError = errors[i]?.basisPoints;
            const highlightShare = Boolean(percentageError) || shareSummary.isOverAllocated;

            return (
              <div key={i}>
                <div className="collaborator-row">
                  <div className="collaborator-address-field">
                    <div className="autocomplete-field">
                      <FormInput
                        placeholder="Wallet address (G...)"
                        value={c.address}
                        error={errors[i]?.address}
                        showSuccess={Boolean(c.address) && STELLAR_ADDRESS_RE.test(c.address) && !errors[i]?.address}
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded={focusedAddressIndex === i && (suggestions[i]?.length ?? 0) > 0}
                        aria-controls={`collaborator-${i}-suggestions`}
                        aria-label={`Wallet address for collaborator ${i + 1}`}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          update(i, "address", e.target.value);
                          scheduleValidation(i, "address", e.target.value);
                        }}
                        onFocus={() => setFocusedAddressIndex(i)}
                        onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
                          handleBlur(i, "address", e.target.value);
                          window.setTimeout(() => setFocusedAddressIndex(null), 150);
                        }}
                      />
                      <span id={`collaborator-${i}-lookup-help`} className="sr-only">
                        Start typing to search previous collaborators. Suggestions are filtered to avoid duplicate
                        addresses.
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
                        <span className="autocomplete-loading" aria-live="polite">
                          Searching collaborators...
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="collaborator-share-field">
                    <FormInput
                      placeholder="% (0–100)"
                      type="text"
                      inputMode="decimal"
                      min={0}
                      max={100}
                      step="any"
                      value={c.basisPoints}
                      className={highlightShare ? "input-error" : ""}
                      error={percentageError}
                      showSuccess={Boolean(c.basisPoints) && !percentageError && !getPercentageError(c.basisPoints)}
                      aria-label={`Royalty percentage for collaborator ${i + 1}`}
                      onKeyDown={handlePercentageKeyDown}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const { value } = e.target;
                        if (!isAllowedPercentageInput(value)) {
                          update(i, "basisPoints", value);
                          scheduleValidation(i, "basisPoints", value);
                          return;
                        }
                        update(i, "basisPoints", value);
                        scheduleValidation(i, "basisPoints", value);
                      }}
                      onBlur={(e: React.FocusEvent<HTMLInputElement>) => handleBlur(i, "basisPoints", e.target.value)}
                    />
                  </div>
                  {collaborators.length > 1 && (
                    <button className="btn-danger" onClick={() => removeRow(i)}>
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <aside className="share-calculator" aria-label="Collaborator share calculator">
          <div className="share-calculator__header">
            <strong>Share calculator</strong>
            <button
              type="button"
              className="btn-add share-calculator__split"
              onClick={splitEvenly}
            >
              Split Evenly
            </button>
          </div>
          <div
            className={`share-total ${shareSummary.isComplete ? "share-total--valid" : "share-total--invalid"}`}
            role="status"
            aria-live="polite"
            aria-label={`Share total: ${formatBasisPointsAsPercent(shareSummary.allocatedBasisPoints)}% of 100% required`}
            data-testid="share-total"
          >
            <span>Total allocated</span>
            <strong>{formatBasisPointsAsPercent(shareSummary.allocatedBasisPoints)}%</strong>
          </div>
          <div className="share-calculator__metric">
            <span>
              {shareSummary.isOverAllocated ? "Over allocated" : "Remaining"}
            </span>
            <strong>
              {formatBasisPointsAsPercent(Math.abs(shareSummary.remainingBasisPoints))}%
            </strong>
          </div>
          {shareSummary.isOverAllocated && (
            <p className="share-calculator__warning" role="alert">
              Shares exceed 100%.
            </p>
          )}
          <div className="share-progress" aria-hidden="true">
            <div
              data-testid="share-progress-bar"
              className={`share-progress__bar ${shareSummary.isOverAllocated ? "share-progress__bar--over" : ""}`}
              style={{ width: `${shareSummary.progressPercent}%` }}
            />
          </div>
        </aside>
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
          disabled={!canSubmit}
        >
          {loading
            ? "Submitting…"
            : phase === "committed"
              ? "Reveal & initialize"
              : "Commit initialization"}
        </button>
      </div>

      {status && <FormStatus type={status.type} message={status.message} />}
    </div>
  );
}
