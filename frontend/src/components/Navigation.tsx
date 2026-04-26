import { useState } from "react";
import { useTheme } from "../context/ThemeContext";
import "./Navigation.css";

interface NavigationProps {
  currentPage: string;
  onPageChange: (page: string) => void;
  walletAddress: string | null;
}

export const Navigation: React.FC<NavigationProps> = ({
  currentPage,
  onPageChange,
  walletAddress,
}) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { isDark, toggleTheme } = useTheme();

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

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "transactions", label: "Transactions", icon: "📋" },
    { id: "admin", label: "Admin", icon: "👑" },
    { id: "initialize", label: "Initialize", icon: "⚙️" },
    { id: "distribute", label: "Distribute", icon: "💰" },
    { id: "secondary", label: "Secondary", icon: "🔄" },
    { id: "settings", label: "Settings", icon: "⚡" },
  ];

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
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="nav-wallet">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {isDark ? "☀️" : "🌙"}
          </button>
          {walletAddress && (
            <>
              <span className="wallet-info" title={walletAddress}>
                {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </span>
              <button
                className="copy-address-btn"
                onClick={copyAddress}
                title="Copy full address"
                aria-label="Copy wallet address"
              >
                {copied ? "✓" : "⧉"}
              </button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
};
