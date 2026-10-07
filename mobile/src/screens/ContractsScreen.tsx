import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl } from "react-native";
import { Header } from "../components/Header";
import { OfflineBanner } from "../components/OfflineBanner";
import { ContractCard } from "../components/ContractCard";
import { mobileApi, ContractSummary } from "../services/api";
import { colors, spacing } from "../theme";

export const ContractsScreen: React.FC = () => {
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = async () => {
    const data = await mobileApi.getContracts();
    setContracts(data);
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
      <Header title="My Contracts" />
      <OfflineBanner />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        <Text style={styles.summaryText}>
          You are a split recipient in {contracts.length} active Soroban smart contracts.
        </Text>

        {contracts.map((c) => (
          <ContractCard key={c.id} contract={c} />
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
  summaryText: {
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
});
