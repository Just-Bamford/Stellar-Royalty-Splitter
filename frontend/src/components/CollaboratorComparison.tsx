import type { CollaboratorSearchItem } from "../hooks/queries/useCollaboratorSearch";
import "./CollaboratorComparison.css";

interface CollaboratorComparisonProps {
  collaborators: CollaboratorSearchItem[];
}

const MAX_COMPARE = 3;
const MIN_COMPARE = 2;

const METRICS: {
  key: keyof Pick<
    CollaboratorSearchItem,
    "sharePercentage" | "totalEarned" | "payoutCount" | "tier" | "status" | "joinDate" | "lastActivity"
  >;
  label: string;
  format: (item: CollaboratorSearchItem) => string;
}[] = [
  { key: "sharePercentage", label: "Share", format: (c) => `${c.sharePercentage.toFixed(2)}%` },
  { key: "totalEarned", label: "Total Earned", format: (c) => c.totalEarned.toLocaleString() },
  { key: "payoutCount", label: "Payout Count", format: (c) => String(c.payoutCount) },
  { key: "tier", label: "Tier", format: (c) => c.tier },
  { key: "status", label: "Status", format: (c) => c.status },
  {
    key: "joinDate",
    label: "Join Date",
    format: (c) => (c.joinDate ? new Date(c.joinDate).toLocaleDateString() : "—"),
  },
  {
    key: "lastActivity",
    label: "Last Activity",
    format: (c) => (c.lastActivity ? new Date(c.lastActivity).toLocaleDateString() : "—"),
  },
];

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

/**
 * Side-by-side comparison of 2-3 selected collaborators' metrics (#923).
 * Reads from the directory's selection state (passed in as `collaborators`)
 * rather than owning its own selection UI.
 */
export default function CollaboratorComparison({
  collaborators,
}: CollaboratorComparisonProps) {
  if (collaborators.length < MIN_COMPARE) {
    return (
      <div className="cc-empty" data-testid="collaborator-comparison-empty">
        <p>Select at least {MIN_COMPARE} collaborators to compare.</p>
      </div>
    );
  }

  const compared = collaborators.slice(0, MAX_COMPARE);
  const overflow = collaborators.length > MAX_COMPARE;

  return (
    <div className="cc" data-testid="collaborator-comparison">
      {overflow && (
        <p className="cc-overflow-notice">
          Comparing the first {MAX_COMPARE} of {collaborators.length} selected collaborators.
        </p>
      )}
      <table className="cc-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            {compared.map((c) => (
              <th scope="col" key={c.address}>
                <code title={c.address}>{shortAddress(c.address)}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRICS.map((metric) => (
            <tr key={metric.key}>
              <th scope="row">{metric.label}</th>
              {compared.map((c) => (
                <td key={c.address}>{metric.format(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
