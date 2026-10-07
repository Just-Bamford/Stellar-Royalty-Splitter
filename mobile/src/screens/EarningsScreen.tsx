import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { Header } from "../components/Header";
import { OfflineBanner } from "../components/OfflineBanner";
import { EarningsCard } from "../components/EarningsCard";
import { TouchButton } from "../components/TouchButton";
import { mobileApi } from "../services/api";
import { CachedEarnings } from "../services/offlineSync";
import { colors, spacing } from "../theme";

export const EarningsScreen: React.FC = () => {
  const [earnings, setEarnings] = useState<CachedEarnings | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [timeframe, setTimeframe] = useState<"30D" | "90D" | "1Y" | "ALL">("30D");

  const loadData = async () => {
    const data = await mobileApi.getEarnings();
    setEarnings(data);
  };

  useEffect(() => {
    void loadData();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  return (
    <View style={styles.container}>
      <Header title="Royalty Earnings" />
      <OfflineBanner />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {earnings && (
          <EarningsCard
            totalEarned={earnings.totalEarned}
            unclaimedBalance={earnings.unclaimedBalance}
            currency={earnings.currency}
          />
        )}

        <View style={styles.timeframeRow}>
          {(["30D", "90D", "1Y", "ALL"] as const).map((tf) => (
            <TouchButton
              key={tf}
              title={tf}
              variant={timeframe === tf ? "primary" : "secondary"}
              onPress={() => setTimeframe(tf)}
              style={styles.timeframeBtn}
              textStyle={{ fontSize: 12 }}
            />
          ))}
        </View>

        <View style={styles.historyCard}>
          <Text style={styles.cardTitle}>Distribution History</Text>

          {earnings?.recentDistributions.map((item) => (
            <View key={item.id} style={styles.txRow}>
              <View>
                <Text style={styles.txContract}>{item.contractId}</Text>
                <Text style={styles.txDate}>{new Date(item.timestamp).toLocaleDateString()}</Text>
              </View>
              <Text style={styles.txAmount}>
                +{item.amount.toFixed(2)} {earnings.currency}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  timeframeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginVertical: spacing.sm,
  },
  timeframeBtn: {
    flex: 1,
    marginHorizontal: 3,
    minHeight: 36,
    paddingVertical: 6,
    paddingHorizontal: 0,
  },
  historyCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    marginTop: spacing.sm,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.md,
  },
  txRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  txContract: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  txDate: {
    fontSize: 12,
    color: colors.textSubtle,
    marginTop: 2,
  },
  txAmount: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.success,
  },
});
