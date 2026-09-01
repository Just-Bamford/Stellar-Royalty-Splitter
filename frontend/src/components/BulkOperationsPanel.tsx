import React, { useState } from "react";
import "./BulkOperationsPanel.css";

interface BulkOperationsPanelProps {
  selectedCount: number;
  onBulkDistribute: () => Promise<void>;
  onBulkExport: () => void;
  onAggregatedView: () => void;
  loading?: boolean;
}

/**
 * BulkOperationsPanel — actions available when contracts are multi-selected.
 * Supports bulk distribute, export, and aggregated view operations.
 * Closes #772 — part of multi-contract management enhancement.
 */
export const BulkOperationsPanel: React.FC<BulkOperationsPanelProps> = ({
  selectedCount,
  onBulkDistribute,
  onBulkExport,
  onAggregatedView,
  loading = false,
}) => {
  const [bulkDistributeLoading, setBulkDistributeLoading] = useState(false);

  const handleBulkDistribute = async () => {
    setBulkDistributeLoading(true);
    try {
      await onBulkDistribute();
    } finally {
      setBulkDistributeLoading(false);
    }
  };

  return (
    <div className="bulk-operations-panel" role="region" aria-label="Bulk operations">
      <div className="bulk-header">
        <span className="selected-count">
          {selectedCount} contract{selectedCount !== 1 ? "s" : ""} selected
        </span>
      </div>

      <div className="bulk-actions">
        <button
          type="button"
          className="bulk-action-btn bulk-distribute"
          onClick={handleBulkDistribute}
          disabled={selectedCount === 0 || loading || bulkDistributeLoading}
          aria-label={`Distribute to ${selectedCount} selected contracts`}
        >
          {bulkDistributeLoading ? "Distributing..." : "Distribute to All"}
        </button>

        <button
          type="button"
          className="bulk-action-btn bulk-export"
          onClick={onBulkExport}
          disabled={selectedCount === 0 || loading}
          aria-label={`Export earnings from ${selectedCount} selected contracts`}
        >
          Export Earnings
        </button>

        <button
          type="button"
          className="bulk-action-btn bulk-aggregate"
          onClick={onAggregatedView}
          disabled={selectedCount === 0 || loading}
          aria-label="View aggregated earnings across selected contracts"
        >
          Aggregated View
        </button>
      </div>
    </div>
  );
};

export default BulkOperationsPanel;
