// Thin client that talks to the Express backend

import { Keypair } from "@stellar/stellar-sdk";
import { extractContractError } from "./lib/contract-errors";
import { signRequest } from "./utils/sign-request";

const BASE = "/api";
export const SESSION_EXPIRED_EVENT = "srs:session-expired";
const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please connect your wallet again.";

let sessionExpiryNotified = false;

function notifySessionExpired() {
  if (sessionExpiryNotified || typeof window === "undefined") return;
  sessionExpiryNotified = true;
  window.dispatchEvent(
    new CustomEvent(SESSION_EXPIRED_EVENT, {
      detail: { message: SESSION_EXPIRED_MESSAGE },
    })
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

function getErrorMessage(data: unknown, status: number, correlationId?: string | null) {
  let msg = `Request failed (${status})`;
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    msg = data.error;
  }

  if (correlationId) {
    msg += ` (Correlation ID: ${correlationId})`;
  }

  return msg;
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

  const correlationId = res.headers.get("x-correlation-id");
  throw new Error(getErrorMessage(data, res.status, correlationId));
}

// #279: surface a structured `code + message + details` shape from
// the backend's error response instead of just `data.error`. The
// caller's `catch (e)` block can call `extractContractError(e)` to
// pull the same fields back out and the toast surfaces the real
// failure reason (`Caller is not the contract admin (code 2)`)
// rather than a generic "transaction failed".
export class BackendApiError extends Error {
  code: string | number | null;
  details?: string;
  status: number;
  correlationId?: string | null;
  constructor(
    status: number,
    code: string | number | null,
    message: string,
    details?: string,
    correlationId?: string | null
  ) {
    super(message);
    this.name = "BackendApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.correlationId = correlationId;
  }
}

export function readErrorBody(
  status: number,
  data: unknown,
  correlationId?: string | null
): BackendApiError {
  const parsed = extractContractError(data ?? { error: "Request failed" });
  let msg = parsed.message;
  if (correlationId) {
    msg += ` (Correlation ID: ${correlationId})`;
  }
  return new BackendApiError(status, parsed.code, msg, parsed.details, correlationId);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function signedPost<T>(path: string, body: unknown, keypair?: Keypair): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (keypair) {
    const signedHeaders = await signRequest(keypair, "POST", path, body);
    Object.assign(headers, signedHeaders);
  }

  return request<T>(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

async function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export interface TransactionRecord {
  id: number;
  txHash: string | null;
  contractId: string;
  type: "initialize" | "distribute" | "secondary_royalty" | "secondary_distribute";
  initiatorAddress: string;
  requestedAmount: string | null;
  tokenId: string | null;
  timestamp: string;
  blockTime: string | null;
  status: "pending" | "confirmed" | "failed";
  errorMessage: string | null;
  payoutCount?: number;
}

export interface PayoutDetail {
  collaboratorAddress: string;
  amountReceived: string;
  sharePercentage?: number;
}

export interface ContractEventItem {
  id: string;
  type: string;
  contractId: string;
  topics: string[];
  data: Record<string, unknown>;
  timestamp: string;
}

export interface TransactionDetails extends TransactionRecord {
  payouts?: PayoutDetail[];
  totalPayout?: string;
  auditHistory?: AuditLogEntry[];
  contractEvents?: ContractEventItem[];
}

export interface RoyaltyTemplateAllocation {
  address: string;
  percentage: number;
}

export interface RoyaltyTemplate {
  id: number;
  walletAddress: string;
  name: string;
  allocations: RoyaltyTemplateAllocation[];
  createdAt: string;
  updatedAt: string;
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

export interface HealthComponent {
  status: string;
  color: "green" | "yellow" | "red" | "gray";
  latencyMs?: number;
}

export interface HealthResponse {
  ok: boolean;
  dbVersion: number;
  dbOk: boolean;
  network: string;
  horizon: { connected: boolean; url: string; latencyMs: number };
  contract: {
    configured: boolean;
    contractId: string | null;
    deployed: boolean;
    initialized: boolean;
    status: string;
  };
  components: {
    database: HealthComponent;
    horizon: HealthComponent;
    contract: HealthComponent;
  };
  dbMetrics?: {
    transactions: {
      total: number;
      failed: number;
      pending: number;
      lastActivity: string | null;
    };
  };
  generatedAt?: string;
  timestamp: string;
}

export interface HealthHistoryEntry {
  id: number;
  timestamp: string;
  overall_ok: number;
  horizon_connected: number;
  horizon_latency_ms: number | null;
  contract_status: string;
  db_ok: number;
}

export interface SLAStats {
  periodDays: number;
  totalSnapshots: number;
  healthySnapshots: number;
  uptimePercent: number;
  avgLatencyMs: number | null;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
}

export const api = {
  // Generic HTTP methods
  get,
  post,
  patch,
  put,
  del,

  initialize: (body: {
    contractId: string;
    walletAddress: string;
    collaborators: string[];
    shares: number[];
  }) => post<{ xdr: string; transactionId: number }>("/initialize", body),

  initializeCommit: (body: {
    contractId: string;
    walletAddress: string;
    collaborators: string[];
    shares: number[];
  }) => post<{ xdr: string; transactionId: number }>("/initialize/commit", body),

  initializeReveal: (body: {
    contractId: string;
    walletAddress: string;
    collaborators: string[];
    shares: number[];
  }) => post<{ xdr: string; transactionId: number }>("/initialize/reveal", body),

  distribute: (body: {
    contractId: string;
    walletAddress: string;
    tokenId: string;
    amount?: string | number;
  }) => post<{ xdr: string; transactionId: number }>("/distribute", body),

  buildBatchDistribution: (body: {
    contractId: string;
    walletAddress: string;
    tokens: string[];
    idempotencyKey?: string;
  }) =>
    post<{
      xdr: string;
      transactionId: number;
      tokensIncluded: number;
      estimate: {
        individualCost: string;
        batchCost: string;
        savings: string;
        savingsPercent: number;
        source: string;
      };
    }>("/batch-distribute/tokens", body),

  estimateBatchDistribution: (tokenCount: number, resourceMaxBatchSize?: number) =>
    post<{
      individualCost: string;
      batchCost: string;
      savings: string;
      savingsPercent: number;
      source: string;
      optimalBatchSize: number;
      remaining: number;
    }>("/batch-distribute/tokens/estimate", { tokenCount, resourceMaxBatchSize }),

  getContractVersion: (contractId: string) =>
    get<{ version: string }>(`/contract/version/${contractId}`),

  getContractBalance: (contractId: string, tokenId: string) =>
    get<{ balance: string }>(
      `/contract/balance/${contractId}?tokenId=${encodeURIComponent(tokenId)}`
    ),

  getPendingDistributions: (contractId: string) =>
    get<{
      distributions: Array<{
        tokenId: string;
        amount: string;
        lastUpdated: string;
        recipientCount: number;
      }>;
    }>(`/contract/pending-distributions/${contractId}`),

  getCollaborators: (contractId: string) =>
    get<{ address: string; basisPoints: number }[]>(`/collaborators/${contractId}`),

  // Reusable royalty split templates (#652)
  listTemplates: (walletAddress: string) =>
    get<{ success: boolean; data: RoyaltyTemplate[] }>(
      `/templates?walletAddress=${encodeURIComponent(walletAddress)}`
    ),

  createTemplate: (body: {
    walletAddress: string;
    name: string;
    allocations: RoyaltyTemplateAllocation[];
  }) => post<{ success: boolean; data: RoyaltyTemplate }>("/templates", body),

  deleteTemplate: (id: number, walletAddress: string) =>
    del<{ success: boolean }>(
      `/templates/${id}?walletAddress=${encodeURIComponent(walletAddress)}`
    ),

  // Transaction History & Audit Log APIs
  getTransactionHistory: (
    contractId: string,
    limit = 50,
    offset = 0,
    filters?: {
      type?: "distribute" | "initialize";
      recipient?: string;
      startDate?: string;
      endDate?: string;
    }
  ) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (filters?.type) params.set("type", filters.type);
    if (filters?.recipient) params.set("recipient", filters.recipient);
    if (filters?.startDate) params.set("startDate", filters.startDate);
    if (filters?.endDate) params.set("endDate", filters.endDate);
    return get<{
      success: boolean;
      data: TransactionRecord[];
      pagination: { limit: number; offset: number; total: number };
    }>(`/history/${contractId}?${params.toString()}`);
  },

  getTransactionDetails: (txHash: string) =>
    get<{ success: boolean; data: TransactionDetails }>(`/transaction/${txHash}`),

  confirmTransaction: (
    txHash: string,
    body: {
      status: "pending" | "confirmed" | "failed";
      blockTime?: string;
      errorMessage?: string;
      transactionId?: number;
    }
  ) => post<{ success: boolean; message: string }>(`/transaction/confirm/${txHash}`, body),

  // Read-only: there is no client-side write path for audit entries. Audit
  // records are created exclusively server-side as a side effect of real
  // configuration/administrative actions (initialize, distribute,
  // secondary-royalty routes) ÔÇö see backend/src/routes/history.js.
  getAuditLog: (contractId: string, limit = 100, offset = 0) =>
    get<{ success: boolean; data: AuditLogEntry[] }>(
      `/audit/${contractId}?limit=${limit}&offset=${offset}`
    ),

  // Secondary Royalty APIs
  recordSecondarySale: (
    body: {
      contractId: string;
      walletAddress: string;
      nftId: string;
      previousOwner: string;
      newOwner: string;
      salePrice: number;
      saleToken: string;
      royaltyRate: number;
    },
    keypair?: Keypair
  ) =>
    signedPost<{ xdr: string; transactionId: number; royaltyAmount: number }>(
      "/secondary-royalty",
      body,
      keypair
    ),

  setRoyaltyRate: (
    body: {
      contractId: string;
      walletAddress: string;
      royaltyRate: number;
    },
    keypair?: Keypair
  ) =>
    signedPost<{ xdr: string; transactionId: number }>(
      "/secondary-royalty/set-rate",
      body,
      keypair
    ),

  setSecondaryPoolLimit: (
    body: {
      contractId: string;
      walletAddress: string;
      maxPoolSize: number;
    },
    keypair?: Keypair
  ) =>
    signedPost<{ xdr: string; transactionId: number }>(
      "/secondary-royalty/set-pool-limit",
      body,
      keypair
    ),

  distributeSecondaryRoyalties: (
    body: {
      contractId: string;
      walletAddress: string;
      tokenId: string;
    },
    keypair?: Keypair
  ) =>
    signedPost<{
      xdr: string;
      transactionId: number;
      numberOfSales: number;
      totalRoyalties: string;
    }>("/secondary-royalty/distribute", body, keypair),
  getSecondarySales: (contractId: string, limit = 50, offset = 0, nftId?: string) =>
    get<{ sales: SecondarySale[]; total: number }>(
      `/secondary-royalty/sales/${contractId}?limit=${limit}&offset=${offset}${nftId ? `&nftId=${nftId}` : ""}`
    ),

  getSecondaryRoyaltyDistributions: (contractId: string, limit = 50, offset = 0) =>
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
    }>(`/secondary-royalty/distributions/${contractId}?limit=${limit}&offset=${offset}`),

  // NEW: Fetch secondary royalty pool balance
  getSecondaryRoyaltyPool: (contractId: string) =>
    get<{ poolBalance: string }>(`/secondary-royalty/pool/${contractId}`),

  getRoyaltyStats: (contractId: string) =>
    get<RoyaltyStats>(`/secondary-royalty/stats/${contractId}`),

  // NEW: Fetch contract status
  getContractStatus: (contractId: string) =>
    get<{ initialized: boolean }>(`/contract/status/${contractId}`),

  // NEW: Fetch royalty rate from contract
  getRoyaltyRate: (contractId: string) =>
    get<{ royaltyRate: number }>(`/secondary-royalty/rate/${contractId}`),

  // Analytics API
  getAnalytics: (contractId: string, dateRange?: { start: string; end: string }) =>
    get<{
      success: boolean;
      data: {
        totalDistributed: number;
        totalTransactions: number;
        averagePayout: number;
        primaryRoyaltiesTotal: number;
        secondaryRoyaltiesTotal: number;
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
          avgPayout?: number;
          firstActivity?: string | null;
          lastActivity?: string | null;
        }>;
      };
      message?: string;
    }>(
      `/analytics/${contractId}${dateRange ? `?start=${dateRange.start}&end=${dateRange.end}` : ""}`
    ),

  // Health & SLA APIs (#787)
  getHealth: () => get<HealthResponse>("/v1/health"),

  getHealthHistory: (hours = 24) =>
    get<{ ok: boolean; data: HealthHistoryEntry[]; count: number; periodHours: number }>(
      `/v1/health/history?hours=${hours}`
    ),

  getHealthSla: (days = 30) => get<{ ok: boolean; data: SLAStats }>(`/v1/health/sla?days=${days}`),
  // Contributor Onboarding APIs (#567)
  getOnboardingStatus: (walletAddress: string) =>
    get<OnboardingStatusResponse>(`/v1/onboarding/${walletAddress}`),

  updateOnboardingStatus: (walletAddress: string, data: OnboardingUpdateRequest) =>
    patch<{
      message: string;
      summary: OnboardingStatusResponse;
    }>(`/v1/onboarding/${walletAddress}`, data),

  sendOnboardingReminder: (walletAddress: string, email: string) =>
    post<OnboardingReminderResponse>(`/v1/onboarding/${walletAddress}/remind`, {
      email,
    }),

  getEarningsHistory: (
    walletAddress: string,
    params?: { start?: string; end?: string; contracts?: string[] }
  ) => {
    const search = new URLSearchParams();
    if (params?.start) search.set("start", params.start);
    if (params?.end) search.set("end", params.end);
    if (params?.contracts?.length) search.set("contracts", params.contracts.join(","));
    const query = search.toString();
    return get<{
      success: boolean;
      message?: string;
      data: {
        walletAddress: string;
        snapshots: Array<{ date: string; contractId: string; amount: number }>;
        events: Array<{
          type: "contract_added" | "distribution_failure" | "contract_removed";
          contractId: string;
          date: string;
          label: string;
        }>;
        contracts: string[];
      };
    }>(`/v1/earnings-history/${walletAddress}${query ? `?${query}` : ""}`);
  },

  getContractPerformance: (
    dateRange?: { start: string; end: string },
    _options?: { sortBy?: string; direction?: string; limit?: number }
  ) =>
    get<{
      success: boolean;
      message?: string;
      data: {
        contracts: Array<{
          contractId: string;
          revenue: number;
          transactions: number;
          lastActivity: string | null;
          status: string;
        }>;
      };
    }>(
      `/analytics/performance${dateRange ? `?start=${dateRange.start}&end=${dateRange.end}` : ""}`
    ),

  getMultiContractEarnings: (
    address: string,
    _dateRange?: { start?: string; end?: string } | string
  ) => get<any>(`/analytics/multi-contract?address=${address}`),

  // Token economics & vesting analytics (#1062)
  getTokenEconomicsModel: (config?: unknown, options?: unknown) =>
    post<{ success: boolean; data: any }>("/v1/tokenomics/model", {
      config,
      options,
    }),

  simulateTokenDistribution: (config: unknown, scenario?: unknown, options?: unknown) =>
    post<{ success: boolean; data: any }>("/v1/tokenomics/simulate", {
      config,
      scenario,
      options,
    }),

  getVestingAnalytics: (schedules: unknown[], options?: unknown) =>
    post<{ success: boolean; data: any }>("/v1/tokenomics/vesting", {
      schedules,
      options,
    }),

  simulateVestingSchedule: (schedule: unknown, overrides?: unknown, options?: unknown) =>
    post<{ success: boolean; data: any }>("/v1/tokenomics/vesting/simulate", {
      schedule,
      overrides,
      options,
    }),

  getNotifications: (walletAddress: string, _limit = 50, _offset = 0) =>
    get<{ success: boolean; data: any[]; unreadCount: number }>(
      `/v1/notifications/${walletAddress}`
    ),

  getUnreadNotificationCount: (walletAddress: string) =>
    get<{ success: boolean; count: number; unreadCount: number }>(
      `/v1/notifications/${walletAddress}/unread`
    ),

  markAllNotificationsRead: (walletAddress: string) =>
    post<{ success: boolean }>(`/v1/notifications/${walletAddress}/read-all`, {}),

  markNotificationRead: (id: number) =>
    post<{ success: boolean }>(`/v1/notifications/read/${id}`, {}),

  markNotificationUnread: (id: number) =>
    post<{ success: boolean }>(`/v1/notifications/${id}/unread`, {}),

  archiveNotification: (id: number) =>
    post<{ success: boolean }>(`/v1/notifications/${id}/archive`, {}),

  unarchiveNotification: (id: number) =>
    post<{ success: boolean }>(`/v1/notifications/${id}/unarchive`, {}),

  deleteNotification: (id: number) => del<{ success: boolean }>(`/v1/notifications/${id}`),

  searchNotifications: (walletAddress: string, query: string) =>
    get<{ success: boolean; data: any[]; count: number }>(
      `/v1/notifications/${walletAddress}/search?q=${encodeURIComponent(query)}`
    ),

  getNotificationsByType: (walletAddress: string, type: string) =>
    get<{ success: boolean; data: any[] }>(`/v1/notifications/${walletAddress}/by-type/${type}`),

  getNotificationPreferences: (walletAddress: string) =>
    get<{ success: boolean; data: any }>(`/v1/notifications/preferences/${walletAddress}`),

  saveNotificationPreferences: (walletAddress: string, prefs: any) =>
    post<{ success: boolean; data: any }>(`/v1/notifications/preferences`, {
      walletAddress,
      ...prefs,
    }),

  getHeldTransactions: (contractId: string, _status = "active", _offset = 0) =>
    get<{ success: boolean; data: any[] }>(`/v1/payment-holds/${contractId}`),

  approveHoldRelease: (holdId: number, _role?: string, _note?: string) =>
    post<{ success: boolean }>(`/v1/payment-holds/approve/${holdId}`, {}),

  releasePaymentHold: (holdId: number, _role?: string, _note?: string) =>
    post<{ success: boolean }>(`/v1/payment-holds/release/${holdId}`, {}),

  placePaymentHold: (body: any, _walletAddress?: string, _txId?: any, _reason?: string) =>
    post<{ success: boolean }>(`/v1/payment-holds`, body),

  getPaymentPreference: (walletAddress: string) =>
    get<{ paymentMethod?: string; [key: string]: any }>(`/v1/preferences/payment/${walletAddress}`),

  savePaymentPreference: (walletAddress: string, pending: string) =>
    post<{ paymentMethod?: string; [key: string]: any }>(
      `/v1/preferences/payment/${walletAddress}`,
      { pending }
    ),

  getVerification: (walletAddress: string) => get<any>(`/verification/${walletAddress}`),
  startVerification: (walletAddress: string, data?: any) =>
    post<any>(`/verification/start`, { walletAddress, ...data }),
  advanceVerification: (
    payload:
      | { walletAddress: string; step?: any; status?: any; adminNote?: string | null }
      | string,
    step?: any
  ) => {
    if (typeof payload === "string") {
      return post<any>(`/verification/advance`, { walletAddress: payload, step });
    }
    return post<any>(`/verification/advance`, payload);
  },

  getContractFees: (contractId: string) => get<any>(`/fees/${contractId}`),

  getTaxComplianceReport: () => get<any>("/v1/contributor-tax/report"),

  previewCsv: (file: File, contractId: string) =>
    post<{
      success: boolean;
      data: {
        validRows: any[];
        errorRows: any[];
        summary: { total: number; valid: number; errors: number };
      };
    }>(`/v1/contributors/preview-csv?contractId=${encodeURIComponent(contractId)}`, {
      fileName: file.name,
      size: file.size,
    }),

  importCsv: (file: File, contractId: string) =>
    post<{
      success: boolean;
      data: {
        importId: number;
        summary: { total: number; successCount: number; errorCount: number };
      };
    }>(`/v1/contributors/import-csv?contractId=${encodeURIComponent(contractId)}`, {
      fileName: file.name,
      size: file.size,
    }),

  downloadCsvTemplate: () => {
    const url = `${BASE}/v1/contributors/csv-template`;
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve({ success: true });
  },

  upgradeContract: (body: { contractId: string; walletAddress: string; wasmHash: string }) =>
    post<{ success: boolean; version: string; xdr: string }>("/contract/upgrade", body),

  getContributorTax: (walletAddress: string) =>
    get<{
      success: boolean;
      data?: { tax_status?: string; tax_id?: string; w9_file_name?: string };
    }>(`/v1/contributor-tax/${walletAddress}`),

  saveContributorTax: (walletAddress: string, taxStatus: string, taxId?: string) =>
    post<{ success: boolean }>(`/v1/contributor-tax/${walletAddress}`, { taxStatus, taxId }),

  uploadTaxDocument: (walletAddress: string, file: File) =>
    post<{ success: boolean }>(`/v1/contributor-tax/${walletAddress}/document`, {
      walletAddress,
      fileName: file.name,
      size: file.size,
    }),

  getTaxDocument: (walletAddress: string) =>
    get<{ success: boolean; url?: string }>(`/v1/contributor-tax/${walletAddress}/document`),

  getContributorsMissingTaxInfo: () => get<any>("/v1/contributor-tax/missing"),

  // Contributor Tier APIs (#589) ÔÇö used by CollaboratorTable and the
  // Collaborator Directory (#923) to read/assign VIP/regular/trial tiers.
  getContractTiers: (contractId: string) =>
    get<{ success: boolean; data: ContributorTier[]; validTiers: string[] }>(
      `/tiers/${contractId}`
    ),

  setContributorTier: (
    contractId: string,
    address: string,
    tier: "vip" | "regular" | "trial",
    notes?: string
  ) =>
    put<{ success: boolean; message: string }>(`/tiers/${contractId}/${address}`, {
      tier,
      notes: notes ?? null,
    }),

  // Contributor Suspension / Deactivation APIs (#593) ÔÇö read by
  // ContributorSuspension.tsx and the Collaborator Directory's bulk
  // suspend/unsuspend action (#923).
  getContributorStatuses: (contractId: string, includeActive = false) =>
    get<{ success: boolean; data: ContributorStatusEntry[] }>(
      `/contributor-status/${contractId}?includeActive=${includeActive}`
    ),

  setContributorStatus: (
    contractId: string,
    address: string,
    body: {
      status: "active" | "suspended" | "deactivated";
      reason?: string;
      updatedBy?: string;
    }
  ) =>
    post<{ success: boolean; message?: string }>(
      `/contributor-status/${contractId}/${address}`,
      body
    ),

  // Notification send API (#927) ÔÇö reused by the Collaborator Directory's
  // bulk "send message" action (#923) to message selected collaborators.
  sendNotification: (
    walletAddress: string,
    type: string,
    title: string,
    message?: string,
    data?: Record<string, unknown>
  ) =>
    post<{ success: boolean; data: unknown }>("/v1/notifications/send", {
      walletAddress,
      type,
      title,
      message,
      data,
    }),

  // Carbon tracking and offsets (#1064)
  getCarbonFootprint: (walletAddress: string, params?: { start?: string; end?: string }) => {
    const search = new URLSearchParams();
    if (params?.start) search.set("start", params.start);
    if (params?.end) search.set("end", params.end);
    const query = search.toString();
    return get<{ success: boolean; data: CarbonFootprint }>(
      `/v1/carbon/footprint/${walletAddress}${query ? `?${query}` : ""}`
    );
  },

  getCarbonProject: (contractId: string, params?: { start?: string; end?: string }) => {
    const search = new URLSearchParams();
    if (params?.start) search.set("start", params.start);
    if (params?.end) search.set("end", params.end);
    const query = search.toString();
    return get<{ success: boolean; data: CarbonProjectFootprint }>(
      `/v1/carbon/project/${contractId}${query ? `?${query}` : ""}`
    );
  },

  recordCarbonEmission: (body: {
    contractId: string;
    walletAddress: string;
    txHash?: string;
    transactionId?: number;
    operationCount?: number;
  }) => post<{ success: boolean; emissionId: number; gramsCo2: number }>("/v1/carbon/record", body),

  purchaseCarbonOffsets: (body: {
    walletAddress: string;
    contractId?: string;
    tonnes?: number;
    amountUsdCents?: number;
    project?: string;
  }) => post<{ success: boolean; data: CarbonOffsetPurchase }>("/v1/carbon/offsets", body),

  getCarbonOffsets: (walletAddress: string, limit = 50, offset = 0) =>
    get<{
      success: boolean;
      data: CarbonOffsetRecord[];
      pagination: { total: number; limit: number; offset: number };
    }>(`/v1/carbon/offsets/${walletAddress}?limit=${limit}&offset=${offset}`),

  getCarbonSettings: (walletAddress: string) =>
    get<{ success: boolean; data: CarbonSettings }>("/v1/carbon/settings/" + walletAddress),

  saveCarbonSettings: (
    walletAddress: string,
    body: { autoOffsetEnabled: boolean; offsetPercentage: number }
  ) =>
    post<{ success: boolean; data: CarbonSettings }>(`/v1/carbon/settings/${walletAddress}`, body),

  getCarbonProjects: () => get<{ success: boolean; data: CarbonProject[] }>("/v1/carbon/projects"),

  getCarbonShare: (walletAddress: string) =>
    get<{ success: boolean; data: CarbonSharePayload }>(`/v1/carbon/share/${walletAddress}`),

  // Advanced webhook system (#1059) — external integrations with HMAC
  // signatures, delivery history, and manual testing.
  getWebhookEvents: () => get<{ success: boolean; data: string[] }>("/v1/webhooks/events"),

  listWebhooks: (contractId: string) =>
    get<{ success: boolean; data: WebhookEntry[] }>(`/v1/webhooks/${contractId}`),

  registerWebhook: (contractId: string, url: string, events?: string[]) =>
    post<{ success: boolean; webhookId: number; url: string; events?: string[]; secret?: string }>(
      `/v1/webhooks/${contractId}`,
      events ? { url, events } : { url }
    ),

  deregisterWebhook: (contractId: string, webhookId: number) =>
    del<{ success: boolean }>(`/v1/webhooks/${contractId}/${webhookId}`),

  testWebhook: (contractId: string, webhookId: number) =>
    post<{ success: boolean; message?: string; deliveryId?: number | null; error?: string }>(
      `/v1/webhooks/${contractId}/${webhookId}/test`,
      {}
    ),

  rotateWebhookSecret: (contractId: string, webhookId: number) =>
    post<{ success: boolean; webhookId: number; secret: string }>(
      `/v1/webhooks/${contractId}/${webhookId}/rotate-secret`,
      {}
    ),

  emitWebhookEvent: (contractId: string, event: string, data?: Record<string, unknown>) =>
    post<{ success: boolean; event: string; delivered: number; failed: number; attempted: number }>(
      `/v1/webhooks/${contractId}/emit`,
      { event, data: data ?? {} }
    ),

  getWebhookDeliveries: (
    contractId: string,
    params?: {
      limit?: number;
      offset?: number;
      webhookId?: number;
      event?: string;
      status?: string;
    }
  ) => {
    const search = new URLSearchParams();
    if (params?.limit != null) search.set("limit", String(params.limit));
    if (params?.offset != null) search.set("offset", String(params.offset));
    if (params?.webhookId != null) search.set("webhookId", String(params.webhookId));
    if (params?.event) search.set("event", params.event);
    if (params?.status) search.set("status", params.status);
    const query = search.toString();
    return get<{
      success: boolean;
      data: WebhookDelivery[];
      pagination: { total: number; limit: number; offset: number };
    }>(`/v1/webhooks/${contractId}/deliveries${query ? `?${query}` : ""}`);
  },

  getWebhookDeliveryStats: (contractId: string) =>
    get<{ success: boolean; data: WebhookDeliveryStats }>(
      `/v1/webhooks/${contractId}/delivery-stats`
    ),
};

// Partner Analytics types (stub for now - backend endpoints TBD)
export interface PartnerAnalytics {
  id: string;
  partner: string;
  endpoints: PartnerEndpointStat[];
  revenue: PartnerRevenue;
  tiers: PartnerPricingTier[];
  createdAt: string;
  updatedAt: string;
}

export interface PartnerEndpointStat {
  endpoint: string;
  calls: number;
  avgLatency: number;
  errors: number;
}

export interface PartnerRevenue {
  total: number;
  thisMonth: number;
  lastMonth: number;
}

export interface PartnerPricingTier {
  name: string;
  rate: number;
  minCalls: number;
  maxCalls: number | null;
}

export interface CarbonDayEntry {
  date: string;
  txCount: number;
  grams: number;
}

export interface CarbonFootprint {
  walletAddress: string;
  txCount: number;
  totalGrams: number;
  totalKg: number;
  offsetGrams: number;
  offsetTonnes: number;
  offsetPurchases: number;
  offsetUsdCents: number;
  netGrams: number;
  offsetCoveragePercent: number;
  byDay: CarbonDayEntry[];
}

export interface CarbonProjectFootprint {
  contractId: string;
  txCount: number;
  totalGrams: number;
  totalKg: number;
  contributorCount: number;
  offsetTonnes: number;
  offsetPurchases: number;
  offsetContributors: number;
  byDay: CarbonDayEntry[];
}

export interface CarbonOffsetPurchase {
  offsetId: number;
  walletAddress: string;
  tonnes: number;
  amountUsdCents: number;
  provider: string;
  project: string;
  status: string;
}

export interface CarbonOffsetRecord {
  id: number;
  walletAddress: string;
  contractId: string | null;
  tonnes: number;
  amountUsdCents: number;
  provider: string;
  project: string;
  status: string;
  autoPurchase: number;
  txHash: string | null;
  createdAt: string;
}

export interface CarbonSettings {
  walletAddress: string;
  autoOffsetEnabled: boolean;
  offsetPercentage: number;
}

export interface CarbonProject {
  id: string;
  name: string;
  type: "forest" | "ocean";
  location: string;
  description: string;
}

export interface CarbonSharePayload {
  text: string;
  stats: {
    totalKg: number;
    txCount: number;
    offsetCoveragePercent: number;
    netGrams: number;
  };
  shareUrls: {
    x: string;
    facebook: string;
    linkedin: string;
  };
}

export interface FeatureFlagRule {
  id: number;
  flagId: number;
  ruleType: "user" | "org" | "role";
  value: string;
  enabled: boolean;
  createdAt: string;
}

export interface FeatureFlag {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  killed: boolean;
  archived: boolean;
  rolloutPercentage: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  rules?: FeatureFlagRule[];
}

export interface FeatureFlagHistoryEntry {
  id: number;
  flagId: number;
  flagName: string;
  action: string;
  changedBy: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  timestamp: string;
}

export interface FeatureFlagHealth {
  flag: string;
  healthy: boolean;
  reasons: string[];
  thresholds: { maxErrorRate: number; maxP95LatencyMs: number; windowMs: number };
  metrics: {
    flag: string;
    windowMs: number;
    requests: number;
    errors: number;
    errorRate: number;
    sampleCount: number;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
    maxLatencyMs: number | null;
  };
}

export interface ContributorTier {
  walletAddress: string;
  tier: "vip" | "regular" | "trial";
  notes?: string | null;
}

export interface WebhookEntry {
  id: number;
  contractId: string;
  url: string;
  enabled: number;
  events: string[];
  hasSecret: boolean;
  retryCount: number;
  nextRetryTime: string | null;
  createdAt: string;
}

export interface WebhookDelivery {
  id: number;
  webhookId: number | null;
  contractId: string;
  event: string;
  url: string;
  payload: string | null;
  status: "pending" | "delivered" | "failed" | "exhausted";
  httpStatus: number | null;
  attempts: number;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface WebhookDeliveryStats {
  total: number;
  delivered: number;
  failed: number;
  pending: number;
  exhausted: number;
}

export interface ContributorStatusEntry {
  contractId: string;
  address: string;
  status: "active" | "suspended" | "deactivated";
  reason: string | null;
  suspendedAt: string | null;
  deactivatedAt: string | null;
  updatedBy: string | null;
  updatedAt?: string;
}

export interface OnboardingItem {
  id: string;
  label: string;
  description: string;
  completed: boolean;
  required: boolean;
  category: "setup" | "compliance" | "finance" | "milestone";
}

export interface OnboardingStatusResponse {
  walletAddress: string;
  email: string;
  kycStatus: "unverified" | "pending" | "verified";
  payoutToken: string;
  paymentPreferencesSet: boolean;
  taxInfoSubmitted: boolean;
  items: OnboardingItem[];
  completedCount: number;
  totalCount: number;
  completionPercentage: number;
  requiredComplete: boolean;
  actionsLocked: boolean;
  nextStep: {
    id: string;
    label: string;
    description: string;
  } | null;
}

export interface OnboardingUpdateRequest {
  email?: string;
  kycStatus?: "unverified" | "pending" | "verified";
  paymentPreferencesSet?: boolean;
  payoutToken?: string;
  taxInfoSubmitted?: boolean;
}

export interface OnboardingReminderResponse {
  success: boolean;
  message: string;
  emailDetails: {
    to: string;
    subject: string;
    completionPercentage: number;
    incompleteCount: number;
    previewText: string;
  };
}
