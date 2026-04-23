import { useState } from "react";

interface Props {
  onConnect: (address: string | null) => void;
}

// Freighter injects window.freighter at runtime — no official type package available,
// so we use type assertions with explicit comments rather than @ts-ignore.
declare global {
  interface Window {
    freighter?: {
      requestAccess: () => Promise<{ address: string }>;
      getAddress: () => Promise<{ address: string }>;
    };
  }
}

export default function WalletConnect({ onConnect }: Props) {
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function connect() {
    setError("");

    if (!window.freighter) {
      setError("Freighter not found. Install it at freighter.app");
      return;
    }

    try {
      const { address: addr } = await window.freighter.requestAccess();
      setAddress(addr);
      onConnect(addr);
    } catch {
      setError("Connection rejected. Please approve the request in Freighter.");
    }
  }

  function disconnect() {
    setAddress(null);
    onConnect(null);
    localStorage.removeItem("lastWalletAddress");
  }

  if (!window.freighter) {
    return (
      <div className="card">
        <div className="wallet-row">
          <span className="badge">Wallet</span>
          <a href="https://freighter.app" target="_blank" rel="noreferrer">
            Install Freighter
          </a>
        </div>
        {error && <div className="status error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="wallet-row">
        <span className="badge">Wallet</span>
        {address ? (
          <>
            <span className="wallet-addr">
              {address.slice(0, 6)}...{address.slice(-4)}
            </span>
            <button className="btn-secondary" onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <button className="btn-primary" onClick={connect}>
            Connect Freighter
          </button>
        )}
      </div>
      {error && <div className="status error">{error}</div>}
    </div>
  );
}
