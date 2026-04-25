import { useState, useEffect } from "react";
import { api, SecondarySale } from "../api";
import "./ResaleHistory.css";

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
  const [sales, setSales] = useState<SecondarySale[]>([]);
  const [distributions, setDistributions] = useState<DistributionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"sales" | "distributions">(
    "sales",
  );
  const [salesOffset, setSalesOffset] = useState(0);
  const [distributionsOffset, setDistributionsOffset] = useState(0);
  const [salesTotal, setSalesTotal] = useState(0);
  const [distributionsTotal, setDistributionsTotal] = useState(0);
  const LIMIT = 10;

  const loadData = async (offset: number) => {
    if (!contractId) return;

    setLoading(true);
    try {
      const [salesData, distributionsData] = await Promise.all([
        api.getSecondarySales(contractId, LIMIT, offset),
        api.getSecondaryRoyaltyDistributions(contractId, LIMIT, offset),
      ]);

      setSales(salesData.sales || []);
      setSalesTotal(salesData.total || 0);
      
      setDistributions(distributionsData.distributions || []);
      setDistributionsTotal(distributionsData.total || 0);
    } catch (err) {
      console.error("Error loading resale history", err);
    } finally {
      setLoading(false);
    }
  };

  // Reset offsets and reload when contract changes
  useEffect(() => {
    setSalesOffset(0);
    setDistributionsOffset(0);
    loadData(0);
  }, [contractId]);

  // Reload when sales offset changes
  useEffect(() => {
    if (activeTab === "sales") {
      loadData(salesOffset);
    }
  }, [salesOffset]);

  // Reload when distributions offset changes
  useEffect(() => {
    if (activeTab === "distributions") {
      loadData(distributionsOffset);
    }
  }, [distributionsOffset]);

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
                        <td>{sale.salePrice}</td>
                        <td>{sale.royaltyRate / 100}%</td>
                        <td className="royalty-amount">{sale.royaltyAmount}</td>
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
                          {dist.totalRoyaltiesDistributed}
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
