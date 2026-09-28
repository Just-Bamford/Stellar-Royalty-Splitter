import { useState } from "react";
import { api } from "../api";

interface KrakenWithdrawalProps {
  walletAddress: string;
  onSuccess?: (result: any) => void;
  onError?: (error: string) => void;
}

export const KrakenWithdrawal: React.FC<KrakenWithdrawalProps> = ({
  walletAddress,
  onSuccess,
  onError,
}) => {
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState("");
  const [connected, setConnected] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const handleConnect = async () => {
    setLoading(true);
    try {
      const redirectUri = `${window.location.origin}/kraken-callback`;
      const response = await api.get("/withdrawals/kraken/oauth/url", {
        redirect_uri: redirectUri,
      });

      if (response.authUrl) {
        window.location.href = response.authUrl;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Connection failed";
      onError?.(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleWithdraw = async () => {
    if (!accessToken || !amount) return;

    setLoading(true);
    try {
      const result = await api.post("/withdrawals/kraken/withdraw", {
        walletAddress,
        amount: parseFloat(amount),
        accessToken,
      });

      onSuccess?.(result);
      setAmount("");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Withdrawal failed";
      onError?.(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="kraken-withdrawal">
      {!connected ? (
        <button onClick={handleConnect} disabled={loading} className="btn-primary">
          {loading ? "Connecting..." : "Connect Kraken Account"}
        </button>
      ) : (
        <div className="kraken-withdrawal__form">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount in XLM"
            className="input-field"
          />
          <button
            onClick={handleWithdraw}
            disabled={loading || !amount}
            className="btn-primary"
          >
            {loading ? "Processing..." : "Withdraw to Kraken"}
          </button>
        </div>
      )}
    </div>
  );
};
