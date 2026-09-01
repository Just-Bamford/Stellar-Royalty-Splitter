import { TransactionRecord } from "../api";

const STROOPS_PER_XLM = 10_000_000;

export function stroopsToXLM(stroops: string | number | null): string {
  if (stroops === null || stroops === undefined || stroops === "") return "";
  const value = typeof stroops === "string" ? parseFloat(stroops) : stroops;
  if (isNaN(value)) return String(stroops);
  // Heuristic: values > 1_000_000 are almost certainly in stroops
  if (value > 1_000_000) {
    return (value / STROOPS_PER_XLM).toFixed(7).replace(/\.?0+$/, "");
  }
  return value.toString();
}

function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface ExportFilter {
  startDate: string | null;
  endDate: string | null;
}

export function filterByDateRange(
  transactions: TransactionRecord[],
  filter: ExportFilter,
): TransactionRecord[] {
  return transactions.filter((tx) => {
    const ts = new Date(tx.timestamp).getTime();
    if (filter.startDate && ts < new Date(filter.startDate).getTime()) return false;
    if (filter.endDate) {
      // Include the full end day
      const end = new Date(filter.endDate);
      end.setHours(23, 59, 59, 999);
      if (ts > end.getTime()) return false;
    }
    return true;
  });
}

export function buildCSV(transactions: TransactionRecord[]): string {
  const headers = [
    "Date",
    "Type",
    "Amount (XLM)",
    "Contract",
    "TX Hash",
    "Status",
    "Initiator",
    "Token / NFT ID",
    "Note",
  ];

  const rows = transactions.map((tx) => [
    escapeCSV(tx.timestamp ? new Date(tx.timestamp).toISOString() : ""),
    escapeCSV(tx.type),
    escapeCSV(stroopsToXLM(tx.requestedAmount)),
    escapeCSV(tx.contractId),
    escapeCSV(tx.txHash),
    escapeCSV(tx.status),
    escapeCSV(tx.initiatorAddress),
    escapeCSV(tx.tokenId),
    escapeCSV(tx.errorMessage),
  ]);

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

export function downloadCSV(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  // Use click() which works on mobile browsers including iOS Safari
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
