import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { Header } from "../components/Header";
import { OfflineBanner } from "../components/OfflineBanner";
import { EarningsCard } from "../components/EarningsCard";
import { ContractCard } from "../components/ContractCard";
import { TouchButton } from "../components/TouchButton";
import { useWallet } from "../context/WalletContext";
import { mobileApi, ContractSummary } from "../services/api";
import { CachedEarnings } from "../services/offlineSync";
import { pushNotificationService } from "../services/pushNotifications";
import { colors, spacing } from "../theme";

interface DashboardScreenProps {
  onNavigate: (tab: string) => void;
}

export const DashboardScreen: React.FC<DashboardScreenProps> = ({ onNavigate }) => {
  const { session, isConnected, connect } = useWallet();
  const [earnings, setEarnings] = useState<CachedEarnings | null>(null);
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [claimLoading, setClaimLoading] = useState(false);
  const [unreadCount, setUnreadCount] = useState(pushNotificationService.getUnreadCount());

  const loadData = async () => {
    try {
      const [earningsData, contractsData] = await Promise.all([
        mobileApi.getEarnings(),
        mobileApi.getContracts(),
      ]);
      setEarnings(earningsData);
      setContracts(contractsData);
    } catch (err) {
      console.error("Dashboard load failed:", err);
    }
  };

  useEffect(() => {
    void loadData();
    const unsub = pushNotificationService.subscribe(() => {
      setUnreadCount(pushNotificationService.getUnreadCount());
    });
    return unsub;
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const handleClaim = async () => {
    setClaimLoading(true);
    try {
      await mobileApi.claimRoyalties("CDLZ...4891");
      await loadData();
    } finally {
      setClaimLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Header
        title="Dashboard"
        onNotificationsPress={() => onNavigate("notifications")}
        unreadCount={unreadCount}
      />
      <OfflineBanner />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {!isConnected ? (
          <View style={styles.walletPrompt}>
            <Text style={styles.promptTitle}>Connect Mobile Wallet</Text>
            <Text style={styles.promptText}>
              Connect MetaMask Mobile, Freighter, or WalletConnect to view real-time earnings and sign royalty splits.
            </Text>
            <TouchButton
              title="Connect Freighter"
              onPress={() => connect("freighter")}
              style={styles.walletBtn}
            />
            <TouchButton
              title="Connect MetaMask Mobile"
              onPress={() => connect("metamask")}
              variant="outline"
              style={styles.walletBtn}
            />
          </View>
        ) : (
          <View style={styles.connectedBadge}>
            <Text style={styles.connectedLabel}>Connected: </Text>
            <Text style={styles.connectedAddress}>
              {session?.address.substring(0, 8)}...{session?.address.substring(session.address.length - 4)}
            </Text>
          </View>
        )}

        {earnings && (
          <EarningsCard
            totalEarned={earnings.totalEarned}
            unclaimedBalance={earnings.unclaimedBalance}
            currency={earnings.currency}
            onClaim={handleClaim}
            claimLoading={claimLoading}
          />
        )}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Active Royalty Contracts</Text>
          <TouchButton
            title="See All"
            variant="outline"
            onPress={() => onNavigate("contracts")}
            style={styles.seeAllBtn}
            textStyle={{ fontSize: 12 }}
          />
        </View>

        {contracts.map((c) => (
          <ContractCard key={c.id} contract={c} onPress={() => onNavigate("contracts")} />
        ))}
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
  walletPrompt: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  promptTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 4,
  },
  promptText: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: spacing.md,
    lineHeight: 18,
  },
  walletBtn: {
    marginVertical: 4,
  },
  connectedBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: 8,
    marginBottom: spacing.xs,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  connectedLabel: {
    fontSize: 12,
    color: colors.textMuted,
  },
  connectedAddress: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.primary,
    fontFamily: "Courier",
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.text,
  },
  seeAllBtn: {
    minHeight: 32,
    paddingVertical: 4,
    paddingHorizontal: 12,
    marginVertical: 0,
  },
});
