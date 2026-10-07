import { describe, it, expect, beforeEach } from "vitest";
import { offlineSyncService, CachedEarnings } from "../src/services/offlineSync";

describe("Offline-First Architecture & Sync", () => {
  beforeEach(async () => {
    offlineSyncService.clearQueue();
    offlineSyncService.setOnlineStatus(true);
  });

  it("retrieves cached earnings while offline", async () => {
    offlineSyncService.setOnlineStatus(false);
    expect(offlineSyncService.getOnlineStatus()).toBe(false);

    const cached = await offlineSyncService.getCachedEarnings();
    expect(cached).not.toBeNull();
    expect(cached?.totalEarned).toBeGreaterThan(0);
    expect(cached?.currency).toBe("XLM");
  });

  it("saves and reads updated earnings cache", async () => {
    const newEarnings: CachedEarnings = {
      totalEarned: 99999.0,
      unclaimedBalance: 1200.0,
      currency: "XLM",
      lastUpdated: Date.now(),
      recentDistributions: [],
    };

    await offlineSyncService.saveCachedEarnings(newEarnings);
    const retrieved = await offlineSyncService.getCachedEarnings();
    expect(retrieved?.totalEarned).toBe(99999.0);
  });

  it("enqueues mutation actions and reports pending count", async () => {
    offlineSyncService.setOnlineStatus(false);
    const action = await offlineSyncService.enqueueAction("claim_earnings", { contractId: "C123" });
    expect(action.type).toBe("claim_earnings");

    const status = offlineSyncService.getSyncStatus();
    expect(status.pendingCount).toBeGreaterThan(0);
  });

  it("synchronizes pending queue automatically when reconnected", async () => {
    offlineSyncService.setOnlineStatus(false);
    await offlineSyncService.enqueueAction("update_tier", { tier: "vip" });
    expect(offlineSyncService.getSyncStatus().pendingCount).toBeGreaterThan(0);

    // Reconnect
    offlineSyncService.setOnlineStatus(true);
    await offlineSyncService.syncPendingQueue();

    expect(offlineSyncService.getSyncStatus().pendingCount).toBe(0);
    expect(offlineSyncService.getSyncStatus().isOnline).toBe(true);
  });
});
