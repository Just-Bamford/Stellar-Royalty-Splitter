import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { WalletAdapter, getWalletAdapter } from "../lib/wallet-adapter";

/**
 * Wallet state shared across the app (#919 multi-wallet support).
 *
 * Note: WalletContext was left unmounted after #1000 — WalletConnect's
 * useWallet() call crashed the whole app at the top-level error boundary,
 * which also blocked the mobile E2E flow for issue #920. This provider is
 * now mounted in main.tsx and exposes the full API surface that
 * WalletConnect / WalletSelector consume (selectedWallet, clearError, and a
 * connect() that resolves the connected address).
 */

export type WalletType = "freighter" | "metamask" | "ledger" | "walletconnect";

export interface WalletState {
  address: string;
  type: WalletType;
}

/** WalletSelector uses lowercase ids; the adapter factory expects labels. */
const WALLET_TYPE_TO_ADAPTER: Record<WalletType, string> = {
  freighter: "Freighter",
  metamask: "MetaMask",
  ledger: "Ledger",
  walletconnect: "WalletConnect",
};

interface WalletContextType {
  wallet: WalletState | null;
  adapter: WalletAdapter | null;
  /** Accepts a wallet id (e.g. "freighter"); rejects unknown ids. */
  connect: (type: string) => Promise<string>;
  disconnect: () => Promise<void>;
  signTransaction: (transaction: string) => Promise<string>;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
  selectedWallet: WalletType | null;
  /** Accepts a wallet id; invalid ids are stored as null. */
  setSelectedWallet: (type: string | null) => void;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export const WalletProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [adapter, setAdapter] = useState<WalletAdapter | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWallet, setSelectedWalletState] = useState<WalletType | null>(null);

  // Auto-connect on mount if preference exists
  useEffect(() => {
    const autoConnect = async () => {
      const savedType = localStorage.getItem("selectedWalletType") as WalletType | null;
      if (savedType && WALLET_TYPE_TO_ADAPTER[savedType]) {
        try {
          const newAdapter = getWalletAdapter(WALLET_TYPE_TO_ADAPTER[savedType]);
          await newAdapter.connect();
          if (newAdapter.address) {
            setWallet({ address: newAdapter.address, type: savedType });
            setAdapter(newAdapter);
          }
        } catch (err: any) {
          // Ignore auto-connect failures (e.g., wallet not installed)
          console.warn("Auto-connect failed:", err.message);
          setError("Auto-connect failed. Please select a wallet manually.");
        }
      }
    };
    autoConnect();
  }, []);

  const connect = async (type: string): Promise<string> => {
    setIsLoading(true);
    setError(null);
    try {
      const walletType = type as WalletType;
      const adapterLabel = WALLET_TYPE_TO_ADAPTER[walletType];
      if (!adapterLabel) {
        throw new Error(`Unsupported wallet: ${type}`);
      }
      const newAdapter = getWalletAdapter(adapterLabel);
      await newAdapter.connect();
      const address = newAdapter.address;
      if (!address) {
        throw new Error("Wallet did not report an address");
      }
      setWallet({ address, type: walletType });
      setAdapter(newAdapter);
      setSelectedWalletState(walletType);
      localStorage.setItem("selectedWalletType", walletType);
      return address;
    } catch (err: any) {
      setError(err.message || "Failed to connect wallet");
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const disconnect = async () => {
    if (!adapter) return;
    try {
      await adapter.disconnect();
      setWallet(null);
      setAdapter(null);
      setSelectedWalletState(null);
      localStorage.removeItem("selectedWalletType");
    } catch (err: any) {
      setError(err.message || "Failed to disconnect wallet");
    }
  };

  const signTransaction = async (transaction: string): Promise<string> => {
    if (!adapter) {
      throw new Error("No wallet connected");
    }
    try {
      return await adapter.signTransaction(transaction);
    } catch (err: any) {
      setError(err.message || "Failed to sign transaction");
      throw err;
    }
  };

  const setSelectedWalletSafe = (type: string | null) => {
    setSelectedWalletState(
      type && type in WALLET_TYPE_TO_ADAPTER ? (type as WalletType) : null,
    );
  };

  const clearError = () => setError(null);

  return (
    <WalletContext.Provider
      value={{
        wallet,
        adapter,
        connect,
        disconnect,
        signTransaction,
        isLoading,
        error,
        clearError,
        selectedWallet,
        setSelectedWallet: setSelectedWalletSafe,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
};

export const useWallet = (): WalletContextType => {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return context;
};
