import { AccessibleModal } from "./a11y/AccessibleModal";
import type { CollaboratorSearchItem } from "../hooks/queries/useCollaboratorSearch";
import "./CollaboratorQuickView.css";

interface CollaboratorQuickViewProps {
  collaborator: CollaboratorSearchItem | null;
  onClose: () => void;
}

const TIER_LABELS: Record<CollaboratorSearchItem["tier"], string> = {
  vip: "⭐ VIP",
  trial: "🔹 Trial",
  regular: "Regular",
};

const STATUS_LABELS: Record<CollaboratorSearchItem["status"], string> = {
  active: "Active",
  suspended: "Suspended",
  deactivated: "Deactivated",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

/**
 * Quick-view modal for a single collaborator's full profile — earnings,
 * payments, tier, and activity history (#923). Built on top of the shared
 * `AccessibleModal` primitive rather than a new modal shell.
 */
export default function CollaboratorQuickView({
  collaborator,
  onClose,
}: CollaboratorQuickViewProps) {
  return (
    <AccessibleModal
      isOpen={collaborator !== null}
      onClose={onClose}
      title="Collaborator Profile"
      size="md"
    >
      {collaborator && (
        <div className="cqv" data-testid="collaborator-quick-view">
          <div className="cqv-address-row">
            <code className="cqv-address" title={collaborator.address}>
              {collaborator.address}
            </code>
          </div>

          <div className="cqv-badges">
            <span className={`tier-badge tier-badge--${collaborator.tier}`}>
              {TIER_LABELS[collaborator.tier]}
            </span>
            <span className={`cqv-status-badge cqv-status-badge--${collaborator.status}`}>
              {STATUS_LABELS[collaborator.status]}
            </span>
          </div>

          <dl className="cqv-stats">
            <div className="cqv-stat">
              <dt>Share</dt>
              <dd>{collaborator.sharePercentage.toFixed(2)}%</dd>
            </div>
            <div className="cqv-stat">
              <dt>Total Earned</dt>
              <dd>{collaborator.totalEarned.toLocaleString()}</dd>
            </div>
            <div className="cqv-stat">
              <dt>Payout Count</dt>
              <dd>{collaborator.payoutCount}</dd>
            </div>
            <div className="cqv-stat">
              <dt>Join Date</dt>
              <dd>{formatDate(collaborator.joinDate)}</dd>
            </div>
            <div className="cqv-stat">
              <dt>Last Activity</dt>
              <dd>{formatDate(collaborator.lastActivity)}</dd>
            </div>
          </dl>
        </div>
      )}
    </AccessibleModal>
  );
}
