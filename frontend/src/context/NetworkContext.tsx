/// <reference types="vite/client" />
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { getFreighterNetwork } from "../lib/freighter";
import { useUIStore } from "../store/uiStore";

export type Network = "testnet" | "mainnet";

/**
 * Centralised mapping between our app-level `Network` and the network name
 * Freighter reports/expects (`getNetwork()` and `signTransaction(xdr, { network })`).
 * This is the single source of truth — other modules (stellar.ts) import it
 * rather than redefining their own copy (#663).
 */
export const FREIGHTER_NETWORK_NAMES: Record<Network, string> = {
  testnet: "TESTNET",
  mainnet: "PUBLIC",
};

/** How often to re-check the connected wallet's network while a wallet is present. */
const WALLET_NETWORK_POLL_MS = 5000;

interface NetworkContextType {
  network: Network;
  setNetwork: (n: Network) => void;
  /** Raw network name reported by the connected wallet (e.g. "TESTNET"), or null if unknown/no wallet. */
  walletNetworkName: string | null;
  /** True once a wallet network has been detected and it does not match the configured app network. */
  networkMismatch: boolean;
  /** Re-check the connected wallet's network immediately (e.g. after connecting or an account change). */
  refreshWalletNetwork: () => Promise<void>;
}

const NetworkContext = createContext<NetworkContextType | undefined>(undefined);

const ENV_NETWORK = (import.meta.env.VITE_STELLAR_NETWORK as string | undefined)?.toLowerCase();
const INITIAL_NETWORK: Network =
  localStorage.getItem("srs_network") === "mainnet"
    ? "mainnet"
    : localStorage.getItem("srs_network") === "testnet"
    ? "testnet"
    : ENV_NETWORK === "mainnet"
    ? "mainnet"
    : "testnet";

/**
 * Pure comparison so the mismatch rule is unit-testable without mocking
 * `window.freighter` or React state.
 */
export function computeNetworkMismatch(
  walletNetworkName: string | null,
  appNetwork: Network,
): boolean {
  if (!walletNetworkName) return false;
  return walletNetworkName !== FREIGHTER_NETWORK_NAMES[appNetwork];
}

export const NetworkProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [network, setNetworkState] = useState<Network>(INITIAL_NETWORK);
  const [walletNetworkName, setWalletNetworkName] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem("srs_network", network);
  }, [network]);

  const refreshWalletNetwork = useCallback(async () => {
    const detected = await getFreighterNetwork();
    setWalletNetworkName(detected);
  }, []);

  // Freighter has no reliable push event for network changes, so we poll
  // while the extension is present. This also covers the "refresh app state
  // after a network change" requirement (#663) without auto-switching the
  // wallet ourselves.
  useEffect(() => {
    refreshWalletNetwork();
    const interval = window.setInterval(refreshWalletNetwork, WALLET_NETWORK_POLL_MS);

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") refreshWalletNetwork();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshWalletNetwork]);

  function setNetwork(n: Network) {
    setNetworkState(n);
  }

  const networkMismatch = computeNetworkMismatch(walletNetworkName, network);

  useEffect(() => {
    useUIStore.getState().setWalletNetworkName(walletNetworkName);
    useUIStore.getState().setNetworkMismatch(networkMismatch);
  }, [walletNetworkName, networkMismatch]);

  return (
    <NetworkContext.Provider
      value={{ network, setNetwork, walletNetworkName, networkMismatch, refreshWalletNetwork }}
    >
      {children}
    </NetworkContext.Provider>
  );
};

export const useNetwork = (): NetworkContextType => {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("useNetwork must be used within NetworkProvider");
  return ctx;
};
