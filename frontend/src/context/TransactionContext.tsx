/**
 * TransactionContext (#391)
 *
 * Provides optimistic transaction state across the app.
 * Each in-flight or recently-completed transaction is tracked here so any
 * component can read the current status without prop-drilling.
 *
 * States:  idle → building → signing → confirming → confirmed | failed | timeout
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

export type TxPhase =
  | "idle"
  | "building"
  | "signing"
  | "confirming"
  | "confirmed"
  | "failed"
  | "timeout";

export interface TransactionEntry {
  /** Internal tracking ID returned by the API */
  transactionId: number | null;
  /** On-chain hash — available after signing */
  txHash: string | null;
  phase: TxPhase;
  /** Human-readable status label */
  label: string;
  /** Error message when phase === "failed" */
  errorMessage: string | null;
  /** Epoch ms when this entry was last updated */
  updatedAt: number;
  /** Epoch ms when the transaction entered "confirming" phase */
  confirmingStartedAt: number | null;
}

interface TransactionContextValue {
  /** Most-recent transaction entry (or null when nothing is in flight) */
  current: TransactionEntry | null;
  /** Start tracking a new distribute transaction */
  beginTransaction: () => void;
  /** Move to a new phase with an optional label override */
  updatePhase: (phase: TxPhase, opts?: { label?: string; txHash?: string; transactionId?: number; error?: string }) => void;
  /** Reset to idle */
  reset: () => void;
}

const TransactionContext = createContext<TransactionContextValue | undefined>(undefined);

const PHASE_LABELS: Record<TxPhase, string> = {
  idle: "",
  building: "Building transaction…",
  signing: "Signing with Freighter…",
  confirming: "Waiting for confirmation…",
  confirmed: "Distribution confirmed",
  failed: "Transaction failed",
  timeout: "Confirmation timed out",
};

/** Estimated seconds for Stellar testnet confirmation */
export const ESTIMATED_CONFIRMATION_SECS = 10;

export const TransactionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [current, setCurrent] = useState<TransactionEntry | null>(null);
  // Guard: prevent re-submitting while a transaction is in flight
  const inFlightRef = useRef(false);

  const beginTransaction = useCallback(() => {
    inFlightRef.current = true;
    setCurrent({
      transactionId: null,
      txHash: null,
      phase: "building",
      label: PHASE_LABELS["building"],
      errorMessage: null,
      updatedAt: Date.now(),
      confirmingStartedAt: null,
    });
  }, []);

  const updatePhase = useCallback(
    (
      phase: TxPhase,
      opts: { label?: string; txHash?: string; transactionId?: number; error?: string } = {},
    ) => {
      if (phase === "confirmed" || phase === "failed" || phase === "timeout") {
        inFlightRef.current = false;
      }
      setCurrent((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          phase,
          label: opts.label ?? PHASE_LABELS[phase],
          txHash: opts.txHash ?? prev.txHash,
          transactionId: opts.transactionId ?? prev.transactionId,
          errorMessage: opts.error ?? prev.errorMessage,
          updatedAt: Date.now(),
          confirmingStartedAt:
            phase === "confirming" && !prev.confirmingStartedAt
              ? Date.now()
              : prev.confirmingStartedAt,
        };
      });
    },
    [],
  );

  const reset = useCallback(() => {
    inFlightRef.current = false;
    setCurrent(null);
  }, []);

  return (
    <TransactionContext.Provider value={{ current, beginTransaction, updatePhase, reset }}>
      {children}
    </TransactionContext.Provider>
  );
};

export function useTransaction(): TransactionContextValue {
  const ctx = useContext(TransactionContext);
  if (!ctx) throw new Error("useTransaction must be used within TransactionProvider");
  return ctx;
}

/** Returns true when a transaction is actively in-flight (building/signing/confirming) */
export function useIsTransactionInFlight(): boolean {
  const { current } = useTransaction();
  return (
    current !== null &&
    (current.phase === "building" ||
      current.phase === "signing" ||
      current.phase === "confirming")
  );
}
