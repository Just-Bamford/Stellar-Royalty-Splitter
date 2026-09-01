import { useEffect, useRef, useCallback, useState } from "react";

interface WebSocketMessage {
  type: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface DistributionEvent {
  type: "distribution_completed" | "secondary_distribution_completed" | "secondary_sale_recorded";
  contractId: string;
  transactionId: string | number;
  timestamp: string;
  requestedAmount?: string | null;
  tokenId?: string | null;
  batch?: boolean;
  numberOfSales?: number;
  totalRoyalties?: string;
  nftId?: string;
  salePrice?: string;
  royaltyAmount?: string;
}

interface UseWebSocketOptions {
  walletAddress: string | null;
  onNotification?: (notification: unknown) => void;
  onDistributionEvent?: (event: DistributionEvent) => void;
  enabled?: boolean;
}

export function useWebSocket({ walletAddress, onNotification, onDistributionEvent, enabled = true }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const [connected, setConnected] = useState(false);
  const [lastPong, setLastPong] = useState<number>(Date.now());

  const connect = useCallback(() => {
    if (!walletAddress || !enabled) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const url = `${protocol}//${host}/ws`;

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: "subscribe", walletAddress }));
      };

      ws.onmessage = (event) => {
        try {
          const msg: WebSocketMessage = JSON.parse(event.data);
          if (msg.type === "pong") {
            setLastPong(Date.now());
          } else if (msg.type === "notification" && onNotification) {
            onNotification(msg.data);
          } else if (msg.type === "finality_update" && onNotification) {
            const update = msg.data as { transactionId: number; txHash: string; status: string; errorMessage?: string };
            onNotification({
              type: update.status === "confirmed" ? "confirmed" : update.status === "failed" ? "failed" : "info",
              title: update.status === "confirmed" ? "Transaction Confirmed" : update.status === "failed" ? "Transaction Failed" : "Transaction Timeout",
              message: update.status === "confirmed" ? `Transaction ${update.txHash.slice(0, 8)}... confirmed` : update.errorMessage || "Transaction failed",
              txHash: update.txHash,
              transactionId: update.transactionId,
            });
          } else if (msg.type === "transaction_status" && onNotification) {
            const update = msg.data as { id: string | number; status: string; errorMessage?: string };
            onNotification({
              type: update.status === "pending" ? "pending" : update.status === "failed" ? "failed" : "info",
              title: update.status === "pending" ? "Transaction Pending" : "Transaction Status",
              message: update.status === "pending" ? "Your transaction is pending on-chain..." : `Transaction status: ${update.status}`,
              transactionId: update.id,
            });
          } else if (msg.type === "subscribed") {
            setConnected(true);
          }

          // Handle distribution events for real-time earnings updates
          if (msg.type === "notification" && onDistributionEvent) {
            const data = msg.data as Record<string, unknown>;
            if (
              data.type === "distribution_completed" ||
              data.type === "secondary_distribution_completed" ||
              data.type === "secondary_sale_recorded"
            ) {
              onDistributionEvent(data as unknown as DistributionEvent);
            }
          }
        } catch {
          /* ignore parse errors */
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (enabled && walletAddress) {
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    } catch {
      /* connection error */
    }
  }, [walletAddress, enabled, onNotification, onDistributionEvent]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((message: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const ping = useCallback(() => {
    send({ type: "ping" });
  }, [send]);

  return { connected, send, ping, lastPong };
}
