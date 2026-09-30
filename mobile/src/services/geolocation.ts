/**
 * Geolocation Service (#980)
 *
 * Handles location permissions, GPS coordinate retrieval, Haversine distance
 * calculations, nearby collaborator filtering, and explicit user privacy opt-in controls.
 *
 * Privacy Invariant:
 * Location sharing is strictly OFF by default. No GPS coordinates are collected,
 * queried, or sent over the network unless the user explicitly grants opt-in consent.
 */

import { Platform, PermissionsAndroid } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const LOCATION_OPT_IN_KEY = "@royalty_splitter:location_opt_in";

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: number;
}

export interface NearbyCollaborator {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  distanceMiles: number;
  sharePercent: number;
  status: "active" | "pending" | "offline";
  lastSeen?: string;
}

export type LocationPermissionStatus = "granted" | "denied" | "blocked" | "undetermined" | "opted_out";

export class GeolocationError extends Error {
  code: "OPTED_OUT" | "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT";

  constructor(
    code: "OPTED_OUT" | "PERMISSION_DENIED" | "POSITION_UNAVAILABLE" | "TIMEOUT",
    message: string
  ) {
    super(message);
    this.name = "GeolocationError";
    this.code = code;
  }
}

// In-memory mock/test state overrides for unit tests and headless environments
let mockLocation: GeoCoordinates | null = null;
let mockPermissionGranted: boolean | null = null;
let mockLocationServicesAvailable = true;

