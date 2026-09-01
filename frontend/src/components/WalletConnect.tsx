import { useState, useEffect, useCallback } from "react";
import "../lib/freighter";
import { useNetwork } from "../context/NetworkContext";

interface Props {
  walletAddress: string | null;
  onConnect: (address: string) => void;
  onDisconnect?: () => void;
}

const CONNECTED_FLAG_KEY = "freighter_connected";
const LAST_ADDRESS_KEY = "lastWalletAddress";

export default function WalletConnect({ walletAddress, onConnect, onDisconnect }: Props) {
  const { refreshWalletNetwork } = useNetwork();
  const [error, setError] = useState("");
  const [freighterAvailable, setFreighterAvailable] = useState(
    () => Boolean(window.freighter),
  );
  const [copied, setCopied] = useState(false);
  const [restoring, setRestoring] = useState(false);

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

  const persistSession = useCallback((addr: string) => {
    localStorage.setItem(CONNECTED_FLAG_KEY, "true");
    localStorage.setItem(LAST_ADDRESS_KEY, addr);
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem(CONNECTED_FLAG_KEY);
    localStorage.removeItem(LAST_ADDRESS_KEY);
  }, []);

  // Listen for Freighter account changes — a new account may be on a
  // different network, so re-check alongside the address (#663).
  useEffect(() => {
    if (!window.freighter?.on) return;
    window.freighter.on("accountChanged", ({ address: newAddr }) => {
      onConnect(newAddr);
      persistSession(newAddr);
      refreshWalletNetwork();
    });
  }, [freighterAvailable, onConnect, refreshWalletNetwork, persistSession]);

  // Restore a previously-authorized session after a page refresh instead of
  // forcing the user to reconnect every time (#697). Only attempted if this
  // browser previously completed a real connection — getAddress() resolves
  // silently (no Freighter popup) when the site is already authorized, or
  // rejects if that authorization no longer exists, in which case the stale
  // flags are cleared so the UI falls back to a normal "Connect Freighter."
  useEffect(() => {
    if (walletAddress) return;
    if (!freighterAvailable) return;
    if (localStorage.getItem(CONNECTED_FLAG_KEY) !== "true") return;

    let cancelled = false;
    setRestoring(true);

    (async () => {
      try {
        if (!window.freighter?.getAddress) {
          throw new Error("Freighter does not support silent session restore.");
        }
        const { address: addr } = await window.freighter.getAddress();
        if (!addr) throw new Error("No address returned from Freighter.");
        if (cancelled) return;
        onConnect(addr);
        persistSession(addr);
        await refreshWalletNetwork();
      } catch {
        if (cancelled) return;
        // The extension no longer recognizes this site (revoked access,
        // different browser profile, locked wallet, etc.) — clear the
        // stale flag so we don't keep retrying a dead session on every
        // future load.
        clearSession();
        setError("Your previous session expired. Reconnect below.");
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Deliberately only keyed on freighterAvailable: this should run once,
    // right after the extension becomes available, not on every prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freighterAvailable]);

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
      persistSession(addr);
      await refreshWalletNetwork();
    } catch {
      setError("Connection rejected. Please approve the request in Freighter.");
    }
  }

  function disconnect() {
    setError("");
    setCopied(false);
    clearSession();
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
            disabled={!freighterAvailable || restoring}
            aria-describedby={!freighterAvailable ? "freighter-install-prompt" : undefined}
          >
            {restoring ? "Restoring session…" : error ? "Retry connection" : "Connect Freighter"}
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

      {error && (
        <div className="status error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
