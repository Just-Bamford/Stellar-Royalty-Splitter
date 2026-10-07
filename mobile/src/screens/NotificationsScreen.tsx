import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { Header } from "../components/Header";
import { OfflineBanner } from "../components/OfflineBanner";
import { TouchButton } from "../components/TouchButton";
import { pushNotificationService, MobileNotification } from "../services/pushNotifications";
import { colors, spacing } from "../theme";

export const NotificationsScreen: React.FC = () => {
  const [notifications, setNotifications] = useState<MobileNotification[]>(
    pushNotificationService.getNotifications(),
  );
  const [filter, setFilter] = useState<"all" | "distribution" | "reputation" | "dispute">("all");

  useEffect(() => {
    return pushNotificationService.subscribe((list) => {
      setNotifications(list);
    });
  }, []);

  const handleMarkAllRead = () => {
    pushNotificationService.markAllAsRead();
  };

  const handleClear = () => {
    pushNotificationService.clearAll();
  };

  const filtered = notifications.filter((n) => {
    if (filter === "distribution") return n.type === "distribution_completed";
    if (filter === "reputation") return n.type === "reputation_change";
    if (filter === "dispute") return n.type === "dispute_update";
    return true;
  });

  return (
    <View style={styles.container}>
      <Header title="Notifications" />
      <OfflineBanner />

      <View style={styles.filterBar}>
        {(["all", "distribution", "reputation", "dispute"] as const).map((f) => (
          <TouchableOpacity
            key={f}
            onPress={() => setFilter(f)}
            style={[styles.filterChip, filter === f && styles.filterChipActive]}
          >
            <Text style={[styles.filterChipText, filter === f && styles.filterChipTextActive]}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.topActions}>
          <Text style={styles.countText}>{filtered.length} alert(s)</Text>
          <View style={styles.actionButtons}>
            <TouchButton
              title="Mark All Read"
              variant="outline"
              onPress={handleMarkAllRead}
              style={styles.actionBtn}
              textStyle={{ fontSize: 11 }}
            />
            <TouchButton
              title="Clear"
              variant="secondary"
              onPress={handleClear}
              style={styles.actionBtn}
              textStyle={{ fontSize: 11 }}
            />
          </View>
        </View>

        {filtered.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>🔕</Text>
            <Text style={styles.emptyText}>No notifications in this category</Text>
          </View>
        ) : (
          filtered.map((item) => (
            <TouchableOpacity
              key={item.id}
              activeOpacity={0.8}
              onPress={() => pushNotificationService.markAsRead(item.id)}
              style={[styles.notifCard, !item.read && styles.notifCardUnread]}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{item.title}</Text>
                {!item.read && <View style={styles.unreadDot} />}
              </View>
              <Text style={styles.cardBody}>{item.body}</Text>
              <Text style={styles.cardTime}>{new Date(item.timestamp).toLocaleString()}</Text>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  filterBar: {
    flexDirection: "row",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: colors.background,
    marginRight: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterChipActive: {
    backgroundColor: colors.primaryLight,
    borderColor: colors.primary,
  },
  filterChipText: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: "500",
  },
  filterChipTextActive: {
    color: colors.primary,
    fontWeight: "700",
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  topActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  countText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  actionButtons: {
    flexDirection: "row",
  },
  actionBtn: {
    minHeight: 32,
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginLeft: 6,
    marginVertical: 0,
  },
  notifCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  notifCardUnread: {
    borderColor: colors.primary,
    backgroundColor: "rgba(30, 41, 59, 0.8)",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  cardBody: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
    marginBottom: 6,
  },
  cardTime: {
    fontSize: 11,
    color: colors.textSubtle,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xl,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: spacing.sm,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
  },
});
