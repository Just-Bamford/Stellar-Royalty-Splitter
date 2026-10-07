import { useMemo, useState } from "react";

export type DisputeStatus = "open" | "resolved" | "clawed-back";

export interface Dispute {
  id: string;
  title: string;
  collaborator: string;
  amount: number;
  status: DisputeStatus;
  category: string;
  description: string;
  createdAt: string;
  respondedAt?: string | null;
  resolvedAt?: string | null;
  adminResponse?: string;
  notes: Array<{ id: string; author: string; message: string; timestamp: string }>;
}

export interface DisputeFilters {
  status: "all" | DisputeStatus;
  minAmount: string;
  maxAmount: string;
  startDate: string;
  endDate: string;
  collaborator: string;
}

export const defaultDisputes: Dispute[] = [
  {
    id: "DSP-1042",
    title: "Payout mismatch for September cycle",
    collaborator: "GCDJ7...2N8W",
    amount: 3250,
    status: "open",
    category: "payment dispute",
    description:
      "Contributor reported that the September payout omitted a royalty batch and requested a manual audit.",
    createdAt: "2026-09-12T08:00:00.000Z",
    respondedAt: "2026-09-13T10:30:00.000Z",
    resolvedAt: null,
    adminResponse:
      "Reviewing the payout ledger and cross-checking the contributor share table.",
    notes: [
      {
        id: "n1",
        author: "system",
        message: "Ticket opened after the contributor flagged a missing payment batch.",
        timestamp: "2026-09-12T08:10:00.000Z",
      },
      {
        id: "n2",
        author: "admin",
        message: "Awaiting ledger reconciliation before a final decision.",
        timestamp: "2026-09-13T10:30:00.000Z",
      },
    ],
  },
  {
    id: "DSP-1038",
    title: "Secondary sale royalty discrepancy",
    collaborator: "GB4QK...5R7F",
    amount: 8900,
    status: "resolved",
    category: "royalty mismatch",
    description:
      "A secondary sale was attributed to the wrong collaborator, leading to a shortfall in the royalty pool.",
    createdAt: "2026-09-08T14:20:00.000Z",
    respondedAt: "2026-09-09T09:15:00.000Z",
    resolvedAt: "2026-09-09T16:40:00.000Z",
    adminResponse:
      "The allocation was corrected and the affected collaborator was reimbursed in the next batch.",
    notes: [
      {
        id: "n3",
        author: "admin",
        message: "Corrected sale allocation and confirmed the ledger adjustment.",
        timestamp: "2026-09-09T16:40:00.000Z",
      },
    ],
  },
  {
    id: "DSP-1029",
    title: "Clawed-back payout review",
    collaborator: "GC89A...M6HT",
    amount: 14200,
    status: "clawed-back",
    category: "fraud review",
    description:
      "The payout was reversed after repeated failed validations and a confirmed contract compliance flag.",
    createdAt: "2026-08-27T12:00:00.000Z",
    respondedAt: "2026-08-28T09:45:00.000Z",
    resolvedAt: "2026-08-29T11:20:00.000Z",
    adminResponse:
      "The payout was clawed back and the collaborator was notified of the compliance restriction.",
    notes: [
      {
        id: "n4",
        author: "admin",
        message: "Compliance team confirmed policy breach and requested a clawback.",
        timestamp: "2026-08-29T11:20:00.000Z",
      },
    ],
  },
  {
    id: "DSP-1017",
    title: "Missing royalty confirmation",
    collaborator: "GD3L9...A8QK",
    amount: 6100,
    status: "open",
    category: "confirmation dispute",
    description:
      "The collaborator did not receive a confirmation after a successful split and requested a status review.",
    createdAt: "2026-09-18T06:20:00.000Z",
    respondedAt: null,
    resolvedAt: null,
    adminResponse: "Awaiting confirmation from the settlement service before closing the ticket.",
    notes: [
      {
        id: "n5",
        author: "contributor",
        message: "No confirmation was returned after the transaction was signed.",
        timestamp: "2026-09-18T06:35:00.000Z",
      },
    ],
  },
];

