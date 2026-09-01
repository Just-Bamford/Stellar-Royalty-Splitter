import { useState, useEffect } from "react";
import { api } from "../api";
import "./PaymentPreferences.css";

export type PaymentMethod = "direct_transfer" | "usdc" | "xlm";

interface PaymentMethodOption {
  id: PaymentMethod;
  label: string;
  icon: string;
  description: string;
  pros: string[];
  cons: string[];
}

const PAYMENT_METHODS: PaymentMethodOption[] = [
  {
    id: "direct_transfer",
    label: "Direct Transfer",
    icon: "🔀",
    description:
      "Receive royalties as a direct on-chain transfer in the token used during distribution.",
    pros: [
      "Instant settlement — no conversion step",
      "Lowest transaction overhead",
      "Works with any Stellar token",
    ],
    cons: [
      "Payout token depends on what was distributed",
      "May require manual conversion to stable value",
    ],
  },
  {
    id: "usdc",
    label: "Stablecoin (USDC)",
    icon: "💵",
    description:
      "Receive royalties converted to USD Coin, a price-stable asset pegged 1:1 to the US dollar.",
    pros: [
      "Price-stable — protected from XLM volatility",
      "Widely accepted and easy to off-ramp",
      "Good for predictable income planning",
    ],
    cons: [
      "Requires an active USDC trustline on your account",
      "Conversion adds a small extra step during distribution",
    ],
  },
  {
    id: "xlm",
    label: "Native (XLM)",
    icon: "⭐",
    description:
      "Receive royalties in XLM, Stellar's native currency — no trustlines required.",
    pros: [
      "No trustline needed — works out of the box",
      "Fastest network settlement times",
      "Supported by every Stellar wallet",
    ],
    cons: [
      "Subject to XLM price volatility",
      "Value may fluctuate between sale and receipt",
    ],
  },
];

interface PaymentPreferencesProps {
  /** Connected wallet address (G-address). If absent, the section is disabled. */
  walletAddress: string;
}

export const PaymentPreferences: React.FC<PaymentPreferencesProps> = ({
  walletAddress,
}) => {
  const [selected, setSelected] = useState<PaymentMethod | null>(null);
  const [pending, setPending] = useState<PaymentMethod | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Load saved preference on mount / wallet change
  useEffect(() => {
    if (!walletAddress) return;
    setFetchError(null);

    api
      .getPaymentPreference(walletAddress)
      .then((data) => {
        setSelected(data.paymentMethod as PaymentMethod);
        setPending(data.paymentMethod as PaymentMethod);
      })
      .catch((err: Error) => {
        // 404 = not yet set — that's fine
        if (!err.message.includes("404") && !err.message.includes("not_found")) {
          setFetchError(err.message);
        }
      });
  }, [walletAddress]);

  const isDirty = pending !== selected;

  // #771: optimistic update with rollback. A network drop mid-submit must
  // not lose the user's choice or leave the UI stuck between the old and
  // new value — we apply the choice immediately, then reconcile once the
  // request (or the service worker's offline queue) resolves it.
  const handleSave = async () => {
    if (!walletAddress || !pending) return;
    const previousSelected = selected;
    setLoading(true);
    setSaveStatus(null);
    setSelected(pending); // optimistic

    try {
      const result = await api.savePaymentPreference(walletAddress, pending);

      if (result?.queued) {
        // Offline: the service worker accepted the write into its retry
        // queue. Keep the optimistic value — it's a "will happen" pending
        // state, not a failure — and say so instead of claiming success.
        setSaveStatus({
          type: "success",
          message: "⏳ You're offline — this will sync automatically once you reconnect.",
        });
        return;
      }

      if (result?.offline && !result?.queued) {
        // Offline queue is full — the write was rejected outright, not
        // just delayed, so roll back rather than leave a stale optimistic
        // value the backend never received.
        setSelected(previousSelected);
        setSaveStatus({
          type: "error",
          message: `✗ ${result.message ?? "Offline queue is full. Please try again once back online."}`,
        });
        return;
      }

      setSelected((result.paymentMethod as PaymentMethod) ?? pending);
      setSaveStatus({ type: "success", message: "✓ Payment preference saved!" });
    } catch (err: unknown) {
      // Hard failure (validation error, 5xx, etc.) — revert the optimistic
      // update so the UI reflects what the backend actually has.
      setSelected(previousSelected);
      const message =
        err instanceof Error ? err.message : "Failed to save preference.";
      setSaveStatus({ type: "error", message: `✗ ${message}` });
    } finally {
      setLoading(false);
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  const disabled = !walletAddress;

  return (
    <section
      className={`payment-preferences settings-section${disabled ? " payment-preferences--disabled" : ""}`}
      aria-label="Payment Preferences"
    >
      <h2 className="section-title">💳 Payment Preferences</h2>

      {disabled && (
        <p className="payment-preferences__notice">
          Connect your wallet to set your preferred payment method.
        </p>
      )}

      {!disabled && fetchError && (
        <p className="payment-preferences__error" role="alert">
          {fetchError}
        </p>
      )}

      {saveStatus && (
        <div
          className={`save-status save-status--${saveStatus.type}`}
          role="status"
        >
          {saveStatus.message}
        </div>
      )}

      <p className="payment-preferences__intro">
        Choose how you'd like to receive your royalty payouts. Your preference
        is saved per wallet address and applies to all future distributions.
      </p>

      <div className="payment-preferences__grid" role="radiogroup" aria-label="Payment methods">
        {PAYMENT_METHODS.map((method) => {
          const isActive = pending === method.id;
          return (
            <button
              key={method.id}
              role="radio"
              aria-checked={isActive}
              className={`payment-method-card${isActive ? " payment-method-card--selected" : ""}`}
              onClick={() => !disabled && setPending(method.id)}
              disabled={disabled}
              aria-disabled={disabled}
              type="button"
            >
              {/* Selected indicator */}
              {isActive && (
                <span className="payment-method-card__check" aria-hidden="true">
                  ✓
                </span>
              )}

              <div className="payment-method-card__header">
                <span className="payment-method-card__icon" aria-hidden="true">
                  {method.icon}
                </span>
                <span className="payment-method-card__label">{method.label}</span>
              </div>

              <p className="payment-method-card__desc">{method.description}</p>

              <div className="payment-method-card__pros-cons">
                <ul className="pros-list" aria-label="Pros">
                  {method.pros.map((pro) => (
                    <li key={pro} className="pros-list__item">
                      <span aria-hidden="true">✅</span> {pro}
                    </li>
                  ))}
                </ul>
                <ul className="cons-list" aria-label="Cons">
                  {method.cons.map((con) => (
                    <li key={con} className="cons-list__item">
                      <span aria-hidden="true">⚠️</span> {con}
                    </li>
                  ))}
                </ul>
              </div>
            </button>
          );
        })}
      </div>

      <div className="payment-preferences__actions">
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={disabled || loading || !pending || !isDirty}
          type="button"
          aria-busy={loading}
        >
          {loading ? "Saving…" : "💾 Save Preference"}
        </button>
        {isDirty && selected && (
          <button
            className="btn-secondary"
            onClick={() => setPending(selected)}
            disabled={loading}
            type="button"
          >
            ↩ Revert
          </button>
        )}
      </div>
    </section>
  );
};
