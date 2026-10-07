import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useAuth } from "../context/AuthContext";
import { useNetwork } from "../context/NetworkContext";
import { colors, spacing } from "../theme";

interface HeaderProps {
  title: string;
  onNotificationsPress?: () => void;
  unreadCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  onNotificationsPress,
  unreadCount = 0,
}) => {
  const { lock, biometryType } = useAuth();
  const { isOnline } = useNetwork();

  return (
    <View style={styles.container}>
      <View>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: isOnline ? colors.success : colors.warning }]} />
          <Text style={styles.statusText}>{isOnline ? "Online" : "Offline"}</Text>
        </View>
      </View>

      <View style={styles.actions}>
        {onNotificationsPress && (
          <TouchableOpacity
            style={styles.iconButton}
            onPress={onNotificationsPress}
            accessibilityRole="button"
            accessibilityLabel="Notifications"
          >
            <Text style={styles.iconText}>🔔</Text>
            {unreadCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.iconButton}
          onPress={lock}
          accessibilityRole="button"
          accessibilityLabel={`Lock with ${biometryType}`}
        >
          <Text style={styles.iconText}>🔒</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.background,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
  },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing.xs,
    position: "relative",
  },
  iconText: {
    fontSize: 20,
  },
  badge: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: colors.danger,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  badgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
});
