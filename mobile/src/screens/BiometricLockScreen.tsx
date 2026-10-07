import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useAuth } from "../context/AuthContext";
import { TouchButton } from "../components/TouchButton";
import { colors, spacing } from "../theme";

export const BiometricLockScreen: React.FC = () => {
  const { unlock, biometryType } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUnlock = async () => {
    setLoading(true);
    setError(null);
    try {
      const success = await unlock();
      if (!success) {
        setError("Biometric recognition failed. Try again.");
      }
    } catch (err: any) {
      setError(err.message || "Authentication error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Text style={styles.icon}>
            {biometryType === "FaceID" ? "👤" : biometryType === "TouchID" || biometryType === "Fingerprint" ? "👆" : "🔒"}
          </Text>
        </View>

        <Text style={styles.title}>Stellar Royalty Splitter</Text>
        <Text style={styles.subtitle}>
          Authenticate with {biometryType === "None" ? "passcode" : biometryType} to unlock your wallet dashboard
        </Text>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <TouchButton
          title={`Unlock with ${biometryType}`}
          onPress={handleUnlock}
          loading={loading}
          style={styles.unlockButton}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  content: {
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
  },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.primaryLight,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  icon: {
    fontSize: 44,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.text,
    textAlign: "center",
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: "center",
    marginBottom: spacing.xl,
    lineHeight: 20,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginBottom: spacing.md,
    textAlign: "center",
  },
  unlockButton: {
    width: "100%",
  },
});
