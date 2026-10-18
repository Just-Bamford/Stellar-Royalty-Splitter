import { useState } from "react";
import { api } from "../api";

interface CoinbasePaymentProps {
  amount: number;
  currency?: string;
  onSuccess?: (chargeId: string) => void;
  onError?: (error: string) => void;
}

export const CoinbasePayment: React.FC<CoinbasePaymentProps> = ({
  amount,
  currency = "USD",
  onSuccess,
  onError,
}) => {
  const [loading, setLoading] = useState(false);
  const [chargeUrl, setChargeUrl] = useState<string | null>(null);

  const handlePayment = async () => {
    setLoading(true);
    try {
      const response = await api.post<{ charge?: { hosted_url: string; id: string } }>(
        "/payments/coinbase/create",
        { amount, currency }
      );

      if ((response as any).charge?.hosted_url) {
        setChargeUrl((response as any).charge.hosted_url);
        window.open((response as any).charge.hosted_url, "_blank");
        onSuccess?.((response as any).charge.id);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Payment failed";
      onError?.(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="coinbase-payment">
      <button onClick={handlePayment} disabled={loading} className="btn-primary">
        {loading ? "Processing..." : `Pay ${amount} ${currency} with Coinbase`}
      </button>
      {chargeUrl && (
        <p className="coinbase-payment__link">
          <a href={chargeUrl} target="_blank" rel="noopener noreferrer">
            Open payment page
          </a>
        </p>
      )}
    </div>
  );
};
