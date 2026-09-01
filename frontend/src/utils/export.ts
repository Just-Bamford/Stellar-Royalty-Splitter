/**
 * Multi-format export utilities for Collaborators and Earnings Analytics (#896).
 *
 * Supports CSV and JSON exports with RFC 4180 compliance, formula injection
 * sanitization, and standardized date-stamped filenames (e.g. collaborators-2025-08-20.csv).
 */

export interface CollaboratorExportItem {
  address: string;
  name?: string;
  basisPoints: number;
  sharePercentage: number;
  tier?: string;
  paymentStatus?: "Paid" | "Unpaid" | "Unknown";
  payoutCount?: number;
}

export interface CollaboratorEarningExportItem {
  address: string;
  name?: string;
  basisPoints: number;
  sharePercentage: number;
  totalEarned: number;
  payoutCount: number;
  avgPayout: number;
}

export interface PayoutExportItem {
  id: string | number;
  type: string;
  timestamp: string;
  amount: string | number;
  status: string;
  txHash?: string | null;
  details?: string;
}

export interface ExportMetadata {
  contractId?: string;
  generatedAt?: string;
  activeFilters?: Record<string, string | number | boolean | null | undefined>;
  recordCount?: number;
  totalBasisPoints?: number;
  totalDistributed?: number;
}

/**
 * Returns a date string formatted as `YYYY-MM-DD` (ISO-8601 calendar date).
 */
export function formatDateStamp(date: Date = new Date()): string {
  return date.toISOString().split("T")[0];
}

/**
 * Builds standard auto-generated filenames such as:
 * - `collaborators-2025-08-20.csv`
 * - `collaborators-CABC1234-2025-08-20.json`
 * - `earnings-2025-08-20.csv`
 */
export function buildExportFilename(
  prefix: string,
  extension: "csv" | "json",
  contractId?: string,
  date: Date = new Date(),
): string {
  const dateStr = formatDateStamp(date);
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
  if (contractId && contractId.trim() && contractId !== "__all__") {
    const snippet = contractId.trim().slice(0, 8);
    return `${cleanPrefix}-${snippet}-${dateStr}.${extension}`;
  }
  return `${cleanPrefix}-${dateStr}.${extension}`;
}

/**
 * Escapes a cell value per RFC 4180 and protects against CSV formula injection.
 * Values starting with `=`, `+`, `-`, `@`, `\t`, `\r` are prefixed with `'`.
 */
export function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let str = String(value);

  // Security: Prevent CSV / Formula Injection (CWE-1236)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  // RFC 4180 escaping: wrap in double quotes if containing comma, quote, or newline
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Builds RFC 4180 CSV string for a list of collaborators.
 */
export function buildCollaboratorsCSV(
  collaborators: CollaboratorExportItem[],
): string {
  const headers = [
    "Address",
    "Name",
    "Basis Points",
    "Share (%)",
    "Tier",
    "Payment Status",
    "Payout Count",
  ];

  const rows = collaborators.map((c) => [
    escapeCSV(c.address),
    escapeCSV(c.name ?? ""),
    escapeCSV(c.basisPoints),
    escapeCSV((c.basisPoints / 100).toFixed(2)),
    escapeCSV(c.tier ?? "N/A"),
    escapeCSV(c.paymentStatus ?? "Unknown"),
    escapeCSV(c.payoutCount ?? 0),
  ]);

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
}

/**
 * Builds structured JSON export for collaborators with comprehensive metadata.
 */
