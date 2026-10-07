import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { walletService, WalletSession, MobileWalletType } from "../services/wallet";

interface WalletContextType {
  session: WalletSession | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  connect: (type: MobileWalletType) => Promise<void>;
  disconnect: () => Promise<void>;
  signTransaction: (xdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export const WalletProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return walletService.onSessionChange((newSession) => {
      setSession(newSession);
    });
  }, []);

  const connect = async (type: MobileWalletType) => {
    setIsLoading(true);
    setError(null);
    try {
      const newSession = await walletService.connect(type);
      setSession(newSession);
    } catch (err: any) {
      setError(err.message || "Failed to connect wallet");
    } finally {
      setIsLoading(false);
    }
  };

  const disconnect = async () => {
    setIsLoading(true);
    try {
      await walletService.disconnect();
      setSession(null);
    } finally {
      setIsLoading(false);
    }
  };

  const signTransaction = async (xdr: string): Promise<string> => {
    return walletService.signTransaction({ xdr });
  };

  return (
    <WalletContext.Provider
      value={{
        session,
        isConnected: Boolean(session),
        isLoading,
        error,
        connect,
        disconnect,
        signTransaction,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
};

export const useWallet = () => {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
};