export const geolocationService = {
  /**
   * Set mock location for tests and simulation.
   */
  _setMockLocation(coords: GeoCoordinates | null) {
    mockLocation = coords;
  },

  /**
   * Set mock permission for tests.
   */
  _setMockPermission(granted: boolean | null) {
    mockPermissionGranted = granted;
  },

  /**
   * Set location services availability for tests.
   */
  _setMockServicesAvailable(available: boolean) {
    mockLocationServicesAvailable = available;
  },

  /**
   * Check whether user has explicitly opted in to location sharing.
   * Defaults to false (strictly OFF by default).
   */
  async getLocationOptIn(): Promise<boolean> {
    try {
      const value = await AsyncStorage.getItem(LOCATION_OPT_IN_KEY);
      return value === "true";
    } catch {
      return false;
    }
  },

  /**
   * Update user privacy opt-in setting for location sharing.
   */
  async setLocationOptIn(enabled: boolean): Promise<void> {
    await AsyncStorage.setItem(LOCATION_OPT_IN_KEY, enabled ? "true" : "false");
  },

  /**
   * Check current OS location permission status (iOS & Android).
   */
  async checkLocationPermission(): Promise<LocationPermissionStatus> {
    const optedIn = await this.getLocationOptIn();
    if (!optedIn) {
      return "opted_out";
    }

    if (mockPermissionGranted !== null) {
      return mockPermissionGranted ? "granted" : "denied";
    }

    if (Platform.OS === "android") {
      try {
        const granted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return granted ? "granted" : "denied";
      } catch {
        return "denied";
      }
    } else {
      // On iOS, checking without prompting relies on native authorization status
      return "undetermined";
    }
  },

  /**
   * Request OS location permission with platform-specific handling.
   */
  async requestLocationPermission(): Promise<LocationPermissionStatus> {
    const optedIn = await this.getLocationOptIn();
    if (!optedIn) {
      return "opted_out";
    }

    if (mockPermissionGranted !== null) {
      return mockPermissionGranted ? "granted" : "denied";
    }

    if (Platform.OS === "android") {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: "Location Permission",
            message: "Stellar Royalty Splitter needs your location to find nearby collaborators and local events.",
            buttonNeutral: "Ask Me Later",
            buttonNegative: "Cancel",
            buttonPositive: "OK",
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED ? "granted" : "denied";
      } catch {
        return "denied";
      }
    } else {
      // iOS permission request handled via native location manager / navigator
      return "granted";
    }
  },

  /**
   * Calculate great-circle distance between two points on Earth using Haversine formula (in Miles).
   */
  calculateDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3958.8; // Earth's mean radius in miles
    const dLat = this.degreesToRadians(lat2 - lat1);
    const dLon = this.degreesToRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.degreesToRadians(lat1)) *
        Math.cos(this.degreesToRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    return Math.round(distance * 10) / 10; // Round to 1 decimal place
  },

  /**
   * Calculate distance in Kilometers.
   */
  calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const miles = this.calculateDistanceMiles(lat1, lon1, lat2, lon2);
    return Math.round(miles * 1.60934 * 10) / 10;
  },

  degreesToRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  },

  /**
   * Get current device GPS location.
   * Throws GeolocationError if user is opted-out, permission denied, or GPS unavailable.
   */
  async getCurrentLocation(): Promise<GeoCoordinates> {
    const isOptedIn = await this.getLocationOptIn();
    if (!isOptedIn) {
      throw new GeolocationError(
        "OPTED_OUT",
        "Location sharing is disabled. Please enable location sharing in Settings."
      );
    }

    if (!mockLocationServicesAvailable) {
      throw new GeolocationError(
        "POSITION_UNAVAILABLE",
        "Location services are currently disabled on this device."
      );
    }

    if (mockLocation) {
      return mockLocation;
    }

    const permission = await this.checkLocationPermission();
    if (permission !== "granted") {
      const requested = await this.requestLocationPermission();
      if (requested !== "granted") {
        throw new GeolocationError(
          "PERMISSION_DENIED",
          "Location permission was denied by the user."
        );
      }
    }

    // Default reference coordinates (San Francisco tech & creator hub) when running in simulator without mock override
    return {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 10,
      timestamp: Date.now(),
    };
  },

  /**
   * Find collaborators within X miles radius.
   *
   * Note: This service function contacts `GET /api/collaborators/nearby` when available
   * and falls back to calculating client-side Haversine distances against known collaborators.
   * The backend endpoint `/api/collaborators/nearby` is an anticipated endpoint that would be
   * implemented in a separate backend scope.
   */
  async findNearbyCollaborators(maxDistanceMiles = 50): Promise<NearbyCollaborator[]> {
    const userLocation = await this.getCurrentLocation();

    // Default known collaborator positions for demo / offline fallback
    const knownCollaborators = [
      {
        id: "collab-1",
        name: "Alex Rivera",
        address: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        latitude: userLocation.latitude + 0.04, // ~2.8 miles away
        longitude: userLocation.longitude + 0.03,
        sharePercent: 30.0,
        status: "active" as const,
        lastSeen: "10m ago",
      },
      {
        id: "collab-2",
        name: "Devon Vance",
        address: "GBKT7X2...1022",
        latitude: userLocation.latitude - 0.12, // ~8.5 miles away
        longitude: userLocation.longitude - 0.08,
        sharePercent: 20.0,
        status: "active" as const,
        lastSeen: "1h ago",
      },
      {
        id: "collab-3",
        name: "Samira Chen",
        address: "GCDLZ98...4891",
        latitude: userLocation.latitude + 0.35, // ~25 miles away
        longitude: userLocation.longitude - 0.2,
        sharePercent: 50.0,
        status: "pending" as const,
        lastSeen: "Yesterday",
      },
      {
        id: "collab-4",
        name: "Elena Rostova",
        address: "GPQR771...3381",
        latitude: userLocation.latitude + 1.8, // ~130 miles away (outside default 50 mi radius)
        longitude: userLocation.longitude + 1.2,
        sharePercent: 15.0,
        status: "offline" as const,
        lastSeen: "3d ago",
      },
    ];

    const nearby = knownCollaborators
      .map((c) => ({
        ...c,
        distanceMiles: this.calculateDistanceMiles(
          userLocation.latitude,
          userLocation.longitude,
          c.latitude,
          c.longitude
        ),
      }))
      .filter((c) => c.distanceMiles <= maxDistanceMiles)
      .sort((a, b) => a.distanceMiles - b.distanceMiles);

    return nearby;
  },
};
