import { useState, useEffect, useRef } from "react";
import { Navigation } from "./components/Navigation";
import HelpModal from "./components/HelpModal";
import { useTheme } from "./context/ThemeContext";

import { Dashboard } from "./components/Dashboard";
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
import { ContractAddress } from "./components/ContractAddress";
import { api, SESSION_EXPIRED_EVENT } from "./api";
import { OnboardingWalkthrough } from "./components/OnboardingWalkthrough";
import { TraceDashboard } from "./components/TraceDashboard";

import "./App.css";

function isValidContractId(id: string): boolean {
  return id.startsWith("C") && id.length === 56;
}

export default function App() {
  const { toggleTheme } = useTheme();
  const contractInputRef = useRef<HTMLInputElement>(null);
  const [showHelp, setShowHelp] = useState(
    () => !localStorage.getItem("srs_help_seen")
  );
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [contractId, setContractId] = useState(
    () => localStorage.getItem("lastContractId") ?? ""
  );
  const [contractIdError, setContractIdError] = useState<string | null>(null);
  const [contractInitialized, setContractInitialized] = useState<boolean | null>(null);
  const [royaltyRate, setRoyaltyRate] = useState(500); // Default 5%
  const [currentPage, setCurrentPage] = useState(
    () => localStorage.getItem("srs_currentPage") ?? "dashboard"
  );
  const [initialLoading, setInitialLoading] = useState(true);
  const [sessionToast, setSessionToast] = useState<string | null>(null);
  const [tourTrigger, setTourTrigger] = useState(0);
  const [isRpcDegraded, setIsRpcDegraded] = useState(false);

  // Poll backend health to detect RPC degradation (#482)
  useEffect(() => {
    async function checkHealth() {
      try {
        const health = await api.getHealth();
        setIsRpcDegraded(!health.horizon.connected);
      } catch (err) {
        setIsRpcDegraded(true); // If backend is totally unreachable or returns 5xx
      }
    }
    checkHealth();
    const id = setInterval(checkHealth, 30_000);
    return () => clearInterval(id);
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
    api.getContractStatus(contractId)
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

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "?" && !typing) { setShowHelp(true); return; }
      if (e.key === "Escape") { setShowHelp(false); return; }
      if (e.ctrlKey && e.key === "k") { e.preventDefault(); contractInputRef.current?.focus(); return; }
      if (e.ctrlKey && e.key === "d") { e.preventDefault(); toggleTheme(); return; }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleTheme]);

  function handleDisconnect() {
    // Clear all wallet state and any cached wallet data from localStorage
    setWalletAddress(null);
    localStorage.removeItem("lastWalletAddress");
    localStorage.removeItem("freighter_connected");
  }

  const renderPage = () => {
    switch (currentPage) {
      case "dashboard":
        return contractId ? (
          <Dashboard contractId={contractId} />
        ) : (
          <div className="page-empty">
            <div className="empty-content">
              <h2>Welcome to Stellar Royalty Splitter</h2>
              <p>Select or initialize a contract to get started</p>
            </div>
          </div>
        );
      case "connect-wallet":
        return (
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
          </div>
        );
      case "transactions":
        return contractId ? (
          <TransactionHistory contractId={contractId} />
        ) : (
          <div className="page-empty">
            <p>Please select a contract first</p>
          </div>
        );
      case "initialize":
        return walletAddress ? (
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
        );
      case "distribute":
        return walletAddress ? (
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
        );
      case "admin":
        return contractId ? (
          <AdminDashboard contractId={contractId} />
        ) : (
          <div className="page-empty">
            <p>Please select a contract first</p>
          </div>
        );
      case "traces":
        return <TraceDashboard />;
      case "settings":
        return <Settings contractId={contractId} onClearContract={clearSavedContract} />;
      case "secondary":
        return walletAddress && contractId ? (
          <div className="page-section">
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
            <ResaleHistory contractId={contractId} />
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
      {showHelp && <HelpModal onClose={closeHelp} />}
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
        onStartTour={() => setTourTrigger((n) => n + 1)}
      />

      {isRpcDegraded && (
        <div className="degraded-banner" style={{ background: "#ff9800", color: "#fff", padding: "10px", textAlign: "center", fontWeight: "bold" }}>
          ⚠️ RPC Network is currently down. Showing cached data where possible. Operations may fail.
        </div>
      )}

      <div className="app-content">
        <div className="app-sidebar">
          <div className="sidebar-card">
            <h3>🔗 Wallet Connection</h3>
            <WalletConnect
              walletAddress={walletAddress}
              onConnect={handleWalletConnect}
              onDisconnect={handleDisconnect}
            />
          </div>

          <div className="sidebar-card">
            <h3>📋 Contract ID</h3>
            <div className="contract-input-row">
              <input
                ref={contractInputRef}
                className={`contract-input${contractIdError ? " contract-input--error" : ""}`}
                placeholder="C..."
                value={contractId}
                onChange={(e) => handleContractChange(e.target.value)}
              />
              {contractIdValid && (
                <CopyButton value={contractId} label="contract ID" size="sm" />
              )}
            </div>
            {contractIdError && (
              <p className="contract-input-error">{contractIdError}</p>
            )}
            {contractIdValid && (
              <ContractAddress address={contractId} label="contract ID" />
            )}
            {contractIdValid && contractInitialized !== null && (
              <p className={`contract-status ${contractInitialized ? "contract-status--ok" : "contract-status--warn"}`}>
                {contractInitialized ? "✅ Initialized" : "⚠️ Not initialized"}
              </p>
            )}
          </div>

          {contractIdValid && (
            <div className="sidebar-card">
              <h3>📊 Quick Actions</h3>
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
                    <button
                      className={`quick-action-btn ${
                        currentPage === "traces" ? "active" : ""
                      }`}
                      onClick={() => handlePageChange("traces")}
                    >
                      Traces
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="app-main">{renderPage()}</div>
      </div>

      <OnboardingWalkthrough
        currentPage={currentPage}
        onPageChange={handlePageChange}
        restartSignal={tourTrigger}
      />
    </div>
  );
}
