import React, { FC, useCallback } from "react";
import { duplicateConfiguration } from "../utils/configDuplication";
import "./ConfigurationActions.css";

interface Collaborator {
  address: string;
  basisPoints: number | string;
}

interface ConfigurationActionsProps {
  collaborators: Collaborator[];
  contractId?: string;
  onDuplicate: (duplicateData: {
    sourceContractId?: string;
    collaborators: Collaborator[];
  }) => void;
  disabled?: boolean;
}

/**
 * Provides actions for configuration management including duplication
 * Does not modify on-chain data - only creates draft copies
 */
export const ConfigurationActions: FC<ConfigurationActionsProps> = ({
  collaborators,
  contractId,
  onDuplicate,
  disabled = false,
}) => {
  const handleDuplicate = useCallback(async () => {
    if (!collaborators || collaborators.length === 0) {
      alert("No collaborators to duplicate");
      return;
    }

    try {
      const draft = duplicateConfiguration(collaborators, contractId);
      onDuplicate({
        sourceContractId: contractId,
        collaborators: draft.collaborators.map((c) => ({
          address: c.address,
          basisPoints: c.basisPoints,
        })),
      });
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to duplicate";
      alert(errorMsg);
    }
  }, [collaborators, contractId, onDuplicate]);

  return (
    <div className="configuration-actions">
      <button
        type="button"
        className="configuration-actions-btn configuration-actions-duplicate"
        onClick={handleDuplicate}
        disabled={disabled || !collaborators || collaborators.length === 0}
        aria-label="Duplicate this configuration as a draft"
        title={
          disabled
            ? "Actions disabled while form has errors"
            : "Create an editable copy of this configuration"
        }
      >
        📋 Duplicate Configuration
      </button>
      <p className="configuration-actions-info">
        Creates a new draft copy without modifying the original contract
      </p>
    </div>
  );
};
