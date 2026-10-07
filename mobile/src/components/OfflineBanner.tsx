import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useNetwork } from "../context/NetworkContext";
import { colors, spacing } from "../theme";

export const OfflineBanner: React.FC = () => {
  const { isOnline, isSyncing, pendingCount } = useNetwork();

  if (isOnline && pendingCount === 0 && !isSyncing) {
    return null;
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: isOnline ? colors.primaryLight : colors.warningLight },
      ]}
    >
      <Text style={[styles.text, { color: isOnline ? colors.primary : colors.warning }]}>
        {!isOnline
          ? "📡 Offline Mode: Viewing cached data"
          : isSyncing
          ? "🔄 Syncing pending changes..."
          : `⚡ ${pendingCount} change(s) ready to sync`}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  text: {
    fontSize: 13,
    fontWeight: "600",
  },
});
