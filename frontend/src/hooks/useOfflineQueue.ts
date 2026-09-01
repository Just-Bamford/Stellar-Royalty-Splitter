import { useCallback, useEffect, useState } from "react";
import {
  clearQueue,
  getQueueCount,
  subscribeToQueueUpdates,
} from "../lib/offlineQueue";

/**
 * Live pending-write count for the offline queue (#771 / #830), plus a
 * manual clear action for the "Clear queue" control in the offline indicator.
 *
 * Reads the queue count from IndexedDB directly on mount (so the badge is
 * accurate before the first SW broadcast), then stays live via the
 * `srs-queue-updated` subscription from `subscribeToQueueUpdates`.
 */
export function useOfflineQueue() {
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Prime the count immediately from IndexedDB.
    getQueueCount().then((count) => {
      if (!cancelled) setPendingCount(count);
    });

    // Stay live via SW broadcast messages.
    const unsubscribe = subscribeToQueueUpdates((count) => {
      if (!cancelled) setPendingCount(count);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const clear = useCallback(async () => {
    await clearQueue();
    setPendingCount(0);
  }, []);

  return { pendingCount, clearQueue: clear };
}
