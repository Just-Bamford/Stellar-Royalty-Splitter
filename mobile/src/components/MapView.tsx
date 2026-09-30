/**
 * MapView Component (#980)
 *
 * Renders nearby collaborators on an interactive map view and displays a
 * local networking events calendar.
 *
 * Map Provider Integration Note:
 * This component is structured to interface with standard React Native map providers
 * (e.g. react-native-maps configured with Google Maps API key on Android and Apple Maps entitlements on iOS).
 * It includes a robust standalone visual radar grid when running in simulated or offline environments.
 *
 * Networking Events Note:
 * Uses a mock/placeholder data model for local networking events since no dedicated events
 * backend schema currently exists in the core contract or backend repositories.
 */

import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { TouchButton } from "./TouchButton";
import {
  geolocationService,
  NearbyCollaborator,
  GeolocationError,
} from "../services/geolocation";
import { colors, spacing } from "../theme";

export interface NetworkingEvent {
  id: string;
  title: string;
  host: string;
  date: string;
  time: string;
  locationName: string;
  distanceMiles: number;
  category: "Royalty Workshop" | "Web3 Creator Meetup" | "Stellar Dev Night";
  attendeesCount: number;
  isRsvpd?: boolean;
}

interface MapViewProps {
  onSelectCollaborator?: (collaborator: NearbyCollaborator) => void;
  onClose?: () => void;
}

