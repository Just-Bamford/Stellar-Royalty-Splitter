import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing } from "../theme";
import { TouchButton } from "./TouchButton";

interface EarningsCardProps {
  totalEarned: number;
  unclaimedBalance: number;
  currency?: string;
  onClaim?: () => void;
  claimLoading?: boolean;
}

export const EarningsCard: React.FC<EarningsCardProps> = ({
  totalEarned,
  unclaimedBalance,
  currency = "XLM",
  onClaim,
  claimLoading = false,
}) => {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>Total Royalties Earned</Text>
      <Text style={styles.amount}>
        {totalEarned.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{" "}
        <Text style={styles.currency}>{currency}</Text>
      </Text>

      <View style={styles.divider} />

      <View style={styles.unclaimedRow}>
        <View>
          <Text style={styles.unclaimedLabel}>Unclaimed Payout</Text>
          <Text style={styles.unclaimedAmount}>
            {unclaimedBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{" "}
            {currency}
          </Text>
        </View>

        {onClaim && (
          <TouchButton
            title="Claim Royalties"
            onPress={onClaim}
            loading={claimLoading}
            variant="primary"
            style={styles.claimButton}
          />
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginVertical: spacing.sm,
  },
  label: {
    fontSize: 13,
    color: colors.textMuted,
    fontWeight: "500",
  },
  amount: {
    fontSize: 28,
    fontWeight: "700",
    color: colors.text,
    marginTop: 4,
  },
  currency: {
    fontSize: 16,
    color: colors.primary,
    fontWeight: "600",
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  unclaimedRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  unclaimedLabel: {
    fontSize: 12,
    color: colors.textMuted,
  },
  unclaimedAmount: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.success,
    marginTop: 2,
  },
  claimButton: {
    minWidth: 140,
    marginVertical: 0,
  },
});
