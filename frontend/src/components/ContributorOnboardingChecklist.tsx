import React, { useState, useEffect, useCallback } from "react";
import {
  api,
  OnboardingStatusResponse,
  OnboardingItem,
  OnboardingReminderResponse,
} from "../api";
import "./ContributorOnboardingChecklist.css";

interface ContributorOnboardingChecklistProps {
  walletAddress: string | null;
  onConnectWallet?: () => void;
  onSelectContract?: () => void;
}

export const ContributorOnboardingChecklist: React.FC<
  ContributorOnboardingChecklistProps
> = ({ walletAddress, onConnectWallet }) => {
  const [data, setData] = useState<OnboardingStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [emailInput, setEmailInput] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailToast, setEmailToast] = useState<{
    type: "success" | "error";
    message: string;
    preview?: string;
  } | null>(null);

  // Demo state switcher for quick testing (0%, 50%, 100%)
  const [demoState, setDemoState] = useState<"live" | "0" | "50" | "100">("live");

  const effectiveAddress =
    walletAddress || "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCWA4V";

  const fetchStatus = useCallback(async () => {
    if (!walletAddress && demoState === "live") {
      // Build unauthenticated initial state (0% completion or wallet disconnected)
      setData({
        walletAddress: "",
        email: "",
        kycStatus: "pending",
        payoutToken: "XLM",
        paymentPreferencesSet: false,
        taxInfoSubmitted: false,
        items: [
          {
            id: "wallet_connected",
            label: "Wallet connected",
            description: "Connect a Stellar wallet (e.g. Freighter) to get started.",
            completed: false,
            required: true,
            category: "setup",
          },
          {
            id: "kyc_verified",
            label: "KYC verified",
            description: "Complete identity verification for protocol compliance.",
            completed: false,
            required: true,
            category: "compliance",
          },
          {
            id: "payment_preferences_set",
            label: "Payment preferences set",
            description: "Configure preferred payout token/asset for distributions.",
            completed: false,
            required: true,
            category: "finance",
          },
          {
            id: "tax_info_submitted",
            label: "Tax info submitted",
            description: "Submit required tax documentation (W-8BEN / W-9).",
            completed: false,
            required: true,
            category: "compliance",
          },
          {
            id: "first_distribution_received",
            label: "First distribution received",
            description: "Receive your first royalty split distribution payout.",
            completed: false,
            required: false,
            category: "milestone",
          },
        ],
        completedCount: 0,
        totalCount: 5,
        completionPercentage: 0,
        requiredComplete: false,
        actionsLocked: true,
        nextStep: {
          id: "wallet_connected",
          label: "Connect Wallet",
          description: "Connect a Stellar wallet (e.g. Freighter) to get started.",
        },
      });
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await api.getOnboardingStatus(effectiveAddress);
      setData(res);
      if (res.email) {
        setEmailInput(res.email);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load onboarding status";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [walletAddress, effectiveAddress, demoState]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Demo overrides for acceptance criteria tests (0%, 50%, 100%)
  const displayData = React.useMemo<OnboardingStatusResponse | null>(() => {
    if (!data) return null;
    if (demoState === "live") return data;

    const baseItems: OnboardingItem[] = [
      {
        id: "wallet_connected",
        label: "Wallet connected",
        description: "Connect a Stellar wallet (e.g. Freighter) to get started.",
        completed: demoState !== "0",
        required: true,
        category: "setup",
      },
      {
        id: "kyc_verified",
        label: "KYC verified",
        description: "Complete identity verification for protocol compliance.",
        completed: demoState === "100",
        required: true,
        category: "compliance",
      },
      {
        id: "payment_preferences_set",
        label: "Payment preferences set",
        description: "Configure preferred payout token/asset for distributions.",
        completed: demoState === "50" || demoState === "100",
        required: true,
        category: "finance",
      },
      {
        id: "tax_info_submitted",
        label: "Tax info submitted",
        description: "Submit required tax documentation (W-8BEN / W-9).",
        completed: demoState === "100",
        required: true,
        category: "compliance",
      },
      {
        id: "first_distribution_received",
        label: "First distribution received",
        description: "Receive your first royalty split distribution payout.",
        completed: demoState === "100",
        required: false,
        category: "milestone",
      },
    ];

    const completedCount = baseItems.filter((i) => i.completed).length;
    const totalCount = baseItems.length;
    const percentage = demoState === "0" ? 0 : demoState === "50" ? 40 : 100;
    const requiredComplete = demoState === "100";
    const nextStepItem = baseItems.find((i) => !i.completed);

    return {
      ...data,
      items: baseItems,
      completedCount,
      totalCount,
      completionPercentage: percentage,
      requiredComplete,
      actionsLocked: !requiredComplete,
      nextStep: nextStepItem
        ? {
            id: nextStepItem.id,
            label: nextStepItem.label,
            description: nextStepItem.description,
          }
        : null,
    };
  }, [data, demoState]);

  async function handleToggleStep(itemId: string, currentCompleted: boolean) {
    if (!walletAddress) return;
    try {
      let updatePayload = {};
      if (itemId === "kyc_verified") {
        updatePayload = { kycStatus: currentCompleted ? "pending" : "verified" };
      } else if (itemId === "payment_preferences_set") {
        updatePayload = { paymentPreferencesSet: !currentCompleted };
      } else if (itemId === "tax_info_submitted") {
        updatePayload = { taxInfoSubmitted: !currentCompleted };
      }

      const res = await api.updateOnboardingStatus(walletAddress, updatePayload);
      setData(res.summary);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update item";
      setError(msg);
    }
  }

  async function handleSendReminder(e: React.FormEvent) {
    e.preventDefault();
    if (!emailInput || !emailInput.includes("@")) {
      setEmailToast({
        type: "error",
        message: "Please enter a valid email address.",
      });
      return;
    }

    setSendingEmail(true);
    setEmailToast(null);

    const targetAddress = walletAddress || effectiveAddress;

    try {
      const res: OnboardingReminderResponse = await api.sendOnboardingReminder(
        targetAddress,
        emailInput,
      );
      setEmailToast({
        type: "success",
        message: res.message,
        preview: res.emailDetails.previewText,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to send email reminder";
      setEmailToast({ type: "error", message: msg });
    } finally {
      setSendingEmail(false);
    }
  }

  if (loading && !displayData) {
    return (
      <div className="onboarding-checklist-card">
        <p>Loading contributor onboarding checklist...</p>
      </div>
    );
  }

  if (!displayData) {
    return null;
  }

  const {
    completionPercentage,
    completedCount,
    totalCount,
    items,
    actionsLocked,
    nextStep,
  } = displayData;

  return (
    <div className="onboarding-checklist-card" data-testid="onboarding-checklist">
      {/* Card Header & Demo Switcher */}
      <div className="onboarding-checklist-header">
        <div className="onboarding-checklist-title">
          <h2>🚀 Contributor Onboarding Checklist</h2>
          <p>
            Track setup progress, fulfill compliance requirements, and unlock distribution actions.
          </p>
        </div>

        {/* Demo State Selector for Acceptance Criteria (0%, 50%, 100%) */}
        <div className="onboarding-state-controls">
          <label>Test State:</label>
          <button
            type="button"
            className={`onboarding-state-btn ${demoState === "live" ? "active" : ""}`}
            onClick={() => setDemoState("live")}
          >
            Live
          </button>
          <button
            type="button"
            className={`onboarding-state-btn ${demoState === "0" ? "active" : ""}`}
            onClick={() => setDemoState("0")}
          >
            0%
          </button>
          <button
            type="button"
            className={`onboarding-state-btn ${demoState === "50" ? "active" : ""}`}
            onClick={() => setDemoState("50")}
          >
            50%
          </button>
          <button
            type="button"
            className={`onboarding-state-btn ${demoState === "100" ? "active" : ""}`}
            onClick={() => setDemoState("100")}
          >
            100%
          </button>
        </div>
      </div>

      {error && <div className="onboarding-email-toast error">{error}</div>}

      {/* Progress Bar Section */}
      <div className="onboarding-progress-section">
        <div className="onboarding-progress-header">
          <span className="onboarding-progress-label">
            Overall Completion ({completedCount} of {totalCount} completed)
          </span>
          <span className="onboarding-progress-percent">{completionPercentage}%</span>
        </div>
        <div className="onboarding-progress-track">
          <div
            className="onboarding-progress-fill"
            style={{ width: `${completionPercentage}%` }}
            role="progressbar"
            aria-valuenow={completionPercentage}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>

      {/* Action Lock Warning Banner */}
      <div className={`onboarding-lock-banner ${actionsLocked ? "locked" : "unlocked"}`}>
        <span className="onboarding-lock-icon">{actionsLocked ? "🔒" : "🔓"}</span>
        <div>
          <strong>
            {actionsLocked
              ? "Restricted Actions Locked"
              : "All Required Steps Complete! Payout Actions Unlocked"}
          </strong>
          <p style={{ margin: "2px 0 0 0" }}>
            {actionsLocked
              ? "All required compliance and preference steps must be complete before initializing contracts or distributing royalty splits."
              : "Your account is fully verified and configured to execute distribution transactions."}
          </p>
        </div>
      </div>

      {/* Next Step Callout */}
      {nextStep && (
        <div className="onboarding-next-step-card">
          <div className="onboarding-next-step-content">
            <h4>👉 Next Required Step: {nextStep.label}</h4>
            <p>{nextStep.description}</p>
          </div>
          {nextStep.id === "wallet_connected" && !walletAddress && (
            <button
              type="button"
              className="onboarding-action-btn"
              onClick={onConnectWallet}
            >
              Connect Wallet
            </button>
          )}
          {nextStep.id !== "wallet_connected" && (
            <button
              type="button"
              className="onboarding-action-btn"
              onClick={() => handleToggleStep(nextStep.id, false)}
            >
              Mark Complete
            </button>
          )}
        </div>
      )}

      {/* Checklist Items List */}
      <div className="onboarding-items-list">
        {items.map((item) => (
          <div
            key={item.id}
            className={`onboarding-item-row ${
              item.completed ? "completed" : `pending ${item.required ? "required" : "optional"}`
            }`}
          >
            <div className="onboarding-item-left">
              <div
                className={`onboarding-item-checkbox ${
                  item.completed ? "checked" : "unchecked"
                }`}
              >
                {item.completed ? "✓" : ""}
              </div>
              <div className="onboarding-item-info">
                <h4>
                  {item.label}
                  <span
                    className={`onboarding-badge ${
                      item.completed ? "done" : item.required ? "required" : "optional"
                    }`}
                  >
                    {item.completed
                      ? "Completed"
                      : item.required
                      ? "Required (Blocking)"
                      : "Optional / Milestone"}
                  </span>
                </h4>
                <p>{item.description}</p>
              </div>
            </div>

            <div className="onboarding-item-right">
              {item.id === "wallet_connected" && !item.completed && (
                <button
                  type="button"
                  className="onboarding-btn-small"
                  onClick={onConnectWallet}
                >
                  Connect Wallet
                </button>
              )}

              {item.id !== "wallet_connected" && item.id !== "first_distribution_received" && (
                <button
                  type="button"
                  className="onboarding-btn-small"
                  onClick={() => handleToggleStep(item.id, item.completed)}
                >
                  {item.completed ? "Mark Pending" : "Complete"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Email Reminder Box */}
      <div className="onboarding-email-reminder-box">
        <h3>📧 Send Email Reminder for Incomplete Items</h3>
        <p>
          Enter your email to receive an instant reminder with your current progress, pending steps, and action links.
        </p>
        <form className="onboarding-email-form" onSubmit={handleSendReminder}>
          <input
            type="email"
            className="onboarding-email-input"
            placeholder="contributor@example.com"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            required
          />
          <button
            type="submit"
            className="onboarding-email-btn"
            disabled={sendingEmail}
          >
            {sendingEmail ? "Sending..." : "Send Reminder Email"}
          </button>
        </form>

        {emailToast && (
          <div className={`onboarding-email-toast ${emailToast.type}`}>
            <span>{emailToast.message}</span>
          </div>
        )}
      </div>
    </div>
  );
};
