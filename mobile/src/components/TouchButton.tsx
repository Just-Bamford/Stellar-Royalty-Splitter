import React from "react";
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator, ViewStyle, TextStyle } from "react-native";
import { colors, spacing } from "../theme";

interface TouchButtonProps {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "outline";
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  icon?: React.ReactNode;
}

export const TouchButton: React.FC<TouchButtonProps> = ({
  title,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  style,
  textStyle,
  icon,
}) => {
  const getBackgroundColor = () => {
    if (disabled) return colors.cardBorder;
    switch (variant) {
      case "primary":
        return colors.primary;
      case "secondary":
        return colors.card;
      case "danger":
        return colors.danger;
      case "outline":
        return "transparent";
      default:
        return colors.primary;
    }
  };

  const getTextColor = () => {
    if (disabled) return colors.textSubtle;
    if (variant === "outline") return colors.primary;
    return colors.text;
  };

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      disabled={disabled || loading}
      style={[
        styles.button,
        { backgroundColor: getBackgroundColor() },
        variant === "outline" && styles.outlineBorder,
        style,
      ]}
      accessibilityRole="button"
    >
      {loading ? (
        <ActivityIndicator color={colors.text} size="small" />
      ) : (
        <>
          {icon}
          <Text style={[styles.text, { color: getTextColor() }, textStyle]}>{title}</Text>
        </>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    minHeight: spacing.touchTarget, // 48px min touch target
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginVertical: spacing.xs,
  },
  outlineBorder: {
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  text: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
});
