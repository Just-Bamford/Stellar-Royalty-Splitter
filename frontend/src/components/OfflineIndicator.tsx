import { useEffect, useState } from "react";
import { isOnline, watchConnectivity } from "../lib/registerServiceWorker";
import { useOfflineQueue } from "../hooks/useOfflineQueue";

/**
 * OfflineIndicator (#522 / #771 / #830)
 *
 * Fixed-position banner shown whenever the browser is offline or there are
 * writes still pending sync after reconnecting. Shows the pending write
 * count as a badge and provides a "Clear queue" escape hatch to discard
 * stuck retries. Uses `role="status"` + `aria-live="polite"` so screen
 * readers announce the transition without interrupting current speech.
 *
 * Renders nothing when online with an empty queue.
 */
export function OfflineIndicator(): JSX.Element | null {
  const [online, setOnline] = useState<boolean>(isOnline());
  const { pendingCount, clearQueue } = useOfflineQueue();

  useEffect(() => {
    const handle = watchConnectivity(setOnline);
    return () => handle.stop();
  }, []);

  if (online && pendingCount === 0) return null;

  const bannerText = online
    ? `Syncing ${pendingCount} pending ${pendingCount === 1 ? "change" : "changes"}…`
    : `You're offline — writes will be queued and synced when you reconnect.${
        pendingCount > 0 ? ` (${pendingCount} pending)` : ""
      }`;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-indicator"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: online ? "#2563eb" : "#b45309",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        textAlign: "center",
        padding: "0.5rem 1rem",
        fontSize: "0.9rem",
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
        transition: "background 0.3s ease",
      }}
    >
      <span>{bannerText}</span>
      {pendingCount > 0 && (
        <button
          type="button"
          onClick={() => void clearQueue()}
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.6)",
            color: "#fff",
            borderRadius: "4px",
            padding: "0.15rem 0.5rem",
            fontSize: "0.8rem",
            cursor: "pointer",
          }}
        >
          Clear queue
        </button>
      )}
    </div>
  );
}
