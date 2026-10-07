import { useState, useEffect } from "react";
import { api } from "../api";

export const YieldDashboard: React.FC = () => {
  const [apy, setApy] = useState<number | null>(null);
  const [balance, setBalance] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [apyData, balanceData] = await Promise.all([
        api.get("/yield/compound/apy"),
        api.get("/yield/compound/balance"),
      ]);
      setApy(apyData.apy);
      setBalance(balanceData);
    } catch (error) {
      console.error("Failed to load yield data", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeposit = async () => {
    if (!depositAmount) return;
    try {
      await api.post("/yield/compound/deposit", { amount: parseFloat(depositAmount) });
      setDepositAmount("");
      loadData();
    } catch (error) {
      console.error("Deposit failed", error);
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawAmount) return;
    try {
      await api.post("/yield/compound/withdraw", { amount: parseFloat(withdrawAmount) });
      setWithdrawAmount("");
      loadData();
    } catch (error) {
      console.error("Withdrawal failed", error);
    }
  };

  if (loading) {
    return <div className="yield-dashboard">Loading yield data...</div>;
  }

  return (
    <div className="yield-dashboard">
      <h2>Compound Finance Yield</h2>

      {apy !== null && (
        <div className="yield-dashboard__apy">
          <span>Current APY: </span>
          <strong>{(apy * 100).toFixed(2)}%</strong>
        </div>
      )}

      {balance && (
        <div className="yield-dashboard__balance">
          <div>Total Deposited: {balance.totalDeposited} XLM</div>
          <div>Current Balance: {balance.currentBalance} XLM</div>
          <div>Yield Earned: {balance.yieldEarned} XLM</div>
        </div>
      )}

      <div className="yield-dashboard__actions">
        <div className="yield-dashboard__deposit">
          <input
            type="number"
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
            placeholder="Deposit amount (XLM)"
            className="input-field"
          />
          <button onClick={handleDeposit} disabled={!depositAmount} className="btn-primary">
            Deposit
          </button>
        </div>

        <div className="yield-dashboard__withdraw">
          <input
            type="number"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            placeholder="Withdraw amount (XLM)"
            className="input-field"
          />
          <button onClick={handleWithdraw} disabled={!withdrawAmount} className="btn-secondary">
            Withdraw
          </button>
        </div>
      </div>
    </div>
  );
};
