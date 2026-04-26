import { useState, useEffect } from "react";
import { Navigation } from "./components/Navigation";

// Freighter is injected at runtime by the browser extension
declare global {
  interface Window {
    freighter?: {
      requestAccess: () => Promise<{ address: string }>;
      getAddress: () => Promise<{ address: string }>;
    };
  }
}
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
import { api } from "./api";


import "./App.css";

function isValidContractId(id: string): boolean {
  return id.startsWith("C") && id.length === 56;
}

export default function App() {
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

  // Silently reconnect Freighter if it was previously authorized
  useEffect(() => {
    async function tryReconnect() {
      // window.freighter is injected at runtime by the browser extension
      if (!window.freighter) return;
      try {
        const { address } = await window.freighter.getAddress();
        if (address) setWalletAddress(address);
      } catch {
        // Not yet authorized — user must connect manually
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

  return (
    <div className="app-wrapper">
      <Navigation
        currentPage={currentPage}
        onPageChange={handlePageChange}
        walletAddress={walletAddress}
      />

      <div className="app-content">
        <div className="app-sidebar">
          <div className="sidebar-card">
            <h3>🔗 Wallet Connection</h3>
            <WalletConnect
              onConnect={setWalletAddress}
              onDisconnect={() => setWalletAddress(null)}
            />
          </div>

          <div className="sidebar-card">
            <h3>📋 Contract ID</h3>
            <input
              className={`contract-input${contractIdError ? " contract-input--error" : ""}`}
              placeholder="C..."
              value={contractId}
              onChange={(e) => handleContractChange(e.target.value)}
            />
            {contractIdError && (
              <p className="contract-input-error">{contractIdError}</p>
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
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="app-main">{renderPage()}</div>
      </div>

    </div>
  );
}
