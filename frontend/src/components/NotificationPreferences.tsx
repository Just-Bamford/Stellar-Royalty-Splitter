/**
 * NotificationPreferences — closes #1046 (expanded from #605).
 *
 * Lets contributors configure:
 * - Channel preferences (email, SMS, in-app, push)
 * - Per-type notification toggles for all new notification categories
 * - Frequency (immediate, daily digest, weekly digest)
 * - Quiet hours (no notifications during a configurable time window)
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

interface TypeToggles {
  distribution: boolean;
  payment: boolean;
  failure: boolean;
  hold: boolean;
  dispute_created: boolean;
  dispute_resolved: boolean;
  reputation_changed: boolean;
  governance: boolean;
  security_alert: boolean;
}

interface QuietHours {
  enabled: boolean;
  start: number;
  end: number;
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

const TYPE_LABELS: Record<keyof TypeToggles, string> = {
  distribution: "Distributions",
  payment: "Payments",
  failure: "Payment Failures",
  hold: "Payment Holds",
  dispute_created: "Dispute Created",
  dispute_resolved: "Dispute Resolved",
  reputation_changed: "Reputation Changes",
  governance: "Governance Proposals",
  security_alert: "Security Alerts",
};

const FREQUENCY_OPTIONS = [
  { value: "immediate", label: "Immediate" },
  { value: "daily_digest", label: "Daily Digest" },
  { value: "weekly_digest", label: "Weekly Digest" },
] as const;

function boolFromInt(v: number | boolean | undefined): boolean {
  if (v === undefined) return false;
  return Boolean(v);
}

function toApiFormat(prefs: {
  channels: Channels;
  typeToggles: TypeToggles;
  frequency: string;
  quietHours: QuietHours;
}) {
  return {
    email_enabled: prefs.channels.email,
    in_app_enabled: prefs.channels.inApp,
    sms_enabled: prefs.channels.sms,
    push_enabled: prefs.channels.push,
    notify_distribution: prefs.typeToggles.distribution,
    notify_payment: prefs.typeToggles.payment,
    notify_failure: prefs.typeToggles.failure,
    notify_hold: prefs.typeToggles.hold,
    notify_dispute_created: prefs.typeToggles.dispute_created,
    notify_dispute_resolved: prefs.typeToggles.dispute_resolved,
    notify_reputation_changed: prefs.typeToggles.reputation_changed,
    notify_governance: prefs.typeToggles.governance,
    notify_security_alert: prefs.typeToggles.security_alert,
    frequency: prefs.frequency,
    quiet_hours_enabled: prefs.quietHours.enabled,
    quiet_hours_start: prefs.quietHours.start,
    quiet_hours_end: prefs.quietHours.end,
  };
}

export function NotificationPreferences({ walletAddress }: Props) {
  const [channels, setChannels] = useState<Channels>({
    email: true,
    sms: false,
    inApp: true,
    push: false,
  });
  const [typeToggles, setTypeToggles] = useState<TypeToggles>({
    distribution: true,
    payment: true,
    failure: true,
    hold: true,
    dispute_created: true,
    dispute_resolved: true,
    reputation_changed: false,
    governance: true,
    security_alert: true,
  });
  const [frequency, setFrequency] = useState<string>("immediate");
  const [quietHours, setQuietHours] = useState<QuietHours>({
    enabled: false,
    start: 21,
    end: 9,
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

        const data = prefs.data ?? prefs;

        if (data.channels || data.email !== undefined) {
          const ch = data.channels ?? {
            email: boolFromInt(data.email),
            sms: boolFromInt(data.sms),
            inApp: boolFromInt(data.inApp),
            push: boolFromInt(data.push),
          };
          setChannels({
            email: boolFromInt(ch.email),
            sms: boolFromInt(ch.sms),
            inApp: boolFromInt(ch.inApp),
            push: boolFromInt(ch.push),
          });
        }

        const toggles = data.typeToggles ?? {
          distribution: boolFromInt(data.notify_distribution),
          payment: boolFromInt(data.notify_payment),
          failure: boolFromInt(data.notify_failure),
          hold: boolFromInt(data.notify_hold),
          dispute_created: boolFromInt(data.notify_dispute_created),
          dispute_resolved: boolFromInt(data.notify_dispute_resolved),
          reputation_changed: boolFromInt(data.notify_reputation_changed),
          governance: boolFromInt(data.notify_governance),
          security_alert: boolFromInt(data.notify_security_alert),
        };
        setTypeToggles(toggles);

        setFrequency(data.frequency ?? "immediate");

        const qh = data.quietHours ?? {
          enabled: boolFromInt(data.quiet_hours_enabled),
          start: data.quiet_hours_start ?? 21,
          end: data.quiet_hours_end ?? 9,
        };
        setQuietHours({
          enabled: qh.enabled,
          start: qh.start ?? 21,
          end: qh.end ?? 9,
        });
      })
      .catch(() => {
        // Silent — use defaults
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  function toggleChannel(channel: keyof Channels) {
    setChannels((prev) => ({ ...prev, [channel]: !prev[channel] }));
  }

  function toggleType(type: keyof TypeToggles) {
    setTypeToggles((prev) => ({ ...prev, [type]: !prev[type] }));
  }

  function toggleQuietHours() {
    setQuietHours((prev) => ({ ...prev, enabled: !prev.enabled }));
  }

  async function handleSave() {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    setSaveStatus(null);

    try {
      await api.saveNotificationPreferences(walletAddress, toApiFormat({
        channels,
        typeToggles,
        frequency,
        quietHours,
      }));
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
        Choose which channels and event types you want to receive notifications on.
      </p>

      <h3 className="subsection-title">Channels</h3>
      {(Object.keys(channels) as (keyof Channels)[]).map((channel) => (
        <div className="setting-item" key={channel}>
          <div className="setting-label">
            <label htmlFor={`notif-channel-${channel}`}>{CHANNEL_LABELS[channel]}</label>
            <p className="setting-description">{CHANNEL_DESCRIPTIONS[channel]}</p>
          </div>
          <button
            id={`notif-channel-${channel}`}
            className={`toggle-btn ${channels[channel] ? "active" : ""}`}
            onClick={() => toggleChannel(channel)}
            disabled={loading}
            aria-pressed={channels[channel]}
          >
            {channels[channel] ? "ON" : "OFF"}
          </button>
        </div>
      ))}

      <h3 className="subsection-title">Notification Types</h3>
      {(Object.keys(typeToggles) as (keyof TypeToggles)[]).map((type) => (
        <div className="setting-item" key={type}>
          <div className="setting-label">
            <label htmlFor={`notif-type-${type}`}>{TYPE_LABELS[type]}</label>
          </div>
          <button
            id={`notif-type-${type}`}
            className={`toggle-btn ${typeToggles[type] ? "active" : ""}`}
            onClick={() => toggleType(type)}
            disabled={loading}
            aria-pressed={typeToggles[type]}
          >
            {typeToggles[type] ? "ON" : "OFF"}
          </button>
        </div>
      ))}

      <h3 className="subsection-title">Delivery Frequency</h3>
      <div className="setting-item">
        <div className="setting-label">
          <label htmlFor="notif-frequency">How often to send notifications</label>
          <p className="setting-description">Immediate sends right away; digests batch into a summary.</p>
        </div>
        <select
          id="notif-frequency"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value)}
          disabled={loading}
          data-testid="frequency-select"
        >
          {FREQUENCY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <h3 className="subsection-title">Quiet Hours</h3>
      <div className="setting-item">
        <div className="setting-label">
          <label htmlFor="notif-quiet-toggle">
            Enable quiet hours (no notifications during this window)
          </label>
          <p className="setting-description">
            Suppresses all notifications between start and end times (local time).
          </p>
        </div>
        <button
          id="notif-quiet-toggle"
          className={`toggle-btn ${quietHours.enabled ? "active" : ""}`}
          onClick={toggleQuietHours}
          disabled={loading}
          aria-pressed={quietHours.enabled}
          data-testid="quiet-hours-toggle"
        >
          {quietHours.enabled ? "ON" : "OFF"}
        </button>
      </div>

      {quietHours.enabled && (
        <div className="quiet-hours-fields">
          <div className="setting-item">
            <label htmlFor="quiet-start">Start hour (0-23)</label>
            <input
              id="quiet-start"
              type="number"
              min={0}
              max={23}
              value={quietHours.start}
              onChange={(e) =>
                setQuietHours({ ...quietHours, start: parseInt(e.target.value) || 0 })
              }
              disabled={loading}
              data-testid="quiet-hours-start"
            />
          </div>
          <div className="setting-item">
            <label htmlFor="quiet-end">End hour (0-23)</label>
            <input
              id="quiet-end"
              type="number"
              min={0}
              max={23}
              value={quietHours.end}
              onChange={(e) =>
                setQuietHours({ ...quietHours, end: parseInt(e.target.value) || 0 })
              }
              disabled={loading}
              data-testid="quiet-hours-end"
            />
          </div>
        </div>
      )}

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
          data-testid="save-preferences-btn"
        >
          {loading ? "Saving…" : "Save Notification Preferences"}
        </button>
      </div>
    </section>
  );
}