export const MapView: React.FC<MapViewProps> = ({ onSelectCollaborator, onClose }) => {
  const [collaborators, setCollaborators] = useState<NearbyCollaborator[]>([]);
  const [selectedCollaborator, setSelectedCollaborator] = useState<NearbyCollaborator | null>(null);
  const [activeRadius, setActiveRadius] = useState<number>(50);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<NetworkingEvent[]>([
    {
      id: "evt-1",
      title: "Stellar Creator Royalty Summit",
      host: "Stellar Community Fund",
      date: "Oct 15, 2026",
      time: "6:00 PM",
      locationName: "Downtown Creative Arts Hub",
      distanceMiles: 3.2,
      category: "Royalty Workshop",
      attendeesCount: 42,
    },
    {
      id: "evt-2",
      title: "Decentralized Music & Gaming Meetup",
      host: "AudioSplit Collective",
      date: "Oct 22, 2026",
      time: "7:30 PM",
      locationName: "Metropolitan Tech Pavilion",
      distanceMiles: 8.5,
      category: "Web3 Creator Meetup",
      attendeesCount: 28,
    },
    {
      id: "evt-3",
      title: "Soroban Smart Contracts Hack Night",
      host: "Bay Area Stellar Devs",
      date: "Nov 02, 2026",
      time: "5:00 PM",
      locationName: "Innovators Lab Co-working",
      distanceMiles: 14.1,
      category: "Stellar Dev Night",
      attendeesCount: 65,
    },
  ]);

  const [activeTab, setActiveTab] = useState<"map" | "events">("map");

  useEffect(() => {
    loadNearbyData();
  }, [activeRadius]);

  const loadNearbyData = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await geolocationService.findNearbyCollaborators(activeRadius);
      setCollaborators(data);
      if (data.length > 0) {
        setSelectedCollaborator(data[0]);
      }
    } catch (err: unknown) {
      if (err instanceof GeolocationError) {
        setError(err.message);
      } else {
        setError("Failed to load nearby collaborators.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleRsvp = (eventId: string) => {
    setEvents((prev) =>
      prev.map((e) =>
        e.id === eventId
          ? {
              ...e,
              isRsvpd: !e.isRsvpd,
              attendeesCount: e.isRsvpd ? e.attendeesCount - 1 : e.attendeesCount + 1,
            }
          : e
      )
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Collaborator Map & Events</Text>
          <Text style={styles.subtitle}>Discover nearby partners and creator networking</Text>
        </View>
        {onClose && (
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Tabs */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === "map" && styles.tabButtonActive]}
          onPress={() => setActiveTab("map")}
        >
          <Text style={[styles.tabText, activeTab === "map" && styles.tabTextActive]}>
            🗺️ Nearby Map ({collaborators.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === "events" && styles.tabButtonActive]}
          onPress={() => setActiveTab("events")}
        >
          <Text style={[styles.tabText, activeTab === "events" && styles.tabTextActive]}>
            📅 Local Events ({events.length})
          </Text>
        </TouchableOpacity>
      </View>

      {/* Error state */}
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchButton
            title="Retry with Permission"
            variant="secondary"
            onPress={loadNearbyData}
            style={{ marginTop: spacing.sm }}
          />
        </View>
      ) : isLoading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Locating nearby collaborators...</Text>
        </View>
      ) : activeTab === "map" ? (
        <ScrollView style={styles.scrollArea} contentContainerStyle={styles.contentContainer}>
          {/* Radius Selector */}
          <View style={styles.radiusRow}>
            <Text style={styles.radiusLabel}>Search Radius:</Text>
            {[10, 25, 50, 100].map((radius) => (
              <TouchableOpacity
                key={radius}
                style={[
                  styles.radiusPill,
                  activeRadius === radius && styles.radiusPillActive,
                ]}
                onPress={() => setActiveRadius(radius)}
              >
                <Text
                  style={[
                    styles.radiusPillText,
                    activeRadius === radius && styles.radiusPillTextActive,
                  ]}
                >
                  {radius} mi
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Radar Visualization Grid */}
          <View style={styles.mapVisualizer}>
            <View style={styles.radarRingOuter} />
            <View style={styles.radarRingMid} />
            <View style={styles.radarRingInner} />
            <View style={styles.userPin}>
              <Text style={styles.userPinIcon}>📍</Text>
              <Text style={styles.userPinLabel}>You</Text>
            </View>

            {collaborators.map((c, index) => {
              const isSelected = selectedCollaborator?.id === c.id;
              // Spread pins visually across the radar
              const angle = (index * 85 * Math.PI) / 180;
              const distanceRatio = Math.min(1, c.distanceMiles / activeRadius);
              const radiusPixels = distanceRatio * 110;
              const posX = Math.cos(angle) * radiusPixels;
              const posY = Math.sin(angle) * radiusPixels;

              return (
                <TouchableOpacity
                  key={c.id}
                  style={[
                    styles.collabPin,
                    { transform: [{ translateX: posX }, { translateY: posY }] },
                    isSelected && styles.collabPinSelected,
                  ]}
                  onPress={() => setSelectedCollaborator(c)}
                >
                  <Text style={styles.collabPinIcon}>👤</Text>
                  <View style={styles.collabPinBadge}>
                    <Text style={styles.collabPinBadgeText}>{c.distanceMiles}m</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Selected Collaborator Card */}
          {selectedCollaborator && (
            <View style={styles.selectedCard}>
              <View style={styles.selectedHeader}>
                <View>
                  <Text style={styles.selectedName}>{selectedCollaborator.name}</Text>
                  <Text style={styles.selectedAddress}>{selectedCollaborator.address}</Text>
                </View>
                <View style={styles.distanceBadge}>
                  <Text style={styles.distanceBadgeText}>
                    {selectedCollaborator.distanceMiles} miles away
                  </Text>
                </View>
              </View>

              <View style={styles.statsRow}>
                <View style={styles.statCol}>
                  <Text style={styles.statLabel}>Revenue Share</Text>
                  <Text style={styles.statVal}>{selectedCollaborator.sharePercent}%</Text>
                </View>
                <View style={styles.statCol}>
                  <Text style={styles.statLabel}>Status</Text>
                  <Text
                    style={[
                      styles.statVal,
                      {
                        color:
                          selectedCollaborator.status === "active"
                            ? colors.success
                            : colors.warning,
                      },
                    ]}
                  >
                    {selectedCollaborator.status.toUpperCase()}
                  </Text>
                </View>
                <View style={styles.statCol}>
                  <Text style={styles.statLabel}>Last Active</Text>
                  <Text style={styles.statVal}>{selectedCollaborator.lastSeen}</Text>
                </View>
              </View>

              {onSelectCollaborator && (
                <TouchButton
                  title="View Royalty Split Contract"
                  variant="primary"
                  onPress={() => onSelectCollaborator(selectedCollaborator)}
                  style={{ marginTop: spacing.sm }}
                />
              )}
            </View>
          )}

          {/* List of nearby collaborators */}
          <Text style={styles.sectionHeading}>Nearby Collaborators ({collaborators.length})</Text>
          {collaborators.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={[
                styles.collabRow,
                selectedCollaborator?.id === c.id && styles.collabRowSelected,
              ]}
              onPress={() => setSelectedCollaborator(c)}
            >
              <View style={styles.collabAvatar}>
                <Text style={{ fontSize: 18 }}>👤</Text>
              </View>
              <View style={{ flex: 1, marginLeft: spacing.sm }}>
                <Text style={styles.collabRowName}>{c.name}</Text>
                <Text style={styles.collabRowAddress}>{c.address}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.collabRowDistance}>{c.distanceMiles} mi</Text>
                <Text style={styles.collabRowShare}>{c.sharePercent}% share</Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : (
        /* Events Calendar View */
        <ScrollView style={styles.scrollArea} contentContainerStyle={styles.contentContainer}>
          <Text style={styles.sectionHeading}>Upcoming Local Creator Events</Text>
          {events.map((evt) => (
            <View key={evt.id} style={styles.eventCard}>
              <View style={styles.eventTopLine}>
                <View style={styles.eventCategoryBadge}>
                  <Text style={styles.eventCategoryText}>{evt.category}</Text>
                </View>
                <Text style={styles.eventDistance}>{evt.distanceMiles} mi away</Text>
              </View>

              <Text style={styles.eventTitle}>{evt.title}</Text>
              <Text style={styles.eventHost}>Organized by {evt.host}</Text>

              <View style={styles.eventMetaGrid}>
                <Text style={styles.eventMetaText}>📅 {evt.date}</Text>
                <Text style={styles.eventMetaText}>⏰ {evt.time}</Text>
                <Text style={styles.eventMetaText}>📍 {evt.locationName}</Text>
                <Text style={styles.eventMetaText}>👥 {evt.attendeesCount} RSVP'd</Text>
              </View>

              <TouchButton
                title={evt.isRsvpd ? "✓ RSVP Confirmed" : "RSVP for Event"}
                variant={evt.isRsvpd ? "secondary" : "primary"}
                onPress={() => handleToggleRsvp(evt.id)}
                style={{ marginTop: spacing.sm }}
              />
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  closeButton: {
    padding: spacing.xs,
  },
  closeText: {
    fontSize: 18,
    color: colors.textMuted,
  },
  tabContainer: {
    flexDirection: "row",
    backgroundColor: colors.card,
    padding: 4,
    margin: spacing.md,
    marginBottom: spacing.xs,
    borderRadius: 12,
  },
  tabButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: "center",
    borderRadius: 8,
  },
  tabButtonActive: {
    backgroundColor: colors.primary,
  },
  tabText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textMuted,
  },
  tabTextActive: {
    color: "#fff",
  },
  scrollArea: {
    flex: 1,
  },
  contentContainer: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  radiusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  radiusLabel: {
    fontSize: 12,
    color: colors.textMuted,
    marginRight: spacing.xs,
  },
  radiusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  radiusPillActive: {
    backgroundColor: colors.primaryLight,
    borderColor: colors.primary,
  },
  radiusPillText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  radiusPillTextActive: {
    color: colors.primary,
    fontWeight: "700",
  },
  mapVisualizer: {
    height: 260,
    backgroundColor: "#0d1527",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
    overflow: "hidden",
    position: "relative",
  },
  radarRingOuter: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.2)",
  },
  radarRingMid: {
    position: "absolute",
    width: 150,
    height: 150,
    borderRadius: 75,
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.3)",
  },
  radarRingInner: {
    position: "absolute",
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.4)",
  },
  userPin: {
    position: "absolute",
    alignItems: "center",
  },
  userPinIcon: {
    fontSize: 22,
  },
  userPinLabel: {
    fontSize: 10,
    color: "#fff",
    fontWeight: "700",
  },
  collabPin: {
    position: "absolute",
    alignItems: "center",
    padding: 4,
  },
  collabPinSelected: {
    transform: [{ scale: 1.25 }],
  },
  collabPinIcon: {
    fontSize: 20,
  },
  collabPinBadge: {
    backgroundColor: colors.card,
    paddingHorizontal: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  collabPinBadgeText: {
    fontSize: 9,
    color: colors.primary,
    fontWeight: "600",
  },
  selectedCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
    marginBottom: spacing.md,
  },
  selectedHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  selectedName: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
  },
  selectedAddress: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: "Courier",
    marginTop: 2,
  },
  distanceBadge: {
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  distanceBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.primary,
  },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  statCol: {
    alignItems: "center",
  },
  statLabel: {
    fontSize: 11,
    color: colors.textMuted,
  },
  statVal: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.text,
    marginTop: 2,
  },
  sectionHeading: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.sm,
  },
  collabRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    padding: spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: spacing.sm,
  },
  collabRowSelected: {
    borderColor: colors.primary,
  },
  collabAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryLight,
    alignItems: "center",
    justifyContent: "center",
  },
  collabRowName: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  collabRowAddress: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: "Courier",
    marginTop: 1,
  },
  collabRowDistance: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.primary,
  },
  collabRowShare: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1,
  },
  eventCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginBottom: spacing.md,
  },
  eventTopLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  eventCategoryBadge: {
    backgroundColor: "rgba(139, 92, 246, 0.15)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  eventCategoryText: {
    fontSize: 11,
    color: colors.accent,
    fontWeight: "600",
  },
  eventDistance: {
    fontSize: 11,
    color: colors.textMuted,
  },
  eventTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
    marginTop: 2,
  },
  eventHost: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  eventMetaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    backgroundColor: "rgba(0, 0, 0, 0.2)",
    padding: spacing.sm,
    borderRadius: 8,
    marginBottom: spacing.xs,
  },
  eventMetaText: {
    fontSize: 12,
    color: colors.text,
    width: "48%",
  },
  errorBox: {
    backgroundColor: colors.dangerLight,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    margin: spacing.md,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
  },
  loadingBox: {
    padding: spacing.xl,
    alignItems: "center",
  },
  loadingText: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.sm,
  },
});
