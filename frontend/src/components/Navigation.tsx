import { useState } from "react";
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
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="nav-wallet">
          {walletAddress && (
            <span className="wallet-info">
              {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
            </span>
          )}
        </div>
      </div>
    </nav>
  );
};
