import React, { useState } from "react";
import { SecondarySale } from "../api";
import "./ResaleHistory.css";
import { formatNumber } from "../utils/format";
import { useSecondarySales, useSecondaryDistributions } from "../hooks/queries/useSecondarySales";

interface Props {
  contractId: string;
}

interface DistributionRecord {
  id: number;
  transactionId: number;
  totalRoyaltiesDistributed: string;
  numberOfSales: number;
  timestamp: string;
  txHash: string | null;
  status: string;
  initiatorAddress: string;
}

export default function ResaleHistory({ contractId }: Props) {
  const [activeTab, setActiveTab] = useState<"sales" | "distributions">("sales");
  const [salesOffset, setSalesOffset] = useState(0);
  const [distributionsOffset, setDistributionsOffset] = useState(0);
  const LIMIT = 10;

  // React Query hooks — cached and deduplicated (#832)
  const salesQuery = useSecondarySales(contractId || undefined, LIMIT, salesOffset);
  const distributionsQuery = useSecondaryDistributions(contractId || undefined, LIMIT, distributionsOffset);

  const sales: SecondarySale[] = salesQuery.data?.sales ?? [];
  const salesTotal = salesQuery.data?.total ?? 0;
  const distributions: DistributionRecord[] = (distributionsQuery.data?.distributions ?? []) as DistributionRecord[];
  const distributionsTotal = distributionsQuery.data?.total ?? 0;
  const loading = salesQuery.isLoading || distributionsQuery.isLoading;

  // Reset offsets when contract changes
  React.useEffect(() => {
    setSalesOffset(0);
    setDistributionsOffset(0);
  }, [contractId]);

  if (loading) {
    return (
      <div className="card">
        <p>Loading resale history...</p>
      </div>
    );
  }

  return (
    <div className="card resale-history">
      <h3>Resale & Royalty History</h3>

      <div className="tabs">
        <button
          className={`tab ${activeTab === "sales" ? "active" : ""}`}
          onClick={() => setActiveTab("sales")}
        >
          Secondary Sales ({salesTotal})
        </button>
        <button
          className={`tab ${activeTab === "distributions" ? "active" : ""}`}
          onClick={() => setActiveTab("distributions")}
        >
          Distributions ({distributionsTotal})
        </button>
      </div>

      {activeTab === "sales" && (
        <div className="content">
          {sales.length === 0 ? (
            <p className="empty-state">No secondary sales recorded yet.</p>
          ) : (
            <>
              <div className="table-container">
                <table className="resale-table">
                  <thead>
                    <tr>
                      <th>NFT ID</th>
                      <th>Sale Price</th>
                      <th>Royalty (bp)</th>
                      <th>Royalty Amount</th>
                      <th>Buyer</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.map((sale) => (
                      <tr key={sale.id}>
                        <td className="nft-id">
                          {sale.nftId.substring(0, 16)}...
                        </td>
                        <td>{formatNumber(sale.salePrice)}</td>
                        <td>{sale.royaltyRate / 100}%</td>
                        <td className="royalty-amount">{formatNumber(sale.royaltyAmount)}</td>
                        <td className="address">
                          {sale.newOwner.substring(0, 8)}...
                        </td>
                        <td>{new Date(sale.timestamp).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <button
                  onClick={() => setSalesOffset(Math.max(0, salesOffset - LIMIT))}
                  disabled={salesOffset === 0}
                >
                  Previous
                </button>
                <span>
                  Showing {salesOffset + 1}–{Math.min(salesOffset + LIMIT, salesTotal)} of {salesTotal} sales
                </span>
                <button
                  onClick={() => setSalesOffset(salesOffset + LIMIT)}
                  disabled={salesOffset + sales.length >= salesTotal}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "distributions" && (
        <div className="content">
          {distributions.length === 0 ? (
            <p className="empty-state">No distributions yet.</p>
          ) : (
            <>
              <div className="table-container">
                <table className="distribution-table">
                  <thead>
                    <tr>
                      <th>Total Distributed</th>
                      <th>Sales Count</th>
                      <th>Status</th>
                      <th>Initiator</th>
                      <th>Date</th>
                      <th>TX Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {distributions.map((dist) => (
                      <tr key={dist.id}>
                        <td className="amount">
                          {formatNumber(dist.totalRoyaltiesDistributed)}
                        </td>
                        <td>{dist.numberOfSales}</td>
                        <td className={`status ${dist.status}`}>{dist.status}</td>
                        <td className="address">
                          {dist.initiatorAddress.substring(0, 8)}...
                        </td>
                        <td>{new Date(dist.timestamp).toLocaleDateString()}</td>
                        <td className="tx-hash">
                          {dist.txHash
                            ? dist.txHash.substring(0, 12) + "..."
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <button
                  onClick={() => setDistributionsOffset(Math.max(0, distributionsOffset - LIMIT))}
                  disabled={distributionsOffset === 0}
                >
                  Previous
                </button>
                <span>
                  Showing {distributionsOffset + 1}–{Math.min(distributionsOffset + LIMIT, distributionsTotal)} of {distributionsTotal} distributions
                </span>
                <button
                  onClick={() => setDistributionsOffset(distributionsOffset + LIMIT)}
                  disabled={distributionsOffset + distributions.length >= distributionsTotal}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