export function useDisputes(initialData: Dispute[] = defaultDisputes) {
  const [disputes, setDisputes] = useState<Dispute[]>(initialData);
  const [filters, setFilters] = useState<DisputeFilters>({
    status: "all",
    minAmount: "",
    maxAmount: "",
    startDate: "",
    endDate: "",
    collaborator: "",
  });

  const filteredDisputes = useMemo(() => {
    return disputes.filter((dispute) => {
      const matchesStatus =
        filters.status === "all" || dispute.status === filters.status;
      const matchesMinAmount =
        !filters.minAmount || dispute.amount >= Number(filters.minAmount);
      const matchesMaxAmount =
        !filters.maxAmount || dispute.amount <= Number(filters.maxAmount);
      const matchesStartDate =
        !filters.startDate || new Date(dispute.createdAt) >= new Date(filters.startDate);
      const matchesEndDate =
        !filters.endDate || new Date(dispute.createdAt) <= new Date(filters.endDate);
      const matchesCollaborator =
        !filters.collaborator ||
        dispute.collaborator
          .toLowerCase()
          .includes(filters.collaborator.toLowerCase());

      return (
        matchesStatus &&
        matchesMinAmount &&
        matchesMaxAmount &&
        matchesStartDate &&
        matchesEndDate &&
        matchesCollaborator
      );
    });
  }, [disputes, filters]);

  const groupedDisputes = useMemo(
    () =>
      (["open", "resolved", "clawed-back"] as DisputeStatus[]).map((status) => ({
        status,
        items: filteredDisputes.filter((dispute) => dispute.status === status),
      })),
    [filteredDisputes],
  );

  const metrics = useMemo(() => {
    const totalValue = disputes.reduce((sum, dispute) => sum + dispute.amount, 0);
    const openCount = disputes.filter((dispute) => dispute.status === "open").length;
    const resolvedDisputes = disputes.filter((dispute) => dispute.resolvedAt);
    const avgResolutionTime =
      resolvedDisputes.length > 0
        ? resolvedDisputes.reduce((sum, dispute) => {
            if (!dispute.createdAt || !dispute.resolvedAt) return sum;
            const start = new Date(dispute.createdAt).getTime();
            const end = new Date(dispute.resolvedAt).getTime();
            return sum + Math.max(0, end - start);
          }, 0) / resolvedDisputes.length / (1000 * 60 * 60 * 24)
        : 0;
    const totalClawedBack = disputes
      .filter((dispute) => dispute.status === "clawed-back")
      .reduce((sum, dispute) => sum + dispute.amount, 0);

    return {
      totalValue,
      openCount,
      avgResolutionTime,
      totalClawedBack,
    };
  }, [disputes]);

  const updateDisputeStatus = (
    disputeId: string,
    nextStatus: DisputeStatus,
    adminResponse?: string,
  ) => {
    setDisputes((current) =>
      current.map((dispute) => {
        if (dispute.id !== disputeId) return dispute;

        const now = new Date().toISOString();
        const respondedAt = dispute.respondedAt ?? now;
        const resolvedAt = nextStatus === "open" ? null : now;

        return {
          ...dispute,
          status: nextStatus,
          respondedAt,
          resolvedAt,
          adminResponse:
            adminResponse || dispute.adminResponse || "Updated by admin.",
          notes: [
            ...dispute.notes,
            {
              id: `note-${Date.now()}`,
              author: "admin",
              message: adminResponse || `Status updated to ${nextStatus}.`,
              timestamp: now,
            },
          ],
        };
      }),
    );
  };

  return {
    disputes,
    filteredDisputes,
    groupedDisputes,
    filters,
    setFilters,
    metrics,
    updateDisputeStatus,
  };
}

export default useDisputes;
