import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../context/ThemeContext";
import { useNetwork } from "../context/NetworkContext";
import { useUIStore } from "../store/uiStore";
import { NotificationBell } from "./NotificationBell";
import "./Navigation.css";

interface NavigationProps {
  currentPage: string;
  onPageChange: (page: string) => void;
  walletAddress: string | null;
  onDisconnect: () => void;
  wsConnected?: boolean;
}

export const Navigation: React.FC<NavigationProps> = ({
  currentPage,
  onPageChange,
  walletAddress,
  onDisconnect,
  wsConnected = false,
}) => {
  const { t } = useTranslation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const isDark = useUIStore((s) => s.isDark);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const { network, setNetwork } = useNetwork();

  // Close mobile menu on Escape and prevent body scroll while open
  useEffect(() => {
    if (!isMobileMenuOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsMobileMenuOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMobileMenuOpen]);

  const navItems = [
    { id: "dashboard", labelKey: "dashboard", icon: "📊" },
    { id: "earnings-dashboard", labelKey: "earningsDashboard", icon: "💎" },
    { id: "earnings-history", labelKey: "earningsHistory", icon: "💹" },
    { id: "onboarding", labelKey: "onboarding", icon: "🚀" },
    { id: "transactions", labelKey: "transactions", icon: "📋" },
    { id: "timeline", labelKey: "timeline", icon: "🕐" },
    { id: "forecast", labelKey: "forecast", icon: "📈" },
    { id: "earnings", labelKey: "earnings", icon: "💎" },
    { id: "admin", labelKey: "admin", icon: "👑" },
    { id: "initialize", labelKey: "initialize", icon: "⚙️" },
    { id: "distribute", labelKey: "distribute", icon: "💰" },
    { id: "secondary", labelKey: "secondary", icon: "🔄" },
    { id: "health", labelKey: "health", icon: "🏥" },
    { id: "bulk-import", labelKey: "bulkImport", icon: "📥" },
    { id: "tax-info", labelKey: "taxInfo", icon: "📋" },
    { id: "payment-holds", labelKey: "paymentHolds", icon: "⏸️" },
    { id: "settings", labelKey: "settings", icon: "⚡" },
  ];

  // Issue #156 — update browser tab title whenever the active page changes
  useEffect(() => {
    const item = navItems.find((n) => n.id === currentPage);
    const label = item ? t(`navigation.${item.labelKey}`) : currentPage;
    document.title = `${label} - Stellar Royalty Splitter`;
  }, [currentPage, t]);

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
          aria-expanded={isMobileMenuOpen}
          aria-controls="mobile-nav-links"
        >
          {isMobileMenuOpen ? "✕" : "☰"}
        </button>

         <ul
          id="mobile-nav-links"
          className={`nav-links ${isMobileMenuOpen ? "active" : ""}`}
          role="list"
        >
          {navItems.map((item) => (
            <li key={item.id}>
              <button
                className={`nav-link ${currentPage === item.id ? "active" : ""}`}
                onClick={() => handleNavClick(item.id)}
                aria-current={currentPage === item.id ? "page" : undefined}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{t(`navigation.${item.labelKey}`)}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="nav-wallet">
          {/* Network toggle — issue #231 */}
          <button
            className={`network-toggle network-toggle--${network}`}
            onClick={() => setNetwork(network === "testnet" ? "mainnet" : "testnet")}
            aria-label={t("wallet.switchNetwork", { network: network === "testnet" ? t("wallet.mainnet") : t("wallet.testnet") })}
            title={t("wallet.switchNetwork", { network: network === "testnet" ? t("wallet.mainnet") : t("wallet.testnet") })}
          >
            <span className="network-dot" aria-hidden="true" />
            <span className="network-label">
              {network === "testnet" ? t("wallet.testnet") : t("wallet.mainnet")}
            </span>
          </button>

          {walletAddress && (
            <NotificationBell />
          )}

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
            aria-label={walletAddress ? `${t("wallet.connected")}: ${walletAddress}` : t("wallet.disconnected")}
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
              <span className="wallet-status-label">{t("wallet.disconnected")}</span>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
};
