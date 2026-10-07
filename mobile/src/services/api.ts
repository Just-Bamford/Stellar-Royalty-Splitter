/**
 * Mobile API Service with Offline Interceptor
 */
import { offlineSyncService, CachedEarnings } from "./offlineSync";

export interface ContractSummary {
  id: string;
  name: string;
  mySharePercent: number;
  totalDistributed: number;
  currency: string;
  status: "active" | "pending" | "disputed";
}

export const mobileApi = {
  /**
   * Fetch earnings overview — returns cached data if offline.
   */
  async getEarnings(): Promise<CachedEarnings> {
    const isOnline = offlineSyncService.getOnlineStatus();
    if (!isOnline) {
      const cached = await offlineSyncService.getCachedEarnings();
      if (cached) return cached;
    }

    const liveData: CachedEarnings = {
      totalEarned: 15450.25,
      unclaimedBalance: 1450.0,
      currency: "XLM",
      lastUpdated: Date.now(),
      recentDistributions: [
        {
          id: "dist-101",
          contractId: "CDLZ...4891",
          amount: 500.0,
          timestamp: Date.now() - 1800000,
          txHash: "b2c3d4e5f6a1...",
        },
        {
          id: "dist-102",
          contractId: "CBKT...1022",
          amount: 950.0,
          timestamp: Date.now() - 7200000,
          txHash: "c3d4e5f6a1b2...",
        },
      ],
    };

    await offlineSyncService.saveCachedEarnings(liveData);
    return liveData;
  },

  /**
   * Fetch contracts list.
   */
  async getContracts(): Promise<ContractSummary[]> {
    return [
      {
        id: "CDLZ...4891",
        name: "Album Royalty Split",
        mySharePercent: 25.0,
        totalDistributed: 34500.0,
        currency: "XLM",
        status: "active",
      },
      {
        id: "CBKT...1022",
        name: "Game Soundtrack Split",
        mySharePercent: 15.0,
        totalDistributed: 18200.0,
        currency: "XLM",
        status: "active",
      },
      {
        id: "CPQR...7719",
        name: "Art License Royalty",
        mySharePercent: 50.0,
        totalDistributed: 8900.0,
        currency: "XLM",
        status: "pending",
      },
    ];
  },

  /**
   * Claim unclaimed royalties (optimistic offline queued).
   */
  async claimRoyalties(contractId: string): Promise<{ success: boolean; queued: boolean }> {
    const isOnline = offlineSyncService.getOnlineStatus();
    if (!isOnline) {
      await offlineSyncService.enqueueAction("claim_earnings", { contractId });
      return { success: true, queued: true };
    }
    return { success: true, queued: false };
  },
};
