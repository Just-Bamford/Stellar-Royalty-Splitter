/**
 * Tests for analytics tracking middleware — closes #941.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Mock the Mixpanel service
const mockTrackEvent = jest.fn();
const mockSetUserProfile = jest.fn();
const mockTrackFunnelStep = jest.fn();
const mockInitializeUserTracking = jest.fn();

jest.unstable_mockModule("../src/services/mixpanel.js", () => ({
  trackEvent: mockTrackEvent,
  setUserProfile: mockSetUserProfile,
  trackFunnelStep: mockTrackFunnelStep,
  isMixpanelConfigured: jest.fn(() => true),
}));

jest.unstable_mockModule("../src/middleware/tracking.js", () => ({
  initializeUserTracking: mockInitializeUserTracking,
}));

const {
  trackDistributionEvents,
  trackSecondaryRoyaltyEvents,
  trackInitializationEvents,
  trackUserCohort,
  initializeUserTracking,
} = await import("../src/middleware/tracking.js");

describe("Analytics tracking middleware (#941)", () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock request/response
    req = {
      user: { address: "GAAAA...AAAA" },
      headers: {},
    };

    res = {
      statusCode: 200,
      json: jest.fn(function (data) {
        return this;
      }),
    };

    next = jest.fn();
  });

  describe("trackDistributionEvents middleware", () => {
    test("tracks distribution_clicked on request", () => {
      trackDistributionEvents(req, res, next);

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "GAAAA...AAAA",
        "distribute_clicked",
        expect.objectContaining({
          timestamp: expect.any(Number),
        }),
      );
      expect(next).toHaveBeenCalled();
    });

    test("tracks distribution_succeeded on 200 response", () => {
      trackDistributionEvents(req, res, next);

      // Simulate successful response
      res.statusCode = 200;
      res.json({
        data: {
          transactionHash: "tx-hash-123",
        },
      });

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "GAAAA...AAAA",
        "distribution_succeeded",
        expect.any(Object),
      );
    });

    test("tracks distribution_failed on error response", () => {
      trackDistributionEvents(req, res, next);

      // Simulate error response
      res.statusCode = 400;
      res.json({
        code: "validation_failed",
      });

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "GAAAA...AAAA",
        "distribution_failed",
        expect.any(Object),
      );
    });

    test("skips tracking if no user id", () => {
      delete req.user;
      delete req.headers["x-user-id"];

      trackDistributionEvents(req, res, next);

      expect(mockTrackEvent).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  describe("trackSecondaryRoyaltyEvents middleware", () => {
    test("tracks secondary_royalty_recorded on success", () => {
      trackSecondaryRoyaltyEvents(req, res, next);

      res.statusCode = 200;
      res.json({
        data: {
          amount: 5000000,
          source: "opensea",
        },
      });

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "GAAAA...AAAA",
        "secondary_royalty_recorded",
        expect.objectContaining({
          amount: 5000000,
          source: "opensea",
        }),
      );
    });
  });

  describe("trackInitializationEvents middleware", () => {
    test("tracks initialize_started on request", () => {
      trackInitializationEvents(req, res, next);

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "GAAAA...AAAA",
        "initialize_started",
        expect.any(Object),
      );
    });

    test("tracks initialize_completed on success", () => {
      trackInitializationEvents(req, res, next);

      res.statusCode = 200;
      res.json({
        data: {
          transactionHash: "init-tx-hash",
        },
      });

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "GAAAA...AAAA",
        "initialize_completed",
        expect.any(Object),
      );
    });
  });

  describe("trackUserCohort", () => {
    test("sets user profile with cohort data", async () => {
      const userId = "GAAAA...AAAA";
      const cohort = {
        tier: "gold",
        joinDate: "2024-01-15T00:00:00Z",
        distributionFrequency: 7,
      };

      await trackUserCohort(userId, cohort);

      expect(mockSetUserProfile).toHaveBeenCalledWith(userId, {
        collaborator_tier: "gold",
        join_date: "2024-01-15T00:00:00Z",
        distribution_frequency: 7,
        last_updated: expect.any(String),
      });
    });

    test("skips tracking if no userId", async () => {
      await trackUserCohort(null, { tier: "gold" });

      expect(mockSetUserProfile).not.toHaveBeenCalled();
    });
  });

  describe("initializeUserTracking", () => {
    test("initializes tracking for new user", async () => {
      const userId = "GAAAA...AAAA";

      await initializeUserTracking(userId, "gold");

      // Should track user_initialized event
      expect(mockTrackEvent).toHaveBeenCalledWith(
        userId,
        "user_initialized",
        expect.any(Object),
      );
    });

    test("defaults tier to standard", async () => {
      const userId = "GAAAA...AAAA";

      await initializeUserTracking(userId);

      expect(mockTrackEvent).toHaveBeenCalledWith(
        userId,
        "user_initialized",
        expect.objectContaining({
          tier: "standard",
        }),
      );
    });
  });
});
