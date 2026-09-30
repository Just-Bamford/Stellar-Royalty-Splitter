import { useCallback, useEffect, useState } from 'react';
import { walletManager, WalletInfo, WalletSession, WalletType, SignResult } from '../services/waller-manager';

export interface UseWalletReturn {
  wallets: WalletInfo[];
  session: WalletSession | null;
  address: string | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  connect: (walletId: WalletType) => Promise<void>;
  disconnect: () => Promise<void>;
  switchWallet: (walletId: WalletType) => Promise<void>;
  signTransaction: (xdr: string) => Promise<SignResult>;
  clearError: () => void;
  refreshWallets: () => void;
}

export function useWallet(): UseWalletReturn {
  const [session, setSession] = useState<WalletSession | null>(() => walletManager.getActiveSession());
  const [wallets, setWallets] = useState<WalletInfo[]>(() => walletManager.getAvailableWallets());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = walletManager.onSessionChange((nextSession) => {
      setSession(nextSession);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    setWallets(walletManager.getAvailableWallets());
  }, []);

  const refreshWallets = useCallback(() => {
    setWallets(walletManager.getAvailableWallets());
  }, []);

  const connect = useCallback(async (walletId: WalletType) => {
    setLoading(true);
    setError(null);
    try {
      const newSession = await walletManager.connect(walletId);
      setSession(newSession);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setLoading(true);
    try {
      await walletManager.disconnect();
      setSession(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const switchWallet = useCallback(async (walletId: WalletType) => {
    setLoading(true);
    setError(null);
    try {
      const newSession = await walletManager.switchWallet(walletId);
      setSession(newSession);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const signTransaction = useCallback(async (xdr: string) => {
    setError(null);
    const result = await walletManager.signTransaction(xdr);
    if (!result.signed && result.error) {
      setError(result.error);
    }
    return result;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    wallets,
    session,
    address: session?.address ?? null,
    isConnected: Boolean(session),
    isLoading: loading,
    error,
    connect,
    disconnect,
    switchWallet,
    signTransaction,
    clearError,
    refreshWallets,
  };
}

export default useWallet;
