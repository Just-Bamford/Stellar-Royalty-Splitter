import { useState, useEffect } from "react";
import { useTheme } from "../context/ThemeContext";
import { useNetwork } from "../context/NetworkContext";
import "./Navigation.css";

interface NavigationProps {
  currentPage: string;
  onPageChange: (page: string) => void;
  walletAddress: string | null;
  onDisconnect: () => void;
  onStartTour: () => void;
}

export const Navigation: React.FC<NavigationProps> = ({
  currentPage,
  onPageChange,
  walletAddress,
  onDisconnect,
  onStartTour,
}) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { isDark, toggleTheme } = useTheme();
  const { network, setNetwork } = useNetwork();

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "transactions", label: "Transactions", icon: "📋" },
    { id: "admin", label: "Admin", icon: "👑" },
    { id: "initialize", label: "Initialize", icon: "⚙️" },
    { id: "distribute", label: "Distribute", icon: "💰" },
    { id: "secondary", label: "Secondary", icon: "🔄" },
    { id: "settings", label: "Settings", icon: "⚡" },
  ];

  // Issue #156 — update browser tab title whenever the active page changes
  useEffect(() => {
    const item = navItems.find((n) => n.id === currentPage);
    const label = item ? item.label : currentPage;
    document.title = `${label} - Stellar Royalty Splitter`;
  }, [currentPage]);

  function copyAddress() {
    if (!walletAddress) return;
    navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen);
  };

  const handleNavClick = (page: string) => {
    onPageChange(page);
    setIsMobileMenuOpen(false);
  };

  return (
    <nav className="navigation">
      <div className="nav-container">
        <div className="nav-brand">
          <div className="nav-logo">🌟</div>
          <h1>Stellar Splitter</h1>
        </div>

        <button
          className="mobile-menu-btn"
          onClick={toggleMobileMenu}
          aria-label="Toggle menu"
        >
          {isMobileMenuOpen ? "✕" : "☰"}
        </button>

        <ul className={`nav-links ${isMobileMenuOpen ? "active" : ""}`}>
          {navItems.map((item) => (
            <li key={item.id}>
              <button
                className={`nav-link ${currentPage === item.id ? "active" : ""}`}
                onClick={() => handleNavClick(item.id)}
                aria-current={currentPage === item.id ? "page" : undefined}
                data-tour-id={item.id}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="nav-wallet">
          {/* Onboarding tour restart — issue #419 */}
          <button
            className="tour-restart-btn"
            onClick={onStartTour}
            aria-label="Start the onboarding tour"
            title="Start the onboarding tour"
          >
            🎯 Start Tour
          </button>

          {/* Network toggle — issue #231 */}
          <button
            className={`network-toggle network-toggle--${network}`}
            onClick={() => setNetwork(network === "testnet" ? "mainnet" : "testnet")}
            aria-label={`Switch to ${network === "testnet" ? "mainnet" : "testnet"}`}
            title={`Currently on ${network === "testnet" ? "Testnet" : "Mainnet"} — click to switch`}
          >
            <span className="network-dot" aria-hidden="true" />
            <span className="network-label">
              {network === "testnet" ? "Testnet" : "Mainnet"}
            </span>
          </button>

          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {isDark ? "☀️" : "🌙"}
          </button>

          {/* Wallet status badge — issue #249 */}
          <div
            className={`wallet-status wallet-status--${walletAddress ? "connected" : "disconnected"}`}
            aria-label={walletAddress ? `Wallet connected: ${walletAddress}` : "Wallet disconnected"}
          >
            <span className="wallet-status-dot" aria-hidden="true" />
            {walletAddress ? (
              <>
                <span
                  className="wallet-status-address"
                  title={walletAddress}
                  onClick={copyAddress}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && copyAddress()}
                  aria-label={copied ? "Address copied" : "Click to copy wallet address"}
                >
                  {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
                  {copied && <span className="wallet-copied-indicator"> ✓</span>}
                </span>
                <button
                  className="wallet-disconnect-btn"
                  onClick={onDisconnect}
                  aria-label="Disconnect wallet"
                  title="Disconnect wallet"
                >
                  ✕
                </button>
              </>
            ) : (
              <span className="wallet-status-label">Disconnected</span>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
};
