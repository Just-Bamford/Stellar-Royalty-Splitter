import { useState, useCallback } from "react";

export type TxStage =
  | "idle"
  | "awaiting_wallet"
  | "submitting"
  | "confirming"
  | "confirmed"
  | "failed";

export interface TxLifecycleState {
  stage: TxStage;
  errorMessage: string | null;
  txHash: string | null;
}

const INITIAL: TxLifecycleState = {
  stage: "idle",
  errorMessage: null,
  txHash: null,
};

export function useTransactionLifecycle() {
  const [state, setState] = useState<TxLifecycleState>(INITIAL);

  const setStage = useCallback((stage: TxStage) => {
    setState((prev: TxLifecycleState) => ({ ...prev, stage, errorMessage: null }));
  }, []);

  const setFailed = useCallback((errorMessage: string) => {
    setState((prev: TxLifecycleState) => ({ ...prev, stage: "failed" as TxStage, errorMessage }));
  }, []);

  const setConfirmed = useCallback((txHash: string) => {
    setState({ stage: "confirmed", txHash, errorMessage: null });
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL);
  }, []);

  const retry = useCallback(() => {
    setState(INITIAL);
  }, []);

  const isActive = state.stage !== "idle" && state.stage !== "confirmed" && state.stage !== "failed";

  return { state, setStage, setFailed, setConfirmed, reset, retry, isActive };
}
