/**
 * Optional WebSocket fallback for transaction confirmation (#414)
 *
 * When a WebSocket URL is configured, this subscribes to real-time transaction
 * status messages so the UI can react the moment the backend surfaces a
 * webhook event, without waiting for the next poll tick. It is strictly a
 * fallback: if the socket never connects or errors, the polling loop continues
 * to drive the UI, so the feature degrades gracefully.
 *
 * Expected message shape (JSON):
 *   { "txHash": "<hash>", "status": "confirmed" | "failed" | "pending" }
 */
import type { TxStatus } from "./transactionPolling";

export interface SubscribeOptions {
  /** ws:// or wss:// endpoint. */
  url: string;
  /** Only resolve for messages matching this hash. */
  txHash: string;
  /** Aborts the subscription (closes the socket). */
  signal?: AbortSignal;
  /** Called for every matching status message. */
  onStatus?: (status: TxStatus) => void;
}

/**
 * Resolves with the first terminal status ("confirmed" | "failed") received for
 * the given hash, or rejects if the socket closes/errors before that. Callers
 * race this against {@link pollTransactionStatus}.
 */
export function subscribeTransactionStatus(
  options: SubscribeOptions,
): Promise<TxStatus> {
  const { url, txHash, signal, onStatus } = options;

  return new Promise<TxStatus>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    if (typeof WebSocket === "undefined") {
      reject(new Error("WebSocket is not available in this environment"));
      return;
    }

    const socket = new WebSocket(url);

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      // readyState 0 = CONNECTING, 1 = OPEN
      if (socket.readyState <= WebSocket.OPEN) socket.close();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort);

    socket.addEventListener("open", () => {
      // Some backends expect a subscribe frame naming the hash of interest.
      try {
        socket.send(JSON.stringify({ type: "subscribe", txHash }));
      } catch {
        // Non-fatal: server may push without an explicit subscribe.
      }
    });

    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          txHash?: string;
          status?: TxStatus;
        };
        if (data.txHash && data.txHash !== txHash) return;
        if (data.status === "pending") {
          onStatus?.("pending");
          return;
        }
        if (data.status === "confirmed" || data.status === "failed") {
          onStatus?.(data.status);
          cleanup();
          resolve(data.status);
        }
      } catch {
        // Ignore malformed frames; polling remains the source of truth.
      }
    });

    socket.addEventListener("error", () => {
      cleanup();
      reject(new Error("Transaction status socket error"));
    });

    socket.addEventListener("close", () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Transaction status socket closed"));
    });
  });
}
