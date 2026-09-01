export interface ContractPerformanceRow {
  contractId: string;
  revenue: number;
  transactions: number;
  lastActivity: string | null;
  status?: "active" | "inactive" | "pending";
}

export interface ContractPerformanceSummary {
  totalRevenue: number;
  activeContracts: number;
  transactionsThisMonth: number;
  contracts: Array<{
    contractId: string;
    revenue: number;
    transactions: number;
    lastActivity: string | null;
    status: "active" | "inactive" | "pending";
  }>;
}

export interface ContractPerformanceOptions {
  sortBy?: "revenue" | "transactions" | "name";
  direction?: "asc" | "desc";
  limit?: number;
  dateRange?: { start: string; end: string };
}

function normalizeStatus(row: ContractPerformanceRow): "active" | "inactive" | "pending" {
  if (row.status) return row.status;
  return row.transactions > 0 ? "active" : "inactive";
}

function sortContracts(rows: ContractPerformanceRow[], options: ContractPerformanceOptions) {
  const direction = options.direction ?? "desc";
  const sorted = [...rows].sort((left, right) => {
    const multiplier = direction === "asc" ? 1 : -1;
    if (options.sortBy === "transactions") {
      return (left.transactions - right.transactions) * multiplier;
    }
    if (options.sortBy === "name") {
      return left.contractId.localeCompare(right.contractId) * multiplier;
    }
    return (left.revenue - right.revenue) * multiplier;
  });

  return sorted;
}

export function buildContractPerformanceSummary(
  rows: ContractPerformanceRow[],
  options: ContractPerformanceOptions = {},
): ContractPerformanceSummary {
  const filtered = rows.filter((row) => {
    if (!options.dateRange) return true;
    if (!row.lastActivity) return false;
    const activityDate = new Date(row.lastActivity);
    const start = new Date(options.dateRange.start);
    const end = new Date(options.dateRange.end);
    return activityDate >= start && activityDate <= end;
  });

  const sorted = sortContracts(filtered, options);
  const limited = options.limit ? sorted.slice(0, options.limit) : sorted;

  const contracts = limited.map((row) => ({
    contractId: row.contractId,
    revenue: Number(row.revenue) || 0,
    transactions: Number(row.transactions) || 0,
    lastActivity: row.lastActivity,
    status: normalizeStatus(row),
  }));

  const totalRevenue = contracts.reduce((sum, row) => sum + row.revenue, 0);
  const activeContracts = contracts.filter((row) => row.status === "active").length;
  const transactionsThisMonth = contracts.reduce((sum, row) => sum + row.transactions, 0);

  return {
    totalRevenue,
    activeContracts,
    transactionsThisMonth,
    contracts,
  };
}
