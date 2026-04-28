import { useState, useEffect } from "react";
import { api } from "../api";
import { signAndSubmitTransaction } from "../stellar";
import FormStatus from "./FormStatus";
import { useFormStatus } from "../hooks/useFormStatus";

const G_ADDR = /^G[A-Z2-7]{55}$/;
const C_ADDR = /^C[A-Z2-7]{55}$/;

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

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const { status, setStatus } = useFormStatus();
  const [loading, setLoading] = useState(false);
  const [calculatedRoyalty, setCalculatedRoyalty] = useState<bigint | null>(null);

  useEffect(() => {
    const price = BigInt(parseInt(formData.salePrice) || 0);
    if (price > 0n) {
      setCalculatedRoyalty((price * BigInt(royaltyRate)) / 10000n);
    } else {
      setCalculatedRoyalty(null);
    }
  }, [royaltyRate, formData.salePrice]);

  function updateField(field: string, value: string) {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error on change
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: "" }));
    }
  }

  function validateField(field: string, value: string) {
    let err = "";
    if (field === "previousOwner" || field === "newOwner") {
      if (value && !G_ADDR.test(value)) err = "Must be a valid Stellar G-address (56 chars)";
    } else if (field === "saleToken") {
      if (value && !C_ADDR.test(value)) err = "Must be a valid Stellar C-address (56 chars)";
    }
    setFieldErrors((prev) => ({ ...prev, [field]: err }));
  }

  const isFormValid =
    formData.nftId.trim() !== "" &&
    G_ADDR.test(formData.previousOwner) &&
    G_ADDR.test(formData.newOwner) &&
    C_ADDR.test(formData.saleToken) &&
    parseInt(formData.salePrice) > 0;

  async function submit() {
    if (!contractId) {
      return setStatus("error", "Enter a contract ID first.");
    }
    if (!isFormValid) {
      return setStatus("error", "Please fix all field errors before submitting.");
    }

    setLoading(true);
    setStatus("info", "Recording secondary sale...");

    try {
      const { xdr, royaltyAmount } = await api.recordSecondarySale({
        contractId,
        walletAddress,
        nftId: formData.nftId,
        previousOwner: formData.previousOwner,
        newOwner: formData.newOwner,
        salePrice: parseInt(formData.salePrice),
        saleToken: formData.saleToken,
        royaltyRate,
      });

      setStatus("info", "Please sign the transaction...");
      const result = await signAndSubmitTransaction(xdr);

      setStatus("info", "Waiting for confirmation...");
      await api.confirmTransaction(result, {
        status: "confirmed",
        blockTime: new Date().toISOString(),
      });

      setStatus("ok", `Secondary sale recorded! Royalty: ${royaltyAmount} tokens. TX: ${result}`);

      setFormData({ nftId: "", previousOwner: "", newOwner: "", salePrice: "", saleToken: "" });
      setCalculatedRoyalty(null);
      onSuccess();
    } catch (err) {
      setStatus("error", `Error: ${err instanceof Error ? err.message : "Unknown error"}`);
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
            onBlur={(e) => validateField("previousOwner", e.target.value)}
            disabled={loading}
            className={fieldErrors.previousOwner ? "input-error" : ""}
          />
          {fieldErrors.previousOwner && (
            <span className="field-error">{fieldErrors.previousOwner}</span>
          )}
        </div>

        <div className="form-group">
          <label>New Owner</label>
          <input
            type="text"
            placeholder="G..."
            value={formData.newOwner}
            onChange={(e) => updateField("newOwner", e.target.value)}
            onBlur={(e) => validateField("newOwner", e.target.value)}
            disabled={loading}
            className={fieldErrors.newOwner ? "input-error" : ""}
          />
          {fieldErrors.newOwner && (
            <span className="field-error">{fieldErrors.newOwner}</span>
          )}
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
              <span className="calc-result">Royalty: {calculatedRoyalty.toString()}</span>
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
            onBlur={(e) => validateField("saleToken", e.target.value)}
            disabled={loading}
            className={fieldErrors.saleToken ? "input-error" : ""}
          />
          {fieldErrors.saleToken && (
            <span className="field-error">{fieldErrors.saleToken}</span>
          )}
        </div>
      </div>

      {status && <FormStatus type={status.type} message={status.message} />}

      <button onClick={submit} disabled={loading || !isFormValid} className="btn-primary">
        {loading ? "Processing..." : "Record Sale"}
      </button>
    </div>
  );
}
