import { useState, useEffect, useMemo, useRef } from "react";
import { Navigation } from "./components/Navigation";
import HelpModal from "./components/HelpModal";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { NetworkMismatchBanner } from "./components/NetworkMismatchBanner";
import { FeatureErrorBoundary } from "./components/FeatureErrorBoundary";
import { useTheme } from "./context/ThemeContext";
import {
  useKeyboardShortcuts,
  type Shortcut,
} from "./hooks/useKeyboardShortcuts";
import { useWebSocket } from "./hooks/useWebSocket";
import { analytics } from "./lib/analytics";

import { Dashboard } from "./components/Dashboard";
import { EarningsDashboard } from "./components/EarningsDashboard";
import { AdminDashboard } from "./components/AdminDashboard";
import { Settings } from "./components/Settings";
import WalletConnect from "./components/WalletConnect";
import InitializeForm from "./components/InitializeForm";
import DistributeForm from "./components/DistributeForm";
import { TransactionHistory } from "./components/TransactionHistory";
import SecondaryRoyaltyConfig from "./components/SecondaryRoyaltyConfig";
import RecordSecondarySale from "./components/RecordSecondarySale";
import DistributeSecondaryRoyalties from "./components/DistributeSecondaryRoyalties";
import ResaleHistory from "./components/ResaleHistory";
import { Skeleton } from "./components/Skeleton";
import { CopyButton } from "./components/CopyButton";
import { api, SESSION_EXPIRED_EVENT } from "./api";
import { OnboardingWalkthrough } from "./components/OnboardingWalkthrough";
import { HealthDashboard } from "./components/HealthDashboard";
import { useNotifications } from "./context/NotificationContext";
import { ToastContainer } from "react-toastify";

import "./App.css";

function isValidContractId(id: string): boolean {
  return id.startsWith("C") && id.length === 56;
}

