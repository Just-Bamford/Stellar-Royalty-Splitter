import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { ContractSummary } from "../services/api";
import { colors, spacing } from "../theme";

interface ContractCardProps {
  contract: ContractSummary;
  onPress?: () => void;
}

export const ContractCard: React.FC<ContractCardProps> = ({ contract, onPress }) => {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      style={styles.card}
      accessibilityRole="button"
    >
      <View style={styles.header}>
        <Text style={styles.name}>{contract.name}</Text>
        <View
          style={[
            styles.badge,
            {
              backgroundColor:
                contract.status === "active"
                  ? colors.successLight
                  : contract.status === "pending"
                  ? colors.warningLight
                  : colors.dangerLight,
            },
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              {
                color:
                  contract.status === "active"
                    ? colors.success
                    : contract.status === "pending"
                    ? colors.warning
                    : colors.danger,
              },
            ]}
          >
            {contract.status.toUpperCase()}
          </Text>
        </View>
      </View>

      <Text style={styles.id}>Contract: {contract.id}</Text>

      <View style={styles.metricsRow}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>My Royalty Split</Text>
          <Text style={styles.metricValue}>{contract.mySharePercent}%</Text>
        </View>

        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Total Distributed</Text>
          <Text style={styles.metricValue}>
            {contract.totalDistributed.toLocaleString()} {contract.currency}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginVertical: spacing.xs,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  name: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  id: {
    fontSize: 12,
    color: colors.textSubtle,
    fontFamily: "Courier",
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
  metricsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: colors.background,
    borderRadius: 10,
    padding: spacing.sm,
  },
  metric: {
    flex: 1,
  },
  metricLabel: {
    fontSize: 11,
    color: colors.textMuted,
  },
  metricValue: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
    marginTop: 2,
  },
});
