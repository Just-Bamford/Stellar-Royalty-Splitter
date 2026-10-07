import React, { useState } from "react";
import { SafeAreaView, View, Text, StyleSheet, TouchableOpacity, StatusBar } from "react-native";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { WalletProvider } from "./context/WalletContext";
import { NetworkProvider } from "./context/NetworkContext";
import { BiometricLockScreen } from "./screens/BiometricLockScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { EarningsScreen } from "./screens/EarningsScreen";
import { ContractsScreen } from "./screens/ContractsScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { colors, spacing } from "./theme";

const TABS = [
  { id: "dashboard", label: "Dashboard", icon: "📊" },
  { id: "earnings", label: "Earnings", icon: "💰" },
  { id: "contracts", label: "Contracts", icon: "📜" },
  { id: "notifications", label: "Alerts", icon: "🔔" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

const MainNavigator: React.FC = () => {
  const { isUnlocked } = useAuth();
  const [activeTab, setActiveTab] = useState("dashboard");

  if (!isUnlocked) {
    return <BiometricLockScreen />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <View style={styles.container}>
        <View style={styles.screenContainer}>
          {activeTab === "dashboard" && <DashboardScreen onNavigate={setActiveTab} />}
          {activeTab === "earnings" && <EarningsScreen />}
          {activeTab === "contracts" && <ContractsScreen />}
          {activeTab === "notifications" && <NotificationsScreen />}
          {activeTab === "settings" && <SettingsScreen />}
        </View>

        {/* Bottom Mobile Navigation Bar */}
        <View style={styles.tabBar}>
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <TouchableOpacity
                key={tab.id}
                onPress={() => setActiveTab(tab.id)}
                style={[styles.tabItem, isActive && styles.tabItemActive]}
                accessibilityRole="button"
                accessibilityLabel={tab.label}
              >
                <Text style={styles.tabIcon}>{tab.icon}</Text>
                <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </SafeAreaView>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <WalletProvider>
        <NetworkProvider>
          <MainNavigator />
        </NetworkProvider>
      </WalletProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  screenContainer: {
    flex: 1,
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: spacing.xs,
    paddingBottom: spacing.sm,
    justifyContent: "space-around",
    alignItems: "center",
  },
  tabItem: {
    flex: 1,
    minHeight: spacing.touchTarget, // 48px touch target
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 4,
  },
  tabItemActive: {
    borderTopWidth: 2,
    borderTopColor: colors.primary,
    marginTop: -2,
  },
  tabIcon: {
    fontSize: 18,
    marginBottom: 2,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: "500",
    color: colors.textMuted,
  },
  tabLabelActive: {
    color: colors.primary,
    fontWeight: "700",
  },
});