export default function App() {
  const { toggleTheme } = useTheme();
  const contractInputRef = useRef<HTMLInputElement>(null);
  const [showHelp, setShowHelp] = useState(
    () => !localStorage.getItem("srs_help_seen"),
  );
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [contractId, setContractId] = useState(
    () => localStorage.getItem("lastContractId") ?? "",
  );
  const [contractIdError, setContractIdError] = useState<string | null>(null);
  const [contractInitialized, setContractInitialized] = useState<
    boolean | null
  >(null);
  const [royaltyRate, setRoyaltyRate] = useState(500); // Default 5%
  const [currentPage, setCurrentPage] = useState(
    () => localStorage.getItem("srs_currentPage") ?? "dashboard",
  );
  const [selectedTxHash, setSelectedTxHash] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [sessionToast, setSessionToast] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { addNotification } = useNotifications();

  const { connected: wsConnected } = useWebSocket({
    walletAddress,
    onNotification: (data: any) => {
      addNotification({
        type: data.type === "pending" || data.type === "confirmed" || data.type === "failed" ? data.type : "info",
        title: data.title || "Notification",
        message: data.message || "",
        txHash: data.txHash,
        transactionId: data.transactionId,
      });
    },
  });

  // Parse deep-link URL params (Issue #577 share link support)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const txHashParam = params.get("txHash");
    const pageParam = params.get("page");

    if (txHashParam) {
      setSelectedTxHash(txHashParam);
      setCurrentPage("transactions");
    } else if (pageParam) {
      setCurrentPage(pageParam);
    }
  }, []);

  function handleWalletConnect(address: string) {
    setWalletAddress(address);
    if (currentPage === "connect-wallet") {
      localStorage.setItem("srs_currentPage", "dashboard");
      setCurrentPage("dashboard");
    }
  }

  function handlePageChange(page: string) {
    localStorage.setItem("srs_currentPage", page);
    setCurrentPage(page);
    // #524 — page_view is the canonical navigation analytics event. Page
    // name is enumerated (no PII) and the analytics tracker scrubs any
    // address-like value defensively even if a future page name leaks one.
    analytics.dispatch("page_view", { page });
  }

  function clearSavedContract() {
    localStorage.removeItem("lastContractId");
    localStorage.removeItem("srs_currentPage");
    setContractId("");
    setCurrentPage("dashboard");
  }

  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<{ message?: string }>).detail;

      localStorage.removeItem("lastContractId");
      localStorage.removeItem("lastWalletAddress");
      localStorage.removeItem("srs_currentPage");
      sessionStorage.clear();
      setWalletAddress(null);
      setContractId("");
      setContractIdError(null);
      setContractInitialized(null);
      setRoyaltyRate(500);
      setCurrentPage("connect-wallet");
      setSessionToast(
        detail?.message ??
          "Your session expired. Connect your wallet again to continue.",
      );
    }

    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () =>
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, []);

  useEffect(() => {
    if (!sessionToast) return;
    const timer = window.setTimeout(() => setSessionToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [sessionToast]);

  // Silently reconnect Freighter if it was previously authorized
  useEffect(() => {
    async function tryReconnect() {
      // window.freighter is injected at runtime by the browser extension
      if (!window.freighter) {
        setInitialLoading(false);
        return;
      }
      try {
        const { address } = window.freighter.getAddress
          ? await window.freighter.getAddress()
          : { address: "" };
        if (address) setWalletAddress(address);
      } catch {
        // Not yet authorized — user must connect manually
      } finally {
        setInitialLoading(false);
      }
    }
    tryReconnect();
  }, []);

  const contractIdValid = isValidContractId(contractId);

  // Fetch on-chain royalty rate when contract changes
  useEffect(() => {
    async function fetchRate() {
      if (!contractIdValid) {
        setRoyaltyRate(500); // Default placeholder
        return;
      }
      try {
        const { royaltyRate } = await api.getRoyaltyRate(contractId);
        setRoyaltyRate(royaltyRate);
      } catch (err) {
        console.error("Failed to fetch royalty rate:", err);
        // If contract is uninitialized or error, we might want 0 or default
        // The contract returns 0 if get_royalty_rate fails in the backend helper
        setRoyaltyRate(0);
      }
    }
    fetchRate();
  }, [contractId, contractIdValid]);

  // Fetch contract initialized status when contractId changes (#101)
  useEffect(() => {
    if (!contractIdValid) {
      setContractInitialized(null);
      return;
    }
    api
      .getContractStatus(contractId)
      .then(({ initialized }) => setContractInitialized(initialized))
      .catch(() => setContractInitialized(null));
  }, [contractId, contractIdValid]);

  function handleContractChange(value: string) {
    setContractId(value);
    if (!value) {
      setContractIdError(null);
      localStorage.removeItem("lastContractId");
    } else if (!isValidContractId(value)) {
      setContractIdError("Contract ID must start with C and be 56 characters");
    } else {
      setContractIdError(null);
      localStorage.setItem("lastContractId", value);
    }
  }

  function closeHelp() {
    localStorage.setItem("srs_help_seen", "1");
    setShowHelp(false);
  }

  // #518 — power-user keyboard shortcuts. Declared once and registered via
  // the shared hook so the help modal renders the same combos the handlers
  // actually respond to (no drift between docs and behavior).
  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        id: "search",
        key: "k",
        ctrl: true,
        description: "Focus contract ID input",
        handler: () => contractInputRef.current?.focus(),
      },
      {
        id: "submit",
        key: "Enter",
        ctrl: true,
        description: "Submit / confirm the current form",
        handler: () => {
          // Dispatch a synthetic submit on the focused form so individual
          // form components don't need to know about the shortcut.
          const active = document.activeElement;
          const form =
            active instanceof HTMLElement ? active.closest("form") : null;
          if (form) form.requestSubmit?.();
        },
      },
      {
        id: "save",
        key: "s",
        ctrl: true,
        description: "Persist the current contract ID as default",
        handler: () => {
          if (contractId) {
            localStorage.setItem("lastContractId", contractId);
          }
        },
      },
      {
        id: "theme",
        key: "d",
        ctrl: true,
        description: "Toggle light / dark theme",
        handler: () => toggleTheme(),
      },
      {
        id: "help",
        key: "?",
        // `?` can fire from `Shift+/` without our shortcut hook needing to
        // know — `allowInInput=false` is enough since the help modal is
        // a top-level concern.
        description: "Open the help / shortcuts modal",
        handler: () => {
          analytics.dispatch("help_opened", { source: "shortcut" });
          setShowHelp(true);
        },
      },
      {
        id: "close-modal",
        key: "Escape",
        allowInInput: true,
        description: "Close any open modal",
        handler: () => setShowHelp(false),
      },
    ],
    [contractId, toggleTheme],
  );
  useKeyboardShortcuts(shortcuts);

  function handleDisconnect() {
    // Clear all wallet state and any cached wallet data from localStorage
    setWalletAddress(null);
    localStorage.removeItem("lastWalletAddress");
    localStorage.removeItem("freighter_connected");
  }

  const renderPage = () => {
    // Helper to wrap page components with feature-level error boundaries
    const withErrorBoundary = (
      component: React.ReactNode,
      featureName: string,
    ) => (
      <FeatureErrorBoundary featureName={featureName}>
        {component}
      </FeatureErrorBoundary>
    );

    switch (currentPage) {
      case "dashboard":
        return withErrorBoundary(
          contractId ? (
            <Dashboard contractId={contractId} />
          ) : (
            <div className="page-empty">
              <div className="empty-content">
                <h2>Welcome to Stellar Royalty Splitter</h2>
                <p>Select or initialize a contract to get started</p>
              </div>
            </div>
          ),
          "Dashboard",
        );
      case "earnings-dashboard":
        return withErrorBoundary(
          <EarningsDashboard
            contractId={contractId}
            walletAddress={walletAddress}
          />,
          "Earnings Dashboard",
        );
      case "connect-wallet":
        return withErrorBoundary(
          <div className="page-empty">
            <div className="empty-content connect-wallet-panel">
              <h2>Session expired</h2>
              <p>Connect your wallet again to continue.</p>
              <WalletConnect
                walletAddress={walletAddress}
                onConnect={handleWalletConnect}
                onDisconnect={handleDisconnect}
              />
            </div>
          </div>,
          "Wallet Connection",
        );
      case "transactions":
        return withErrorBoundary(
          <TransactionHistory
            contractId={
              contractId ||
              "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }
            selectedTxHash={selectedTxHash}
            onSelectTxHash={setSelectedTxHash}
          />,
          "Transaction History",
        );
      case "earnings-history":
        return withErrorBoundary(
          walletAddress ? (
            <EarningsHistoryChart walletAddress={walletAddress} />
          ) : (
            <div className="page-empty">
              <p>Please connect your wallet to view earnings history</p>
            </div>
          ),
          "Earnings History",
        );
      case "forecast":
        return withErrorBoundary(
          contractId ? (
            <EarningsForecastCalculator contractId={contractId} />
          ) : (
            <div className="page-empty">
              <p>Please select a contract first</p>
            </div>
          ),
          "Earnings Forecast",
        );
      case "timeline":
        return withErrorBoundary(
          contractId ? (
            <ContractTimeline contractId={contractId} />
          ) : (
            <div className="page-empty">
              <p>Please select a contract first</p>
            </div>
          ),
          "Contract Timeline",
        );
      case "initialize":
        return withErrorBoundary(
          walletAddress ? (
            <div className="page-section">
              <InitializeForm
                contractId={contractId}
                walletAddress={walletAddress}
                onSuccess={() => {}}
              />
            </div>
          ) : (
            <div className="page-empty">
              <p>Please connect your wallet first</p>
            </div>
          ),
          "Initialize Contract",
        );
      case "distribute":
        return withErrorBoundary(
          walletAddress ? (
            <div className="page-section">
              <DistributeForm
                contractId={contractId}
                walletAddress={walletAddress}
                onSuccess={() => {}}
              />
            </div>
          ) : (
            <div className="page-empty">
              <p>Please connect your wallet first</p>
            </div>
          ),
          "Distribute Royalties",
        );
      case "admin":
        return withErrorBoundary(
          contractId ? (
            <AdminDashboard contractId={contractId} />
          ) : (
            <div className="page-empty">
              <p>Please select a contract first</p>
            </div>
          ),
          "Admin Dashboard",
        );
      case "health":
        return withErrorBoundary(<HealthDashboard />, "System Health");
      case "earnings":
        return withErrorBoundary(
          walletAddress ? (
            <MultiContractEarnings walletAddress={walletAddress} />
          ) : (
            <div className="page-empty">
              <p>Please connect your wallet to view your earnings.</p>
            </div>
          ),
          "Multi-Contract Earnings",
        );
      case "suspension":
        return withErrorBoundary(
          contractId ? (
            <ContributorSuspension
              contractId={contractId}
              walletAddress={walletAddress}
            />
          ) : (
            <div className="page-empty">
              <p>Please select a contract first</p>
            </div>
          ),
          "Contributor Suspension",
        );
      case "settings":
        return withErrorBoundary(
          <Settings
            contractId={contractId}
            walletAddress={walletAddress}
            onClearContract={clearSavedContract}
          />,
          "Settings",
        );
      case "bulk-import":
        return withErrorBoundary(
          walletAddress && contractId ? (
            <div className="page-section">
              <BulkContributorUpload contractId={contractId} />
            </div>
          ) : (
            <div className="page-empty">
              <p>Please connect your wallet and select a contract first</p>
            </div>
          ),
          "Bulk Import",
        );
      case "tax-info":
        return withErrorBoundary(
          walletAddress ? (
            <div className="page-section">
              <ContributorTaxInfo
                walletAddress={walletAddress}
                isAdmin={true}
              />
              <TaxComplianceReport />
            </div>
          ) : (
            <div className="page-empty">
              <p>Please connect your wallet first</p>
            </div>
          ),
          "Tax Information",
        );
      case "payment-holds":
        return withErrorBoundary(
          contractId ? (
            <div className="page-section">
              <PaymentHoldManager contractId={contractId} isAdmin={true} />
            </div>
          ) : (
            <div className="page-empty">
              <p>Please select a contract first</p>
            </div>
          ),
          "Payment Holds",
        );
      case "secondary":
        return withErrorBoundary(
          walletAddress && contractId ? (
            <div className="page-section">
              <div className="secondary-grid">
                <div className="secondary-grid-col">
                  <SecondaryRoyaltyConfig
                    contractId={contractId}
                    walletAddress={walletAddress}
                    onSuccess={() => {}}
                    onRateUpdate={setRoyaltyRate}
                    initialRoyaltyRate={royaltyRate}
                  />
                  <SecondaryRoyaltyConfig
                    contractId={contractId}
                    walletAddress={walletAddress}
                    onSuccess={() => {}}
                    onRateUpdate={setRoyaltyRate}
                    initialRoyaltyRate={royaltyRate}
                  />
                  <RecordSecondarySale
                    contractId={contractId}
                    walletAddress={walletAddress}
                    royaltyRate={royaltyRate}
                    onSuccess={() => {}}
                  />
                  <DistributeSecondaryRoyalties
                    contractId={contractId}
                    walletAddress={walletAddress}
                    onSuccess={() => {}}
                  />
                </div>
                <div className="secondary-grid-col">
                  <ResaleHistory contractId={contractId} />
                </div>
              </div>
            </div>
          ) : (
            <div className="page-empty">
              <div className="empty-content">
                <h2>Secondary Royalties</h2>
                <p>
                  {!walletAddress && !contractId
                    ? "Please connect your wallet and select a contract to manage secondary royalties."
                    : !walletAddress
                      ? "Please connect your wallet to manage secondary royalties."
                      : "Please select a contract to manage secondary royalties."}
                </p>
              </div>
            </div>
          ),
          "Secondary Royalties",
        );
      case "onboarding":
        return withErrorBoundary(
          <ContributorOnboardingChecklist
            walletAddress={walletAddress}
            onConnectWallet={() => handlePageChange("connect-wallet")}
          />,
          "Onboarding Checklist",
        );

      default:
        return null;
    }
  };

  if (initialLoading) {
    return (
      <div className="app-wrapper">
        <div className="app-loading">
          <Skeleton width="200px" height="40px" className="mb-4" />
          <Skeleton width="100%" height="60vh" />
        </div>
      </div>
    );
  }

  return (
    <div className="app-wrapper">
      <ToastContainer />
      <OfflineIndicator />
      {walletAddress && <NetworkMismatchBanner />}
      {showHelp && <HelpModal onClose={closeHelp} shortcuts={shortcuts} />}
      {sessionToast && (
        <div className="session-toast" role="alert" aria-live="assertive">
          <span>{sessionToast}</span>
          <button
            type="button"
            className="session-toast-close"
            aria-label="Dismiss session expiry message"
            onClick={() => setSessionToast(null)}
          >
            x
          </button>
        </div>
      )}
      <Navigation
        currentPage={currentPage}
        onPageChange={handlePageChange}
        walletAddress={walletAddress}
        onDisconnect={handleDisconnect}
        wsConnected={wsConnected}
      />

      <div className="app-content">
        <div className="app-sidebar">
          <button
            className="sidebar-toggle-btn"
            aria-expanded={sidebarOpen}
            aria-controls="sidebar-cards"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ⚙️ Wallet & Contract
            <span
              className={`sidebar-toggle-chevron ${sidebarOpen ? "open" : ""}`}
              aria-hidden="true"
            >
              ▼
            </span>
          </button>
          <div
            id="sidebar-cards"
            className={`app-sidebar-cards ${sidebarOpen ? "open" : ""}`}
          >
            <div className="sidebar-card">
              <h2>🔗 Wallet Connection</h2>
              <WalletConnect
                walletAddress={walletAddress}
                onConnect={handleWalletConnect}
                onDisconnect={handleDisconnect}
              />
            </div>

            <div className="sidebar-card">
              <h2>📋 Contract ID</h2>
              <div className="contract-input-row">
                <input
                  ref={contractInputRef}
                  className={`contract-input${contractIdError ? " contract-input--error" : ""}`}
                  placeholder="C..."
                  value={contractId}
                  onChange={(e) => handleContractChange(e.target.value)}
                />
                {contractIdValid && (
                  <CopyButton
                    value={contractId}
                    label="contract ID"
                    size="sm"
                  />
                )}
                <button
                  className={`quick-action-btn ${
                    currentPage === "health" ? "active" : ""
                  }`}
                  onClick={() => handlePageChange("health")}
                >
                  Health
                </button>
              </div>
              {contractIdError && (
                <p className="contract-input-error">{contractIdError}</p>
              )}
              {contractIdValid && contractInitialized !== null && (
                <p
                  className={`contract-status ${contractInitialized ? "contract-status--ok" : "contract-status--warn"}`}
                >
                  {contractInitialized
                    ? "✅ Initialized"
                    : "⚠️ Not initialized"}
                </p>
              )}
            </div>

            {contractIdValid && (
              <div className="sidebar-card">
                <h2>📊 Quick Actions</h2>
                <div className="quick-actions">
                  <button
                    className={`quick-action-btn ${
                      currentPage === "dashboard" ? "active" : ""
                    }`}
                    onClick={() => handlePageChange("dashboard")}
                  >
                    Dashboard
                  </button>
                  <button
                    className={`quick-action-btn ${
                      currentPage === "transactions" ? "active" : ""
                    }`}
                    onClick={() => handlePageChange("transactions")}
                  >
                    History
                  </button>
                  {walletAddress && (
                    <>
                      <button
                        className={`quick-action-btn ${
                          currentPage === "initialize" ? "active" : ""
                        }`}
                        onClick={() => handlePageChange("initialize")}
                      >
                        Initialize
                      </button>
                      <button
                        className={`quick-action-btn ${
                          currentPage === "distribute" ? "active" : ""
                        }`}
                        onClick={() => handlePageChange("distribute")}
                      >
                        Distribute
                      </button>
                      <button
                        className={`quick-action-btn ${
                          currentPage === "secondary" ? "active" : ""
                        }`}
                        onClick={() => handlePageChange("secondary")}
                      >
                        Secondary
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <main className="app-main">{renderPage()}</main>
      </div>

      <OnboardingWalkthrough />
    </div>
  );
}
