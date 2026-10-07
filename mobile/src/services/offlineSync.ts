/**
 * Offline-First Architecture & Sync Service
 * Manages local caching of earnings/transactions and synchronizes mutations upon reconnect.
 */

export interface CachedEarnings {
  totalEarned: number;
  unclaimedBalance: number;
  currency: string;
  lastUpdated: number;
  recentDistributions: Array<{
    id: string;
    contractId: string;
    amount: number;
    timestamp: number;
    txHash: string;
  }>;
}

export interface QueuedAction {
  id: string;
  type: "claim_earnings" | "update_tier" | "sign_split";
  payload: Record<string, any>;
  timestamp: number;
  retryCount: number;
}

export interface SyncStatus {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncTime: number | null;
}

class OfflineSyncManager {
  private cache: Map<string, any> = new Map();
  private queue: QueuedAction[] = [];
  private isOnline: boolean = true;
  private isSyncing: boolean = false;
  private lastSyncTime: number | null = Date.now();
  private listeners: Set<(status: SyncStatus) => void> = new Set();

  constructor() {
    // Initial mock cached data for offline demonstration
    this.cache.set("earnings_summary", {
      totalEarned: 14250.75,
      unclaimedBalance: 1250.0,
      currency: "XLM",
      lastUpdated: Date.now(),
      recentDistributions: [
        {
          id: "dist-001",
          contractId: "CDLZ...4891",
          amount: 450.0,
          timestamp: Date.now() - 3600000,
          txHash: "a1b2c3d4e5f6...",
        },
        {
          id: "dist-002",
          contractId: "CBKT...1022",
          amount: 800.0,
          timestamp: Date.now() - 86400000,
          txHash: "f6e5d4c3b2a1...",
        },
      ],
    } as CachedEarnings);
  }

  /**
   * Set network connectivity state (called by NetInfo listener).
   */
  setOnlineStatus(online: boolean) {
    this.isOnline = online;
    if (this.isOnline && this.queue.length > 0) {
      void this.syncPendingQueue();
    }
    this.notify();
  }

  getOnlineStatus(): boolean {
    return this.isOnline;
  }

  /**
   * Retrieve cached earnings instantly (even offline).
   */
  async getCachedEarnings(): Promise<CachedEarnings | null> {
    return (this.cache.get("earnings_summary") as CachedEarnings) || null;
  }

  /**
   * Save earnings data to local offline store.
   */
  async saveCachedEarnings(data: CachedEarnings): Promise<void> {
    this.cache.set("earnings_summary", {
      ...data,
      lastUpdated: Date.now(),
    });
    this.notify();
  }

  /**
   * Enqueue mutation action when offline or for optimistic update.
   */
  async enqueueAction(type: QueuedAction["type"], payload: Record<string, any>): Promise<QueuedAction> {
    const action: QueuedAction = {
      id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type,
      payload,
      timestamp: Date.now(),
      retryCount: 0,
    };

    this.queue.push(action);
    this.notify();

    if (this.isOnline) {
      void this.syncPendingQueue();
    }

    return action;
  }

  private syncPromise: Promise<void> | null = null;

  /**
   * Clear all pending queue actions.
   */
  clearQueue(): void {
    this.queue = [];
    this.notify();
  }

  /**
   * Synchronize queued actions with backend server when connection is restored.
   */
  async syncPendingQueue(): Promise<void> {
    if (this.syncPromise) {
      return this.syncPromise;
    }
    if (this.queue.length === 0 || !this.isOnline) {
      return;
    }

    this.isSyncing = true;
    this.notify();

    this.syncPromise = (async () => {
      try {
        while (this.queue.length > 0) {
          const item = this.queue[0];
          // Simulate network API request processing
          await new Promise((resolve) => setTimeout(resolve, 10));
          this.queue.shift(); // Successfully processed
        }
        this.lastSyncTime = Date.now();
      } catch (err) {
        console.error("Failed syncing offline queue:", err);
      } finally {
        this.isSyncing = false;
        this.syncPromise = null;
        this.notify();
      }
    })();

    return this.syncPromise;
  }

  /**
   * Get overall sync status.
   */
  getSyncStatus(): SyncStatus {
    return {
      isOnline: this.isOnline,
      isSyncing: this.isSyncing,
      pendingCount: this.queue.length,
      lastSyncTime: this.lastSyncTime,
    };
  }

  subscribe(callback: (status: SyncStatus) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify() {
    const status = this.getSyncStatus();
    this.listeners.forEach((cb) => cb(status));
  }
}

export const offlineSyncService = new OfflineSyncManager();
