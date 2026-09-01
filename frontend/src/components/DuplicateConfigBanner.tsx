import React, { FC } from "react";
import {
  RoyaltyConfigDraft,
  getDuplicateBannerMessage,
} from "../utils/configDuplication";
import "./DuplicateConfigBanner.css";

interface DuplicateConfigBannerProps {
  draft: RoyaltyConfigDraft;
  onClearDuplicate: () => void;
}

/**
 * Displays a banner when user is editing a duplicated configuration
 * Shows source information and allows clearing the duplicate flag
 */
export const DuplicateConfigBanner: FC<DuplicateConfigBannerProps> = ({
  draft,
  onClearDuplicate,
}) => {
  if (!draft.isDuplicate) {
    return null;
  }

  const message = getDuplicateBannerMessage(draft);
  const duplicatedDate = new Date(draft.duplicatedAt);
  const timeAgo = getTimeAgoString(duplicatedDate);

  return (
    <div className="duplicate-config-banner" role="status" aria-live="polite">
      <div className="duplicate-config-banner-content">
        <div className="duplicate-config-banner-message">{message}</div>
        <div className="duplicate-config-banner-meta">
          <span className="duplicate-config-banner-time">
            Duplicated {timeAgo}
          </span>
          <button
            type="button"
            className="duplicate-config-banner-clear"
            onClick={onClearDuplicate}
            aria-label="Clear duplicate flag and edit as new configuration"
            title="Remove duplicate status and treat this as a new configuration"
          >
            ✕ Clear
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Human-readable time ago string
 */
function getTimeAgoString(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}
