import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type TxPhase =
  | "idle"
  | "building"
  | "signing"
  | "confirming"
  | "confirmed"
  | "failed"
  | "timeout";

export interface TransactionEntry {
  transactionId: number | null;
  txHash: string | null;
  phase: TxPhase;
  label: string;
  errorMessage: string | null;
  updatedAt: number;
  confirmingStartedAt: number | null;
}

export interface TransactionsState {
  current: TransactionEntry | null;
  beginTransaction: () => void;
  updatePhase: (
    phase: TxPhase,
    opts?: { label?: string; txHash?: string; transactionId?: number; error?: string },
  ) => void;
  reset: () => void;
}

export const PHASE_LABELS: Record<TxPhase, string> = {
  idle: "",
  building: "Building transaction…",
  signing: "Signing with Freighter…",
  confirming: "Waiting for confirmation…",
  confirmed: "Distribution confirmed",
  failed: "Transaction failed",
  timeout: "Confirmation timed out",
};

export const ESTIMATED_CONFIRMATION_SECS = 10;

export const useTransactionStore = create<TransactionsState>()(
  devtools(
    (set) => ({
      current: null,

      beginTransaction: () => {
        set(
          {
            current: {
              transactionId: null,
              txHash: null,
              phase: "building",
              label: PHASE_LABELS["building"],
              errorMessage: null,
              updatedAt: Date.now(),
              confirmingStartedAt: null,
            },
          },
          false,
          "transactions/beginTransaction",
        );
      },

      updatePhase: (phase, opts = {}) => {
        set(
          (state) => {
            if (!state.current) return state;
            return {
              current: {
                ...state.current,
                phase,
                label: opts.label ?? PHASE_LABELS[phase],
                txHash: opts.txHash ?? state.current.txHash,
                transactionId: opts.transactionId ?? state.current.transactionId,
                errorMessage: opts.error ?? state.current.errorMessage,
                updatedAt: Date.now(),
                confirmingStartedAt:
                  phase === "confirming" && !state.current.confirmingStartedAt
                    ? Date.now()
                    : state.current.confirmingStartedAt,
              },
            };
          },
          false,
          "transactions/updatePhase",
        );
      },

      reset: () => {
        set({ current: null }, false, "transactions/reset");
      },
    }),
    { name: "TransactionsStore" },
  ),
);
