import React from "react";
import "./BulkOperationsPanel.css";

interface BulkOperationsPanelProps {
  selectedCount: number;
  onBulkExport: () => void;
  onAggregatedView: () => void;
  loading?: boolean;
}

/**
 * BulkOperationsPanel — actions available when contracts are multi-selected.
 * Supports export and aggregated view operations.
 * Closes #772 — part of multi-contract management enhancement.
 *
 * TODO(#1397): restore a "Distribute to All" action once the backend exposes
 * a multi-contract distribute endpoint. Distribution is per contract and per
 * token (`POST /distribute`, `POST /batch-distribute/tokens`), and each call
 * returns an XDR the connected wallet must sign, so it can't be driven from
 * a contract-ID selection alone. The previous button only logged the
 * selection to the console and made no request.
 */
export const BulkOperationsPanel: React.FC<BulkOperationsPanelProps> = ({
  selectedCount,
  onBulkExport,
  onAggregatedView,
  loading = false,
}) => {
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
