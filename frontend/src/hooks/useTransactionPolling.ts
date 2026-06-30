/**
 * useTransactionPolling (#414)
 *
 * React wrapper around {@link pollTransactionStatus} that drives real-time
 * transaction confirmation in the UI. It owns an AbortController so polling is
 * cancelled automatically on unmount, exposes the latest observed status for
 * rendering, and optionally races a WebSocket subscription as a faster
 * fallback when a socket URL is configured.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  pollTransactionStatus,
  type PollOutcome,
  type PolledStatus,
  type TxStatus,
} from "../lib/transactionPolling";
import { subscribeTransactionStatus } from "../lib/transactionStatusSocket";

export interface UseTransactionPollingOptions {
  /** Optional ws(s):// endpoint enabling the real-time fallback. */
  wsUrl?: string;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface UseTransactionPollingResult {
  /** Most recent status observed, or null before polling starts. */
  status: PolledStatus | null;
  /** Terminal outcome of the last run, or null while in flight. */
  outcome: PollOutcome | null;
  isPolling: boolean;
  /** Begin polling a transaction hash; resolves with the terminal outcome. */
  poll: (txHash: string) => Promise<PollOutcome>;
  /** Abort any in-flight polling. */
  cancel: () => void;
}

export function useTransactionPolling(
  options: UseTransactionPollingOptions = {},
): UseTransactionPollingResult {
  const { wsUrl, intervalMs, timeoutMs } = options;
  const controllerRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<PolledStatus | null>(null);
  const [outcome, setOutcome] = useState<PollOutcome | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  // Cancel polling if the component unmounts mid-flight.
  useEffect(() => cancel, [cancel]);

  const poll = useCallback(
    async (txHash: string): Promise<PollOutcome> => {
      // Supersede any previous run.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setStatus(null);
      setOutcome(null);
      setIsPolling(true);

      const applyStatus = (next: PolledStatus) => setStatus(next);

      const pollRun = pollTransactionStatus({
        fetchStatus: async (signal) => {
          const res = await api.getTransactionDetails(txHash, signal);
          return res.data.status as TxStatus;
        },
        signal: controller.signal,
        intervalMs,
        timeoutMs,
        onUpdate: applyStatus,
      });

      const runners: Array<Promise<PollOutcome>> = [pollRun];

      // Optional WebSocket fallback: resolve early on a terminal push.
      if (wsUrl) {
        runners.push(
          subscribeTransactionStatus({
            url: wsUrl,
            txHash,
            signal: controller.signal,
            onStatus: applyStatus,
          })
            // The socket only resolves on a terminal status.
            .then((s): PollOutcome => (s === "failed" ? "failed" : "confirmed"))
            // If the socket fails, let polling decide the outcome.
            .catch(() => pollRun),
        );
      }

      try {
        const result = await Promise.race(runners);
        setOutcome(result);
        return result;
      } finally {
        setIsPolling(false);
        if (controllerRef.current === controller) {
          controller.abort(); // stop the loser of the race
          controllerRef.current = null;
        }
      }
    },
    [wsUrl, intervalMs, timeoutMs],
  );

  return { status, outcome, isPolling, poll, cancel };
}
