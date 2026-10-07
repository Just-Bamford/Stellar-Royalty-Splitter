import { describe, it, expect, beforeEach } from "vitest";
import { mobileApi } from "../src/services/api";
import { offlineSyncService } from "../src/services/offlineSync";

describe("Mobile API Interceptor", () => {
  beforeEach(() => {
    offlineSyncService.setOnlineStatus(true);
  });

  it("fetches live earnings and caches for offline use", async () => {
    const earnings = await mobileApi.getEarnings();
    expect(earnings.totalEarned).toBeGreaterThan(0);
    expect(earnings.currency).toBe("XLM");

    // Check that it was cached
    const cached = await offlineSyncService.getCachedEarnings();
    expect(cached?.totalEarned).toBe(earnings.totalEarned);
  });

  it("returns cached earnings when offline", async () => {
    await mobileApi.getEarnings(); // Populates cache
    offlineSyncService.setOnlineStatus(false);

    const offlineData = await mobileApi.getEarnings();
    expect(offlineData).toBeDefined();
    expect(offlineData.unclaimedBalance).toBeGreaterThan(0);
  });

  it("fetches contracts list", async () => {
    const contracts = await mobileApi.getContracts();
    expect(contracts.length).toBeGreaterThan(0);
    expect(contracts[0].id).toBeDefined();
    expect(contracts[0].mySharePercent).toBeGreaterThan(0);
  });

  it("queues claimRoyalties action when offline", async () => {
    offlineSyncService.setOnlineStatus(false);
    const res = await mobileApi.claimRoyalties("CDLZ...4891");
    expect(res.success).toBe(true);
    expect(res.queued).toBe(true);
  });
});
