import React, { useState } from "react";
import "./BulkOperationsPanel.css";

interface BulkActionToolbarProps {
  selectedCount: number;
  totalCount: number;
  onSelectAllPage?: () => void;
  onSelectAllMatching?: () => void;
  onClearSelection: () => void;
  onSuspend: () => void;
  onUnsuspend: () => void;
  onChangeTier: (tier: "vip" | "regular" | "trial") => void;
  onSendMessage: (message: string) => void;
  isProcessing?: boolean;
  progressText?: string;
}

export const BulkActionToolbar: React.FC<BulkActionToolbarProps> = ({
  selectedCount,
  totalCount,
  onSelectAllPage,
  onSelectAllMatching,
  onClearSelection,
  onSuspend,
  onUnsuspend,
  onChangeTier,
  onSendMessage,
  isProcessing = false,
  progressText,
}) => {
  const [showTierDropdown, setShowTierDropdown] = useState(false);
  const [showMessageModal, setShowMessageModal] = useState(false);
  const [selectedTier, setSelectedTier] = useState<"vip" | "regular" | "trial">("vip");
  const [message, setMessage] = useState("");

  if (selectedCount === 0) return null;

  return (
    <div className="bulk-action-toolbar bulk-operations-panel" data-testid="bulk-action-toolbar" role="toolbar">
      <div className="bulk-header">
        <span className="selected-count" data-testid="selected-count">
          {selectedCount} collaborator{selectedCount !== 1 ? "s" : ""} selected ({totalCount} total)
        </span>
        <div className="select-helpers">
          {onSelectAllPage && (
            <button type="button" className="btn-link" onClick={onSelectAllPage} data-testid="select-page-btn">
              Select page
            </button>
          )}
          {onSelectAllMatching && (
            <button type="button" className="btn-link" onClick={onSelectAllMatching} data-testid="select-all-matching-btn">
              Select all matching
            </button>
          )}
          <button type="button" className="btn-link" onClick={onClearSelection} data-testid="clear-selection-btn">
            Clear
          </button>
        </div>
      </div>

      {isProcessing && progressText && (
        <div className="bulk-progress-banner" data-testid="bulk-progress">
          <span className="spinner"></span>
          <span>{progressText}</span>
        </div>
      )}

      <div className="bulk-actions">
        <button
          type="button"
          className="bulk-action-btn bulk-suspend"
          onClick={onSuspend}
          disabled={isProcessing}
          data-testid="bulk-suspend-btn"
        >
          Suspend Selected
        </button>

        <button
          type="button"
          className="bulk-action-btn"
          onClick={onUnsuspend}
          disabled={isProcessing}
          data-testid="bulk-unsuspend-btn"
        >
          Unsuspend Selected
        </button>

        <button
          type="button"
          className="bulk-action-btn"
          onClick={() => setShowTierDropdown(!showTierDropdown)}
          disabled={isProcessing}
          data-testid="bulk-tier-btn"
        >
          Change Tier...
        </button>

        <button
          type="button"
          className="bulk-action-btn"
          onClick={() => setShowMessageModal(!showMessageModal)}
          disabled={isProcessing}
          data-testid="bulk-message-btn"
        >
          Send Message...
        </button>
      </div>

      {showTierDropdown && (
        <div className="cd-inline-form" data-testid="bulk-tier-form">
          <select
            value={selectedTier}
            onChange={(e) => setSelectedTier(e.target.value as "vip" | "regular" | "trial")}
            data-testid="bulk-tier-select"
          >
            <option value="vip">VIP</option>
            <option value="regular">Regular</option>
            <option value="trial">Trial</option>
          </select>
          <button
            type="button"
            onClick={() => {
              onChangeTier(selectedTier);
              setShowTierDropdown(false);
            }}
            data-testid="apply-tier-btn"
          >
            Apply Tier
          </button>
        </div>
      )}

      {showMessageModal && (
        <div className="cd-inline-form" data-testid="bulk-message-form">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Compose message for selected collaborators..."
            rows={3}
            data-testid="bulk-message-input"
          />
          <button
            type="button"
            onClick={() => {
              if (message.trim()) {
                onSendMessage(message.trim());
                setMessage("");
                setShowMessageModal(false);
              }
            }}
            disabled={!message.trim()}
            data-testid="send-bulk-message-btn"
          >
            Send Message
          </button>
        </div>
      )}
    </div>
  );
};
