import { useState, useCallback } from "react";
import { api } from "../api";

export interface BulkOperationProgress {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentAction: string;
  isProcessing: boolean;
}

export function useBulkOperations(contractId: string, walletAddress?: string | null) {
  const [progress, setProgress] = useState<BulkOperationProgress>({
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    currentAction: "",
    isProcessing: false,
  });
  const [statusMessage, setStatusMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const executeBulkAction = useCallback(
    async (
      actionName: string,
      targetAddresses: string[],
      operation: (address: string) => Promise<unknown>
    ) => {
      const total = targetAddresses.length;
      if (total === 0) return;

      setProgress({
        total,
        completed: 0,
        succeeded: 0,
        failed: 0,
        currentAction: actionName,
        isProcessing: true,
      });
      setStatusMessage(null);

      let succeeded = 0;
      let failed = 0;

      for (let i = 0; i < total; i++) {
        const addr = targetAddresses[i];
        try {
          await operation(addr);
          succeeded++;
        } catch (_) {
          failed++;
        }
        setProgress({
          total,
          completed: i + 1,
          succeeded,
          failed,
          currentAction: actionName,
          isProcessing: true,
        });
      }

      setProgress((prev) => ({ ...prev, isProcessing: false }));

      if (failed === 0) {
        setStatusMessage({
          type: "ok",
          text: `${actionName} completed successfully for all ${total} collaborator(s).`,
        });
      } else {
        setStatusMessage({
          type: "err",
          text: `${actionName}: ${succeeded}/${total} succeeded, ${failed} failed.`,
        });
      }
    },
    []
  );

  const bulkSuspend = useCallback(
    (addresses: string[]) =>
      executeBulkAction("Suspend", addresses, (addr) =>
        api.setContributorStatus(contractId, addr, {
          status: "suspended",
          updatedBy: walletAddress ?? undefined,
        })
      ),
    [contractId, walletAddress, executeBulkAction]
  );

  const bulkUnsuspend = useCallback(
    (addresses: string[]) =>
      executeBulkAction("Unsuspend", addresses, (addr) =>
        api.setContributorStatus(contractId, addr, {
          status: "active",
          updatedBy: walletAddress ?? undefined,
        })
      ),
    [contractId, walletAddress, executeBulkAction]
  );

  const bulkChangeTier = useCallback(
    (addresses: string[], newTier: "vip" | "regular" | "trial") =>
      executeBulkAction(`Change tier to ${newTier}`, addresses, (addr) =>
        api.setContributorTier(contractId, addr, newTier)
      ),
    [contractId, executeBulkAction]
  );

  const bulkSendMessage = useCallback(
    (addresses: string[], message: string) =>
      executeBulkAction("Send message", addresses, (addr) =>
        api.sendNotification(addr, "directory_message", "Message from project", message)
      ),
    [executeBulkAction]
  );

  return {
    progress,
    statusMessage,
    bulkSuspend,
    bulkUnsuspend,
    bulkChangeTier,
    bulkSendMessage,
  };
}
