import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ThemeProvider } from "./context/ThemeContext";
import { SettingsProvider } from "./context/SettingsContext";
import { NetworkProvider } from "./context/NetworkContext";
import { TransactionProvider } from "./context/TransactionContext";
import { registerServiceWorker } from "./lib/registerServiceWorker";
import { NotificationProvider } from "./context/NotificationContext";
import { queryClient } from "./lib/queryClient";
import "./i18n";
import "./modern-styles.css";
import "./index.css";

// #830 — register the offline-mode service worker in all environments that
// support it. Previously this was gated to PROD only; removing that gate
// lets developers experience and test offline behaviour locally.
// `registerServiceWorker` already tolerates missing SW APIs (jsdom, old
// browsers) by returning null — so this is safe to call unconditionally.
if (typeof window !== "undefined") {
  void registerServiceWorker().then((reg) => {
    if (!reg) return;
    // Once the SW is ready, ask it for the current queue count so the
    // OfflineIndicator can show any persisted pending writes immediately
    // (e.g. after a page reload that happened while offline).
    void navigator.serviceWorker.ready.then(() => {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "srs-get-queue-size",
        });
      }
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <ThemeProvider>
          <NetworkProvider>
            <SettingsProvider>
              <TransactionProvider>
                <NotificationProvider>
                  <App />
                </NotificationProvider>
              </TransactionProvider>
            </SettingsProvider>
          </NetworkProvider>
        </ThemeProvider>
      </ErrorBoundary>
      {/* ReactQueryDevtools only renders in development mode */}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  </React.StrictMode>,
);
