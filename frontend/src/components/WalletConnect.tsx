import { useState, useEffect } from "react";

interface Props {
  walletAddress: string | null;
  onConnect: (address: string) => void;
  onDisconnect?: () => void;
}

// Freighter injects window.freighter at runtime — no official type package available,
// so we use type assertions with explicit comments rather than @ts-ignore.
declare global {
  interface Window {
    freighter?: {
      requestAccess: () => Promise<{ address: string }>;
      getAddress: () => Promise<{ address: string }>;
      on?: (event: string, handler: (data: { address: string }) => void) => void;
    };
  }
}

export default function WalletConnect({ walletAddress, onConnect, onDisconnect }: Props) {
  const [error, setError] = useState("");
  const [freighterMissing, setFreighterMissing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Listen for Freighter account changes
  useEffect(() => {
    if (!window.freighter?.on) return;
    window.freighter.on("accountChanged", ({ address: newAddr }) => {
      onConnect(newAddr);
    });
  }, [onConnect]);

  async function connect() {
    setError("");
    setFreighterMissing(false);

    if (!window.freighter) {
      setFreighterMissing(true);
      return;
    }

    try {
      const { address: addr } = await window.freighter.requestAccess();
      onConnect(addr);
    } catch {
      setError("Connection rejected. Please approve the request in Freighter.");
    }
  }

  function disconnect() {
    setFreighterMissing(false);
    setError("");
    setCopied(false);
    localStorage.removeItem("lastWalletAddress");
    localStorage.removeItem("freighter_connected");
    onDisconnect?.();
  }

  async function copyAddress() {
    if (!walletAddress) return;
    await navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="card">
      <div className="wallet-row">
        <span className="badge">Wallet</span>
        {walletAddress ? (
          <>
            <button
              className="wallet-addr"
              onClick={copyAddress}
              title="Copy address"
            >
              {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              <span className="copy-hint">{copied ? " ✓" : " 📋"}</span>
            </button>
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

      {freighterMissing && (
        <div className="status error">
          Freighter wallet not found. Install it at{" "}
          <a
            href="https://freighter.app"
            target="_blank"
            rel="noreferrer"
            className="freighter-link"
          >
            freighter.app
          </a>
        </div>
      )}

      {error && <div className="status error">{error}</div>}
    </div>
  );
}
