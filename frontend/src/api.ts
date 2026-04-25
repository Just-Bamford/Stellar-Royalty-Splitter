// Thin client that talks to the Express backend

const BASE = "/api/v1";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data as T;
}

export interface TransactionRecord {
  id: number;
  txHash: string | null;
  contractId: string;
  type: "initialize" | "distribute";
  initiatorAddress: string;
  requestedAmount: string | null;
  tokenId: string | null;
  timestamp: string;
  blockTime: string | null;
  status: "pending" | "confirmed" | "failed";
  errorMessage: string | null;
  payoutCount?: number;
}

export interface TransactionDetails extends TransactionRecord {
  payouts?: Array<{
    collaboratorAddress: string;
    amountReceived: string;
  }>;
}

export interface AuditLogEntry {
  id: number;
  contractId: string;
  action: string;
  user: string | null;
  details: Record<string, unknown> | null;
  timestamp: string;
}

export interface SecondarySale {
  id: number;
  nftId: string;
  previousOwner: string;
  newOwner: string;
  salePrice: string;
  saleToken: string;
  royaltyAmount: string;
  royaltyRate: number;
  timestamp: string;
  transactionHash: string | null;
}

export interface RoyaltyStats {
  totalSecondarySales: number;
  totalRoyaltiesGenerated: string; // always 7 decimal places, never null
  totalVolume: string;             // always 7 decimal places, never null
  pendingRoyaltyPool: string;      // undistributed royalties, 7 decimal places
  lastDistribution: {
    timestamp: string;
    totalRoyaltiesDistributed: string;
    numberOfSales: number;
    txHash: string | null;
  } | null;
}

export const api = {
  initialize: (body: {
    contractId: string;
    walletAddress: string;
    collaborators: string[];
    shares: number[];
  }) => post<{ xdr: string; transactionId: number }>("/initialize", body),

  distribute: (body: {
    contractId: string;
    walletAddress: string;
    tokenId: string;
    amount: number;
  }) => post<{ xdr: string; transactionId: number }>("/distribute", body),

  getCollaborators: (contractId: string) =>
    get<{ address: string; basisPoints: number }[]>(
      `/collaborators/${contractId}`,
    ),

  // Transaction History & Audit Log APIs
  getTransactionHistory: (contractId: string, limit = 50, offset = 0) =>
    get<{ success: boolean; data: TransactionRecord[]; pagination: { limit: number; offset: number; total: number } }>(
      `/history/${contractId}?limit=${limit}&offset=${offset}`,
    ),

  getTransactionDetails: (txHash: string) =>
    get<{ success: boolean; data: TransactionDetails }>(
      `/transaction/${txHash}`,
    ),

  confirmTransaction: (
    txHash: string,
    body: {
      status: "pending" | "confirmed" | "failed";
      blockTime?: string;
      errorMessage?: string;
    },
  ) =>
    post<{ success: boolean; message: string }>(
      `/transaction/confirm/${txHash}`,
      body,
    ),

  getAuditLog: (contractId: string, limit = 100, offset = 0) =>
    get<{ success: boolean; data: AuditLogEntry[] }>(
      `/audit/${contractId}?limit=${limit}&offset=${offset}`,
    ),

  addAuditLog: (
    contractId: string,
    body: {
      action: string;
      user?: string;
      details?: Record<string, unknown>;
    },
  ) =>
    post<{ success: boolean; message: string }>(`/audit/${contractId}`, body),

  // Secondary Royalty APIs
  recordSecondarySale: (body: {
    contractId: string;
    walletAddress: string;
    nftId: string;
    previousOwner: string;
    newOwner: string;
    salePrice: number;
    saleToken: string;
    royaltyRate: number;
  }) =>
    post<{ xdr: string; transactionId: number; royaltyAmount: number }>(
      "/secondary-royalty",
      body,
    ),

  setRoyaltyRate: (body: {
    contractId: string;
    walletAddress: string;
    royaltyRate: number;
  }) =>
    post<{ xdr: string; transactionId: number }>(
      "/secondary-royalty/set-rate",
      body,
    ),

  distributeSecondaryRoyalties: (body: {
    contractId: string;
    walletAddress: string;
    tokenId: string;
  }) =>
    post<{
      xdr: string;
      transactionId: number;
      numberOfSales: number;
      totalRoyalties: string;
    }>("/secondary-royalty/distribute", body),

  getRoyaltyStats: (contractId: string) =>
    get<RoyaltyStats>(`/secondary-royalty/stats/${contractId}`),

  getRoyaltyRate: (contractId: string) =>
    get<{ contractId: string; royaltyRate: number }>(
      `/secondary-royalty/rate/${contractId}`,
    ),

  getSecondarySales: (
    contractId: string,
    limit = 50,
    offset = 0,
    nftId?: string,
  ) =>
    get<{ sales: SecondarySale[]; total: number }>(
      `/secondary-royalty/sales/${contractId}?limit=${limit}&offset=${offset}${nftId ? `&nftId=${nftId}` : ""}`,
    ),

  getSecondaryRoyaltyDistributions: (
    contractId: string,
    limit = 50,
    offset = 0,
  ) =>
    get<{
      distributions: Array<{
        id: number;
        transactionId: number;
        totalRoyaltiesDistributed: string;
        numberOfSales: number;
        timestamp: string;
        txHash: string | null;
        status: string;
        initiatorAddress: string;
      }>;
      total: number;
    }>(
      `/secondary-royalty/distributions/${contractId}?limit=${limit}&offset=${offset}`,
    ),

  // Analytics API
  getAnalytics: (
    contractId: string,
    dateRange?: { start: string; end: string },
  ) =>
    get<{
      success: boolean;
      data: {
        totalDistributed: number;
        totalTransactions: number;
        averagePayout: number;
        topEarners: Array<{
          address: string;
          totalEarned: number;
          payouts: number;
        }>;
        distributionTrends: Array<{
          date: string;
          amount: number;
          count: number;
        }>;
        collaboratorStats: Array<{
          address: string;
          totalEarned: number;
          payoutCount: number;
        }>;
      };
      message?: string;
    }>(
      `/analytics/${contractId}${dateRange ? `?start=${dateRange.start}&end=${dateRange.end}` : ""}`,
    ),

  // Contract version API
  getContractVersion: (contractId: string) =>
    get<{ contractId: string; version: string }>(
      `/contract/version/${contractId}`,
    ),
};
