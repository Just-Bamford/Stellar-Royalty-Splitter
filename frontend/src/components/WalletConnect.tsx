import { useState, useEffect, useRef } from "react";
import {
  retryWithBackoff,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_RETRIES,
} from "../lib/retryWithBackoff";

interface Props {
  walletAddress: string | null;
  onConnect: (address: string) => void;
  onDisconnect?: () => void;
  /** Base backoff delay; overridable so tests don't wait whole seconds. */
  retryBaseDelayMs?: number;
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

export default function WalletConnect({
  walletAddress,
  onConnect,
  onDisconnect,
  retryBaseDelayMs = DEFAULT_BASE_DELAY_MS,
}: Props) {
  const [error, setError] = useState("");
  const [freighterAvailable, setFreighterAvailable] = useState(
    () => Boolean(window.freighter),
  );
  const [copied, setCopied] = useState(false);
  // #412: connection-attempt state for retry feedback.
  const [connecting, setConnecting] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight retry loop on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

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

  async function requestFreighterAddress(): Promise<string> {
    let addr = "";
    if (window.freighter?.requestAccess) {
      addr = (await window.freighter.requestAccess()).address;
    } else if (window.freighter?.getAddress) {
      addr = (await window.freighter.getAddress()).address;
    } else if (window.freighter?.getPublicKey) {
      addr = await window.freighter.getPublicKey();
    }
    if (!addr) {
      throw new Error("No address returned from Freighter.");
    }
    return addr;
  }

  async function connect() {
    setError("");

    if (!window.freighter) {
      setFreighterAvailable(false);
      return;
    }

    // #412: retry transient connection failures (RPC timeouts, network
    // hiccups) with exponential backoff instead of failing immediately.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setConnecting(true);
    setRetryAttempt(0);

    try {
      const addr = await retryWithBackoff(requestFreighterAddress, {
        baseDelayMs: retryBaseDelayMs,
        signal: controller.signal,
        onRetry: (attempt) => setRetryAttempt(attempt),
      });

      // Persist last known wallet state so the app can restore it (#412).
      localStorage.setItem("lastWalletAddress", addr);
      localStorage.setItem("freighter_connected", "true");
      onConnect(addr);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return; // unmounted/disconnected
      setError(
        `Could not connect after ${DEFAULT_RETRIES + 1} attempts. Check Freighter and your connection, then try again.`,
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setConnecting(false);
      setRetryAttempt(0);
    }
  }

  function disconnect() {
    abortRef.current?.abort();
    abortRef.current = null;
    setError("");
    setCopied(false);
    setConnecting(false);
    setRetryAttempt(0);
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
            disabled={!freighterAvailable || connecting}
            aria-busy={connecting}
            aria-describedby={!freighterAvailable ? "freighter-install-prompt" : undefined}
          >
            {connecting
              ? retryAttempt > 0
                ? `Reconnecting… (attempt ${retryAttempt + 1})`
                : "Connecting…"
              : "Connect Freighter"}
          </button>
        )}
      </div>

      {connecting && retryAttempt > 0 && (
        <div className="status" role="status" aria-live="polite">
          Reconnecting… (attempt {retryAttempt + 1} of {DEFAULT_RETRIES + 1})
        </div>
      )}

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
