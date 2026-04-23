import { useState, useEffect } from "react";
import { api } from "../api";
import { signAndSubmitTransaction } from "../stellar";


interface Props {
  contractId: string;
  walletAddress: string;
  royaltyRate: number;
  onSuccess: () => void;
}

export default function RecordSecondarySale({
  contractId,
  walletAddress,
  royaltyRate,
  onSuccess,
}: Props) {
  const [formData, setFormData] = useState({
    nftId: "",
    previousOwner: "",
    newOwner: "",
    salePrice: "",
    saleToken: "",
  });

  const [status, setStatus] = useState<{
    type: "ok" | "error" | "info";
    msg: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [calculatedRoyalty, setCalculatedRoyalty] = useState<number | null>(null);

  // Update calculated royalty if royaltyRate or salePrice changes
  useEffect(() => {
    const price = parseInt(formData.salePrice);
    if (!isNaN(price) && price > 0) {
      const royalty = Math.floor((price * royaltyRate) / 10000);
      setCalculatedRoyalty(royalty);
    } else {
      setCalculatedRoyalty(null);
    }
  }, [royaltyRate, formData.salePrice]);

  function updateField(field: string, value: string) {
    setFormData((prev) => ({ ...prev, [field]: value }));
  }

  async function submit() {
    if (!contractId) {
      return setStatus({ type: "error", msg: "Enter a contract ID first." });
    }

    if (!formData.nftId || !formData.previousOwner || !formData.newOwner || !formData.salePrice || !formData.saleToken) {
      return setStatus({ type: "error", msg: "Please fill in all fields." });
    }

    const salePrice = parseInt(formData.salePrice);
    if (isNaN(salePrice) || salePrice <= 0) {
      return setStatus({ type: "error", msg: "Sale price must be a positive number." });
    }

    setLoading(true);
    setStatus({ type: "info", msg: "Recording secondary sale..." });

    try {
      const { xdr, royaltyAmount } = await api.recordSecondarySale({
        contractId,
        walletAddress,
        nftId: formData.nftId,
        previousOwner: formData.previousOwner,
        newOwner: formData.newOwner,
        salePrice,
        saleToken: formData.saleToken,
        royaltyRate,
      });

      setStatus({ type: "info", msg: "Please sign the transaction..." });

      // Sign and submit transaction
      const result = await signAndSubmitTransaction(xdr);

      setStatus({ type: "info", msg: "Waiting for confirmation..." });
      await api.confirmTransaction(result, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      setStatus({
        type: "ok",
        msg: `Secondary sale recorded! Royalty: ${royaltyAmount} tokens. TX: ${result}`,
      });


      setFormData({
        nftId: "",
        previousOwner: "",
        newOwner: "",
        salePrice: "",
        saleToken: "",
      });
      setCalculatedRoyalty(null);
      onSuccess();
    } catch (err) {
      setStatus({
        type: "error",
        msg: `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h3>Record Secondary Sale</h3>
      <p className="description">
        Log an NFT resale and automatically calculate royalties ({(royaltyRate / 100).toFixed(2)}%).
      </p>

      <div className="form-grid">
        <div className="form-group">
          <label>NFT ID</label>
          <input
            type="text"
            placeholder="NFT identifier"
            value={formData.nftId}
            onChange={(e) => updateField("nftId", e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="form-group">
          <label>Previous Owner</label>
          <input
            type="text"
            placeholder="G..."
            value={formData.previousOwner}
            onChange={(e) => updateField("previousOwner", e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="form-group">
          <label>New Owner</label>
          <input
            type="text"
            placeholder="G..."
            value={formData.newOwner}
            onChange={(e) => updateField("newOwner", e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="form-group">
          <label>Sale Price</label>
          <div className="input-with-calc">
            <input
              type="number"
              placeholder="1000"
              value={formData.salePrice}
              onChange={(e) => updateField("salePrice", e.target.value)}
              disabled={loading}
              min="0"
              step="1"
            />
            {calculatedRoyalty !== null && (
              <span className="calc-result">Royalty: {calculatedRoyalty}</span>
            )}
          </div>
        </div>

        <div className="form-group">
          <label>Token Address</label>
          <input
            type="text"
            placeholder="C..."
            value={formData.saleToken}
            onChange={(e) => updateField("saleToken", e.target.value)}
            disabled={loading}
          />
        </div>
      </div>

      {status && (
        <div className={`message ${status.type}`}>
          {status.msg}
        </div>
      )}

      <button onClick={submit} disabled={loading} className="btn-primary">
        {loading ? "Processing..." : "Record Sale"}
      </button>
    </div>
  );
}
