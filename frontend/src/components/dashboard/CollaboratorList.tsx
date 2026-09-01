import React from "react";
import { formatNumber, formatCurrency } from "../../utils/format";

export interface CollaboratorStat {
  address: string;
  totalEarned: number;
  payoutCount: number;
}

interface CollaboratorListProps {
  collaborators: CollaboratorStat[];
  displayCurrency: string;
}

/**
 * CollaboratorList — tabular summary of every collaborator's total earnings,
 * payout count, and computed average payout for the selected period.
 */
export const CollaboratorList: React.FC<CollaboratorListProps> = ({
  collaborators,
  displayCurrency,
}) => {
  return (
    <div className="collaborator-stats-section">
      <h2>Collaborator Summary</h2>
      <div className="stats-table">
        <table>
          <thead>
            <tr>
              <th>Collaborator</th>
              <th className="text-right">Total Earned</th>
              <th className="text-right">Payouts</th>
              <th className="text-right">Avg Payout</th>
            </tr>
          </thead>
          <tbody>
            {collaborators.length > 0 ? (
              collaborators.map((collab, index) => (
                <tr key={index}>
                  <td className="address-cell">
                    {collab.address.slice(0, 10)}...{collab.address.slice(-6)}
                  </td>
                  <td className="text-right">
                    {formatCurrency(collab.totalEarned, displayCurrency)}
                  </td>
                  <td className="text-right">
                    {formatNumber(collab.payoutCount)}
                  </td>
                  <td className="text-right">
                    {collab.payoutCount > 0
                      ? formatCurrency(
                          collab.totalEarned / collab.payoutCount,
                          displayCurrency,
                        )
                      : formatCurrency(0, displayCurrency)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="no-data">
                  No collaborator data
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CollaboratorList;
