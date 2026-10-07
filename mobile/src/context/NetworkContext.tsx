import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { offlineSyncService, SyncStatus } from "../services/offlineSync";

interface NetworkContextType {
  status: SyncStatus;
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  triggerSync: () => Promise<void>;
  toggleSimulatedNetwork: () => void;
}

const NetworkContext = createContext<NetworkContextType | undefined>(undefined);

export const NetworkProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<SyncStatus>(offlineSyncService.getSyncStatus());

  useEffect(() => {
    return offlineSyncService.subscribe((newStatus) => {
      setStatus(newStatus);
    });
  }, []);

  const triggerSync = async () => {
    await offlineSyncService.syncPendingQueue();
  };

  const toggleSimulatedNetwork = () => {
    offlineSyncService.setOnlineStatus(!status.isOnline);
  };

  return (
    <NetworkContext.Provider
      value={{
        status,
        isOnline: status.isOnline,
        isSyncing: status.isSyncing,
        pendingCount: status.pendingCount,
        triggerSync,
        toggleSimulatedNetwork,
      }}
    >
      {children}
    </NetworkContext.Provider>
  );
};

export const useNetwork = () => {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("useNetwork must be used within NetworkProvider");
  return ctx;
};
