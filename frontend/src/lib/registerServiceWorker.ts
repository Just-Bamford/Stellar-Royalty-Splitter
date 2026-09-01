/**
 * Service worker registration + online/offline detection (#522).
 *
 * The registration intentionally tolerates environments where the
 * service-worker API is missing (jsdom, older browsers, embedded WebViews)
 * — in those environments `register()` resolves to `null` and the rest
 * of the UI behaves as if the SW never registered.
 */

import { analytics } from "./analytics";

export interface OfflineWatcherHandle {
  /** Stop listening for online/offline events. */
  stop: () => void;
}

/**
 * Register `/service-worker.js`. Resolves to the `ServiceWorkerRegistration`
 * on success or `null` if the environment doesn't support service workers.
 */
export async function registerServiceWorker(
  url = "/service-worker.js",
): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register(url);
  } catch (err) {
    // Registration failures are recorded but never thrown — the rest of
    // the UI must work even when the SW didn't register.
    // eslint-disable-next-line no-console
    console.warn("[sw] registration failed", err);
    return null;
  }
}

// #771: while online, ping the SW periodically so queued writes whose
// exponential backoff window has elapsed get retried without waiting for
// another online/offline transition (which may not happen for a long time
// once connectivity is restored).
const QUEUE_RETRY_INTERVAL_MS = 15_000;

function requestQueueDrain() {
  if (
    typeof navigator !== "undefined" &&
    navigator.serviceWorker?.controller
  ) {
    navigator.serviceWorker.controller.postMessage({ type: "srs-drain-queue" });
  }
}

/**
 * Watch `online`/`offline` events; invoke `onChange(isOnline)` on every
 * transition. Also dispatches `analytics.online_restored` /
 * `analytics.offline_detected` so adoption of the offline mode is
 * measurable. Returns a handle whose `stop()` removes the listeners.
 */
export function watchConnectivity(
  onChange: (isOnline: boolean) => void,
): OfflineWatcherHandle {
  let retryInterval: ReturnType<typeof setInterval> | null = null;

  const startRetryLoop = () => {
    if (retryInterval) return;
    retryInterval = setInterval(requestQueueDrain, QUEUE_RETRY_INTERVAL_MS);
  };
  const stopRetryLoop = () => {
    if (!retryInterval) return;
    clearInterval(retryInterval);
    retryInterval = null;
  };

  const handleOnline = () => {
    analytics.dispatch("online_restored", {});
    onChange(true);
    requestQueueDrain(); // drain immediately on reconnect...
    startRetryLoop(); // ...then keep retrying backed-off items while online
  };
  const handleOffline = () => {
    analytics.dispatch("offline_detected", {});
    onChange(false);
    stopRetryLoop();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    if (isOnline()) startRetryLoop();
  }
  return {
    stop: () => {
      stopRetryLoop();
      if (typeof window === "undefined") return;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    },
  };
}

/** Current online status; defaults to `true` outside the browser. */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}