export function buildCollaboratorsJSON(
  collaborators: CollaboratorExportItem[],
  metadata: ExportMetadata = {},
): string {
  const totalBasisPoints = collaborators.reduce((sum, c) => sum + (c.basisPoints || 0), 0);
  const payload = {
    metadata: {
      contractId: metadata.contractId ?? null,
      generatedAt: metadata.generatedAt ?? new Date().toISOString(),
      activeFilters: metadata.activeFilters ?? {},
      recordCount: collaborators.length,
      totalBasisPoints,
      totalSharePercentage: (totalBasisPoints / 100).toFixed(2),
    },
    collaborators: collaborators.map((c) => ({
      address: c.address,
      name: c.name ?? null,
      basisPoints: c.basisPoints,
      sharePercentage: +(c.basisPoints / 100).toFixed(2),
      tier: c.tier ?? null,
      paymentStatus: c.paymentStatus ?? null,
      payoutCount: c.payoutCount ?? 0,
    })),
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Builds RFC 4180 CSV string for collaborator earnings and payout history.
 */
export function buildEarningsCSV(
  collaborators: CollaboratorEarningExportItem[],
  payouts: PayoutExportItem[] = [],
): string {
  const collabHeaders = [
    "Collaborator Address",
    "Name",
    "Basis Points",
    "Share (%)",
    "Total Earned",
    "Payout Count",
    "Average Payout",
  ];

  const collabRows = collaborators.map((c) => [
    escapeCSV(c.address),
    escapeCSV(c.name ?? ""),
    escapeCSV(c.basisPoints),
    escapeCSV((c.basisPoints / 100).toFixed(2)),
    escapeCSV(c.totalEarned),
    escapeCSV(c.payoutCount),
    escapeCSV(c.avgPayout),
  ]);

  const sections: string[] = [];
  sections.push("# Collaborator Earnings Breakdown");
  sections.push([collabHeaders.join(","), ...collabRows.map((r) => r.join(","))].join("\r\n"));

  if (payouts.length > 0) {
    const payoutHeaders = [
      "Payout ID",
      "Type",
      "Date",
      "Amount",
      "Status",
      "Transaction Hash",
      "Details",
    ];
    const payoutRows = payouts.map((p) => [
      escapeCSV(p.id),
      escapeCSV(p.type),
      escapeCSV(p.timestamp),
      escapeCSV(p.amount),
      escapeCSV(p.status),
      escapeCSV(p.txHash ?? ""),
      escapeCSV(p.details ?? ""),
    ]);

    sections.push("");
    sections.push("# Recent Payout History");
    sections.push([payoutHeaders.join(","), ...payoutRows.map((r) => r.join(","))].join("\r\n"));
  }

  return sections.join("\r\n");
}

/**
 * Builds structured JSON export for earnings analytics and payout history.
 */
export function buildEarningsJSON(
  data: {
    collaborators: CollaboratorEarningExportItem[];
    payouts?: PayoutExportItem[];
    totalDistributed?: number;
    primaryTotal?: number;
    secondaryTotal?: number;
  },
  metadata: ExportMetadata = {},
): string {
  const payload = {
    metadata: {
      contractId: metadata.contractId ?? null,
      generatedAt: metadata.generatedAt ?? new Date().toISOString(),
      activeFilters: metadata.activeFilters ?? {},
      totalDistributed: data.totalDistributed ?? 0,
      primaryTotal: data.primaryTotal ?? 0,
      secondaryTotal: data.secondaryTotal ?? 0,
      collaboratorCount: data.collaborators.length,
      payoutCount: data.payouts?.length ?? 0,
    },
    earningsSummary: {
      totalDistributed: data.totalDistributed ?? 0,
      primaryTotal: data.primaryTotal ?? 0,
      secondaryTotal: data.secondaryTotal ?? 0,
    },
    collaborators: data.collaborators.map((c) => ({
      address: c.address,
      name: c.name ?? null,
      basisPoints: c.basisPoints,
      sharePercentage: +(c.basisPoints / 100).toFixed(2),
      totalEarned: c.totalEarned,
      payoutCount: c.payoutCount,
      avgPayout: c.avgPayout,
    })),
    recentPayouts: (data.payouts ?? []).map((p) => ({
      id: p.id,
      type: p.type,
      timestamp: p.timestamp,
      amount: p.amount,
      status: p.status,
      txHash: p.txHash ?? null,
      details: p.details ?? null,
    })),
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Downloads text content in the browser as a named file.
 */
export function downloadFile(
  content: string,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadCSV(csv: string, filename: string): void {
  downloadFile(csv, filename, "text/csv;charset=utf-8;");
}

export function downloadJSON(json: string, filename: string): void {
  downloadFile(json, filename, "application/json;charset=utf-8;");
}
