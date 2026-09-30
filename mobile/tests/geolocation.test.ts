import { describe, it, expect, beforeEach } from "vitest";
import { geolocationService, GeolocationError } from "../src/services/geolocation";

describe("Geolocation & Nearby Collaborators (#980)", () => {
  beforeEach(async () => {
    // Reset test state to clean opt-in default (OFF)
    await geolocationService.setLocationOptIn(false);
    geolocationService._setMockLocation(null);
    geolocationService._setMockPermission(false);
    geolocationService._setMockServicesAvailable(true);
  });

  describe("Privacy Opt-In Control", () => {
    it("defaults location sharing to OFF (false)", async () => {
      const optedIn = await geolocationService.getLocationOptIn();
      expect(optedIn).toBe(false);
    });

    it("allows user to explicitly opt-in and opt-out", async () => {
      await geolocationService.setLocationOptIn(true);
      expect(await geolocationService.getLocationOptIn()).toBe(true);

      await geolocationService.setLocationOptIn(false);
      expect(await geolocationService.getLocationOptIn()).toBe(false);
    });

    it("aborts and throws OPTED_OUT error if location is requested while opted out", async () => {
      await geolocationService.setLocationOptIn(false);
      geolocationService._setMockPermission(true);

      await expect(geolocationService.getCurrentLocation()).rejects.toThrowError(
        /Location sharing is disabled/
      );
    });
  });

  describe("Haversine Distance Calculations", () => {
    it("calculates distance between San Francisco and Oakland accurately", () => {
      // SF: 37.7749, -122.4194; Oakland: 37.8044, -122.2711 (~8.4 miles)
      const miles = geolocationService.calculateDistanceMiles(
        37.7749,
        -122.4194,
        37.8044,
        -122.2711
      );
      expect(miles).toBeGreaterThan(7.5);
      expect(miles).toBeLessThan(9.5);
    });

    it("calculates distance between same coordinates as 0", () => {
      const miles = geolocationService.calculateDistanceMiles(
        37.7749,
        -122.4194,
        37.7749,
        -122.4194
      );
      expect(miles).toBe(0);
    });

    it("converts distance to kilometers accurately", () => {
      const km = geolocationService.calculateDistanceKm(
        37.7749,
        -122.4194,
        37.8044,
        -122.2711
      );
      expect(km).toBeGreaterThan(12);
      expect(km).toBeLessThan(15);
    });
  });

  describe("Primary Flow: Permission Granted & Location Retrieval", () => {
    it("retrieves location when opted in and permission granted", async () => {
      await geolocationService.setLocationOptIn(true);
      geolocationService._setMockPermission(true);
      geolocationService._setMockLocation({
        latitude: 37.7749,
        longitude: -122.4194,
        accuracy: 5,
        timestamp: 1700000000,
      });

      const location = await geolocationService.getCurrentLocation();
      expect(location.latitude).toBe(37.7749);
      expect(location.longitude).toBe(-122.4194);
      expect(location.accuracy).toBe(5);
    });

    it("finds nearby collaborators within specified radius", async () => {
      await geolocationService.setLocationOptIn(true);
      geolocationService._setMockPermission(true);
      geolocationService._setMockLocation({
        latitude: 37.7749,
        longitude: -122.4194,
        accuracy: 5,
        timestamp: 1700000000,
      });

      const nearby = await geolocationService.findNearbyCollaborators(50);
      expect(nearby.length).toBeGreaterThan(0);
      expect(nearby[0].distanceMiles).toBeLessThanOrEqual(50);
      // Sorted nearest first
      if (nearby.length > 1) {
        expect(nearby[0].distanceMiles).toBeLessThanOrEqual(nearby[1].distanceMiles);
      }
    });
  });

  describe("Boundary Cases", () => {
    it("returns empty array when radius is too small to match any collaborators", async () => {
      await geolocationService.setLocationOptIn(true);
      geolocationService._setMockPermission(true);
      geolocationService._setMockLocation({
        latitude: 37.7749,
        longitude: -122.4194,
        accuracy: 5,
        timestamp: 1700000000,
      });

      // Search with 0.1 miles radius (no collaborators within 0.1 mi)
      const nearby = await geolocationService.findNearbyCollaborators(0.1);
      expect(nearby).toEqual([]);
    });
  });

  describe("Failure Cases", () => {
    it("throws PERMISSION_DENIED when permission is rejected", async () => {
      await geolocationService.setLocationOptIn(true);
      geolocationService._setMockPermission(false);

      await expect(geolocationService.getCurrentLocation()).rejects.toThrowError(
        /Location permission was denied/
      );
    });

    it("throws POSITION_UNAVAILABLE when location services are disabled", async () => {
      await geolocationService.setLocationOptIn(true);
      geolocationService._setMockPermission(true);
      geolocationService._setMockServicesAvailable(false);

      await expect(geolocationService.getCurrentLocation()).rejects.toThrowError(
        /Location services are currently disabled/
      );
    });
  });
});
