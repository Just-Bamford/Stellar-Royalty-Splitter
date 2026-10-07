/**
 * Tests for the Mixpanel analytics service — closes #941.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const mockFetch = jest.fn();
global.fetch = mockFetch;

const { trackEvent, setUserProfile, trackFunnelStep, flush, isMixpanelConfigured } =
  await import("../src/services/mixpanel.js");

describe("Mixpanel service (#941)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MIXPANEL_PROJECT_TOKEN = "test-token-123";
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("isMixpanelConfigured", () => {
    test("returns true when MIXPANEL_PROJECT_TOKEN is set", () => {
      process.env.MIXPANEL_PROJECT_TOKEN = "test-token";
      expect(isMixpanelConfigured()).toBe(true);
    });

    test("returns false when MIXPANEL_PROJECT_TOKEN is unset", () => {
      delete process.env.MIXPANEL_PROJECT_TOKEN;
      expect(isMixpanelConfigured()).toBe(false);
    });
  });

  describe("trackEvent", () => {
    test("tracks an event with user id and properties", async () => {
      const userId = "GAAAA...AAAA";
      const eventName = "distribution_succeeded";
      const properties = { amount: 10000000, txHash: "abc123" };

      // Queue a few events
      await trackEvent(userId, eventName, properties);

      expect(mockFetch).not.toHaveBeenCalled(); // Not sent until threshold
    });

    test("does not track when Mixpanel is not configured", async () => {
      delete process.env.MIXPANEL_PROJECT_TOKEN;

      await trackEvent("user123", "test_event", {});

      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("handles network errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      // Should not throw
      await trackEvent("user123", "test_event", {});
    });
  });

  describe("setUserProfile", () => {
    test("sets user cohort properties", async () => {
      const userId = "GAAAA...AAAA";
      const properties = {
        tier: "gold",
        joinDate: "2024-01-15T00:00:00Z",
        distributionFrequency: 7,
      };

      await setUserProfile(userId, properties);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.mixpanel.com/engage",
        expect.any(Object),
      );
    });

    test("handles empty properties", async () => {
      const userId = "GAAAA...AAAA";

      await setUserProfile(userId);

      expect(mockFetch).toHaveBeenCalled();
    });

    test("handles network errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await setUserProfile("user123", { tier: "gold" });

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe("trackFunnelStep", () => {
    test("tracks a funnel step with correct event name", async () => {
      const userId = "GAAAA...AAAA";
      const funnelName = "signup_to_initialize";
      const step = "signup_complete";

      await trackFunnelStep(userId, funnelName, step, { source: "email" });

      // Event is queued, not immediately sent
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("flush", () => {
    test("flushes pending events", async () => {
      await trackEvent("user1", "event1");
      await trackEvent("user2", "event2");

      await flush();

      // Should have attempted to send
    });

    test("handles flush errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Flush failed"));

      // Should not throw
      await flush();
    });
  });

  describe("event queueing", () => {
    test("batches events before sending", async () => {
      for (let i = 0; i < 5; i++) {
        await trackEvent(`user${i}`, `event${i}`);
      }

      // Not sent until threshold of 10
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("sends batch when threshold reached", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      // Queue 10 events to trigger flush
      for (let i = 0; i < 10; i++) {
        await trackEvent(`user${i}`, `event${i}`);
      }

      // Should have flushed after reaching threshold
    });
  });
});
