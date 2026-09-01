import React, { createContext, useContext } from "react";
import {
  useTransactionStore,
  TxPhase,
  TransactionEntry,
  ESTIMATED_CONFIRMATION_SECS,
} from "../store/transactionsStore";

export type { TxPhase, TransactionEntry };
export { ESTIMATED_CONFIRMATION_SECS };

interface TransactionContextValue {
  current: TransactionEntry | null;
  beginTransaction: () => void;
  updatePhase: (
    phase: TxPhase,
    opts?: { label?: string; txHash?: string; transactionId?: number; error?: string },
  ) => void;
  reset: () => void;
}

const TransactionContext = createContext<TransactionContextValue | undefined>(undefined);

export const TransactionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const current = useTransactionStore((s) => s.current);
  const beginTransaction = useTransactionStore((s) => s.beginTransaction);
  const updatePhase = useTransactionStore((s) => s.updatePhase);
  const reset = useTransactionStore((s) => s.reset);

  return (
    <TransactionContext.Provider value={{ current, beginTransaction, updatePhase, reset }}>
      {children}
    </TransactionContext.Provider>
  );
};

export function useTransaction(): TransactionContextValue {
  const context = useContext(TransactionContext);
  const current = useTransactionStore((s) => s.current);
  const beginTransaction = useTransactionStore((s) => s.beginTransaction);
  const updatePhase = useTransactionStore((s) => s.updatePhase);
  const reset = useTransactionStore((s) => s.reset);

  if (context) {
    return context;
  }
  return { current, beginTransaction, updatePhase, reset };
}

export function useIsTransactionInFlight(): boolean {
  const { current } = useTransaction();
  return (
    current !== null &&
    (current.phase === "building" ||
      current.phase === "signing" ||
      current.phase === "confirming")
  );
}
