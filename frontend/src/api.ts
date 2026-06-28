// Thin client that talks to the Express backend

import { signWriteRequest } from "./lib/request-signing";

const BASE = "/api/v1";
export const SESSION_EXPIRED_EVENT = "srs:session-expired";
const SESSION_EXPIRED_MESSAGE =
  "Your session has expired. Please connect your wallet again.";

let sessionExpiryNotified = false;

function notifySessionExpired() {
  if (sessionExpiryNotified || typeof window === "undefined") return;
  sessionExpiryNotified = true;
  window.dispatchEvent(
    new CustomEvent(SESSION_EXPIRED_EVENT, {
      detail: { message: SESSION_EXPIRED_MESSAGE },
    }),
  );
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getErrorMessage(data: unknown, status: number) {
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    return data.error;
  }

  return `Request failed (${status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const data = await readJson(res);

  if (res.status === 401) {
    notifySessionExpired();
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }

  if (res.ok) {
    sessionExpiryNotified = false;
    return data as T;
  }

  throw new Error(getErrorMessage(data, res.status));
}

async function post<T>(
  path: string,
  body: unknown,
  walletAddress?: string,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (walletAddress && typeof body === "object" && body !== null) {
    try {
      const signingHeaders = await signWriteRequest({
        method: "POST",
        path: `${BASE}${path}`,
        body,
        walletAddress,
      });
      Object.assign(headers, signingHeaders);
    } catch {
      // Signing is optional when REQUEST_SIGNING_REQUIRED=false on the server.
    }
  }

  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }

  return request<T>(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Generate a fresh idempotency key for retry-safe POST requests.
 * Generate once per user action, then pass the same key on every retry.
 */
export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, signal ? { signal } : undefined);
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
  details: string | null;
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
  totalRoyaltiesGenerated: number | string;
  lastDistribution: {
    timestamp: string;
    totalRoyaltiesDistributed: string;
    numberOfSales: number;
  } | null;
}

export type ContractStateCacheStatus = "cached" | "live" | "error";

export interface ContractState {
  contractId: string;
  adminAddress: string | null;
  royaltyRate: number;
  recipients: Array<{ address: string; basisPoints: number }>;
  balance: string;
  tokenId: string;
  network: string;
  networkPassphrase?: string;
  cacheStatus: Exclude<ContractStateCacheStatus, "error">;
  cacheTtlMs: number;
  fetchedAt: string;
}

export const api = {
  initialize: (body: {
    contractId: string;
    walletAddress: string;
    collaborators: string[];
    shares: number[];
    nonce?: string;
  }) =>
    post<{ xdr: string; transactionId: number }>(
      "/initialize",
      body,
      body.walletAddress,
    ),

  commitInitialize: (body: {
    contractId: string;
    walletAddress: string;
    collaboratorsHash: string;
    sharesHash: string;
    nonce: string;
  }) =>
    post<{ xdr: string; transactionId: number; phase: string }>(
      "/initialize/commit",
      body,
      body.walletAddress,
    ),

  revealInitialize: (body: {
    contractId: string;
    walletAddress: string;
    collaborators: string[];
    shares: number[];
    salt: string;
  }) =>
    post<{ xdr: string; transactionId: number; phase: string }>(
      "/initialize/reveal",
      body,
      body.walletAddress,
    ),

  distribute: (body: {
    contractId: string;
    walletAddress: string;
    tokenId: string;
    amount: number;
  }) =>
  distribute: (
    body: {
      contractId: string;
      walletAddress: string;
      tokenId: string;
    },
    idempotencyKey?: string,
  ) =>
    post<{ xdr: string; transactionId: number }>(
      "/distribute",
      body,
      body.walletAddress,
      idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    ),

  getContractBalance: (contractId: string, tokenId: string) =>
    get<{ balance: string }>(
      `/contract/balance/${contractId}?tokenId=${encodeURIComponent(tokenId)}`,
    ),

  getCollaborators: (contractId: string) =>
    get<{ address: string; basisPoints: number }[]>(
      `/collaborators/${contractId}`,
    ),

  // Transaction History & Audit Log APIs
  getTransactionHistory: (contractId: string, limit = 50, offset = 0) =>
    get<{
      success: boolean;
      data: TransactionRecord[];
      pagination: { limit: number; offset: number; total: number };
    }>(`/history/${contractId}?limit=${limit}&offset=${offset}`),

  getTransactionDetails: (txHash: string, signal?: AbortSignal) =>
    get<{ success: boolean; data: TransactionDetails }>(
      `/transaction/${txHash}`,
      signal,
    ),

  confirmTransaction: (
    txHash: string,
    body: {
      status: "pending" | "confirmed" | "failed";
      blockTime?: string;
      errorMessage?: string;
      transactionId?: number;
    },
    walletAddress?: string,
  ) =>
    post<{ success: boolean; message: string }>(
      `/transaction/confirm/${txHash}`,
      body,
      walletAddress,
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
    post<{ success: boolean; message: string }>(
      `/audit/${contractId}`,
      body,
      body.user,
    ),

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
      body.walletAddress,
    ),

  setRoyaltyRate: (body: {
    contractId: string;
    walletAddress: string;
    royaltyRate: number;
  }) =>
    post<{ xdr: string; transactionId: number }>(
      "/secondary-royalty/set-rate",
      body,
      body.walletAddress,
    ),

  distributeSecondaryRoyalties: (
    body: {
      contractId: string;
      walletAddress: string;
      tokenId: string;
    },
    idempotencyKey?: string,
  ) =>
    post<{
      xdr: string;
      transactionId: number;
      numberOfSales: number;
      totalRoyalties: string;
    }>(
      "/secondary-royalty/distribute",
      body,
      body.walletAddress,
      idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    ),

  getRoyaltyStats: (contractId: string) =>
    get<RoyaltyStats>(`/secondary-royalty/stats/${contractId}`),

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
      total?: number;
    }>(
      `/secondary-royalty/distributions/${contractId}?limit=${limit}&offset=${offset}`,
    ),

  // NEW: Fetch secondary royalty pool balance
  getSecondaryRoyaltyPool: (contractId: string) =>
    get<{ poolBalance: string }>(`/secondary-royalty/pool/${contractId}`),

  // NEW: Fetch contract status
  getContractStatus: (contractId: string) =>
    get<{ initialized: boolean }>(`/contract/status/${contractId}`),

  getContractVersion: (contractId: string) =>
    get<{ contractId: string; version: string }>(
      `/contract/version/${contractId}`,
    ),

  getContractState: (
    contractId: string,
    options: { bypassCache?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ contractId });
    if (options.bypassCache) params.set("cache", "false");
    return get<ContractState>(`/contract/state?${params.toString()}`);
  },

  // NEW: Fetch royalty rate from contract
  getRoyaltyRate: (contractId: string) =>
    get<{ royaltyRate: number }>(`/secondary-royalty/rate/${contractId}`),

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
};
