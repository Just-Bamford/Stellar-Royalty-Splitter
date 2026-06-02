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
      requestAccess?: () => Promise<{ address: string }>;
      getAddress?: () => Promise<{ address: string }>;
      getPublicKey?: () => Promise<string>;
      signTransaction?: (
        xdr: string,
        options?: { network?: string },
      ) => Promise<string>;
      on?: (event: string, handler: (data: { address: string }) => void) => void;
    };
  }
}

export default function WalletConnect({ walletAddress, onConnect, onDisconnect }: Props) {
  const [error, setError] = useState("");
  const [freighterAvailable, setFreighterAvailable] = useState(
    () => Boolean(window.freighter),
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function checkFreighterAvailability() {
      setFreighterAvailable(Boolean(window.freighter));
    }

    checkFreighterAvailability();
    window.addEventListener("load", checkFreighterAvailability);
    const timer = window.setTimeout(checkFreighterAvailability, 500);

    return () => {
      window.removeEventListener("load", checkFreighterAvailability);
      window.clearTimeout(timer);
    };
  }, []);

  // Listen for Freighter account changes
  useEffect(() => {
    if (!window.freighter?.on) return;
    window.freighter.on("accountChanged", ({ address: newAddr }) => {
      onConnect(newAddr);
    });
  }, [freighterAvailable, onConnect]);

  async function connect() {
    setError("");

    if (!window.freighter) {
      setFreighterAvailable(false);
      return;
    }

    try {
      let addr = "";
      if (window.freighter.requestAccess) {
        addr = (await window.freighter.requestAccess()).address;
      } else if (window.freighter.getAddress) {
        addr = (await window.freighter.getAddress()).address;
      } else if (window.freighter.getPublicKey) {
        addr = await window.freighter.getPublicKey();
      }

      if (!addr) {
        throw new Error("No address returned from Freighter.");
      }

      onConnect(addr);
    } catch {
      setError("Connection rejected. Please approve the request in Freighter.");
    }
  }

  function disconnect() {
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
          <button
            className="btn-primary"
            onClick={connect}
            disabled={!freighterAvailable}
            aria-describedby={!freighterAvailable ? "freighter-install-prompt" : undefined}
          >
            Connect Freighter
          </button>
        )}
      </div>

      {!freighterAvailable && !walletAddress && (
        <div className="status error" id="freighter-install-prompt" role="status">
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
