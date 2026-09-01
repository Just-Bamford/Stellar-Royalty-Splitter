import React from "react";
import { formatNumber, formatCurrency } from "../../utils/format";

export interface EarnerStat {
  address: string;
  totalEarned: number;
  payouts: number;
}

interface TopEarnersProps {
  earners: EarnerStat[];
  totalDistributed: number;
  displayCurrency: string;
}

/**
 * TopEarners — ranked list of collaborators by total earnings, with share
 * percentage relative to the total distributed amount.
 */
export const TopEarners: React.FC<TopEarnersProps> = ({
  earners,
  totalDistributed,
  displayCurrency,
}) => {
  return (
    <div className="top-earners-section">
      <h2>Top Earners</h2>
      <div className="earners-list">
        {earners.length > 0 ? (
          earners.map((earner, index) => (
            <div key={index} className="earner-card">
              <div className="earner-rank">#{index + 1}</div>
              <div className="earner-info">
                <div className="earner-address">
                  {earner.address.slice(0, 10)}...{earner.address.slice(-6)}
                </div>
                <div className="earner-stats">
                  <span className="earner-amount">
                    {formatCurrency(earner.totalEarned, displayCurrency)}
                  </span>
                  <span className="earner-count">
                    {formatNumber(earner.payouts)} payouts
                  </span>
                </div>
              </div>
              <div className="earner-percentage">
                {totalDistributed > 0
                  ? ((earner.totalEarned / totalDistributed) * 100).toFixed(1)
                  : "0.0"}
                %
              </div>
            </div>
          ))
        ) : (
          <div className="no-data">No earnings yet</div>
        )}
      </div>
    </div>
  );
};

export default TopEarners;
