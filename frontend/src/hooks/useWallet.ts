import { useCallback, useEffect, useMemo, useState } from "react";
import {
  walletManager,
  type WalletInfo,
  type WalletSession,
  type WalletType,
} from "../services/wallet-manager";

export interface UseWalletResult {
  address: string | null;
  connected: boolean;
  connecting: boolean;
  walletId: WalletType | null;
  session: WalletSession | null;
  wallets: WalletInfo[];
  error: string | null;
  connect: (walletId: WalletType) => Promise<void>;
  disconnect: () => Promise<void>;
  switchWallet: (walletId: WalletType) => Promise<void>;
  clearError: () => void;
}

export const useWallet = (): UseWalletResult => {
  const [session, setSession] = useState<WalletSession | null>(() => walletManager.getSession());
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = walletManager.subscribe((next) => {
      setSession(next);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    walletManager.restoreSession().then((restored) => {
      if (!cancelled && restored) {
        setSession(restored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async (walletId: WalletType) => {
    setConnecting(true);
    setError(null);
    try {
      await walletManager.connect(walletId);
      setSession(walletManager.getSession());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect wallet.";
      setError(message);
      throw err;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setConnecting(true);
    try {
      await walletManager.disconnect();
      setSession(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to disconnect wallet.";
      setError(message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchWallet = useCallback(async (walletId: WalletType) => {
    setConnecting(true);
    setError(null);
    try {
      await walletManager.switchWallet(walletId);
      setSession(walletManager.getSession());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to switch wallets.";
      setError(message);
      throw err;
    } finally {
      setConnecting(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const wallets = useMemo(() => walletManager.getAvailableWallets(), []);

  return {
    address: session?.address ?? null,
    connected: Boolean(session),
    connecting,
    walletId: session?.walletId ?? null,
    session,
    wallets,
    error,
    connect,
    disconnect,
    switchWallet,
    clearError,
  };
};

export default useWallet;
