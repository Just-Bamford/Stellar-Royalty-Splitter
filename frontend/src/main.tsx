import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ThemeProvider } from "./context/ThemeContext";
import { SettingsProvider } from "./context/SettingsContext";
import { NetworkProvider } from "./context/NetworkContext";
import { TransactionProvider } from "./context/TransactionContext";
import "./modern-styles.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <NetworkProvider>
          <SettingsProvider>
            <TransactionProvider>
              <App />
            </TransactionProvider>
          </SettingsProvider>
        </NetworkProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
