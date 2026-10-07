export const colors = {
  background: "#0b0f19",
  card: "#131b2e",
  cardBorder: "#1e293b",
  primary: "#3b82f6",
  primaryHover: "#2563eb",
  primaryLight: "rgba(59, 130, 246, 0.15)",
  secondary: "#64748b",
  success: "#10b981",
  successLight: "rgba(16, 185, 129, 0.15)",
  warning: "#f59e0b",
  warningLight: "rgba(245, 158, 11, 0.15)",
  danger: "#ef4444",
  dangerLight: "rgba(239, 68, 68, 0.15)",
  text: "#f8fafc",
  textMuted: "#94a3b8",
  textSubtle: "#64748b",
  accent: "#8b5cf6",
  border: "#1e293b",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  touchTarget: 48, // Minimum touch target size for accessible mobile UI
};

export const typography = {
  titleLarge: { fontSize: 24, fontWeight: "700" as const, color: colors.text },
  titleMedium: { fontSize: 20, fontWeight: "600" as const, color: colors.text },
  body: { fontSize: 15, fontWeight: "400" as const, color: colors.text },
  bodyBold: { fontSize: 15, fontWeight: "600" as const, color: colors.text },
  caption: { fontSize: 13, fontWeight: "400" as const, color: colors.textMuted },
  badge: { fontSize: 12, fontWeight: "600" as const },
};
