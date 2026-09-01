/**
 * NotificationPreferences — closes #605.
 *
 * Lets contributors choose which channels they want to receive notifications
 * on: email, SMS, in-app, and push.  Rendered inside the Settings page.
 */
import { useState, useEffect } from "react";
import { api } from "../api";

interface Props {
  walletAddress: string;
}

interface Channels {
  email: boolean;
  sms: boolean;
  inApp: boolean;
  push: boolean;
}

const CHANNEL_LABELS: Record<keyof Channels, string> = {
  email: "Email",
  sms: "SMS",
  inApp: "In-App",
  push: "Push",
};

const CHANNEL_DESCRIPTIONS: Record<keyof Channels, string> = {
  email: "Receive email notifications for distributions and updates",
  sms: "Receive SMS text messages for critical events",
  inApp: "Show in-app alerts while you have the dashboard open",
  push: "Browser push notifications (requires permission)",
};

function boolFromInt(v: number | boolean): boolean {
  return Boolean(v);
}

export function NotificationPreferences({ walletAddress }: Props) {
  const [channels, setChannels] = useState<Channels>({
    email: true,
    sms: false,
    inApp: true,
    push: false,
  });
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!walletAddress) return;
    let cancelled = false;

    api
      .getNotificationPreferences(walletAddress)
      .then((prefs) => {
        if (cancelled) return;
        setChannels({
          email: boolFromInt(prefs.email),
          sms:   boolFromInt(prefs.sms),
          inApp: boolFromInt(prefs.inApp),
          push:  boolFromInt(prefs.push),
        });
      })
      .catch(() => {
        // Silent — use defaults
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  function toggle(channel: keyof Channels) {
    setChannels((prev) => ({ ...prev, [channel]: !prev[channel] }));
  }

  async function handleSave() {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    setSaveStatus(null);

    try {
      await api.saveNotificationPreferences(walletAddress, channels);
      setSaveStatus("✓ Notification preferences saved");
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save preferences");
    } finally {
      setLoading(false);
    }
  }

  if (!walletAddress) {
    return (
      <section className="settings-section">
        <h2 className="section-title">Notification Preferences</h2>
        <p className="description">Connect your wallet to manage notification preferences.</p>
      </section>
    );
  }

  return (
    <section className="settings-section" aria-label="Notification preferences">
      <h2 className="section-title">Notification Preferences</h2>
      <p className="description">
        Choose which channels you want to receive notifications on.
      </p>

      {(Object.keys(channels) as (keyof Channels)[]).map((channel) => (
        <div className="setting-item" key={channel}>
          <div className="setting-label">
            <label htmlFor={`notif-${channel}`}>{CHANNEL_LABELS[channel]}</label>
            <p className="setting-description">{CHANNEL_DESCRIPTIONS[channel]}</p>
          </div>
          <button
            id={`notif-${channel}`}
            className={`toggle-btn ${channels[channel] ? "active" : ""}`}
            onClick={() => toggle(channel)}
            disabled={loading}
            aria-pressed={channels[channel]}
          >
            {channels[channel] ? "ON" : "OFF"}
          </button>
        </div>
      ))}

      {error && (
        <p className="field-error" role="alert">{error}</p>
      )}
      {saveStatus && (
        <p className="save-status" role="status">{saveStatus}</p>
      )}

      <div className="form-actions">
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? "Saving…" : "Save Notification Preferences"}
        </button>
      </div>
    </section>
  );
}
