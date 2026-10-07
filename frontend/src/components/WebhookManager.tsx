import { useCallback, useEffect, useState } from "react";
import { api, type WebhookDelivery, type WebhookDeliveryStats, type WebhookEntry } from "../api";
import "./WebhookManager.css";

interface WebhookManagerProps {
  contractId: string;
}

const STATUS_FILTERS = ["all", "delivered", "failed", "pending", "exhausted"] as const;

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function statusBadgeClass(status: WebhookDelivery["status"]): string {
  switch (status) {
    case "delivered":
      return "webhook-status-badge delivered";
    case "failed":
      return "webhook-status-badge failed";
    case "exhausted":
      return "webhook-status-badge exhausted";
    default:
      return "webhook-status-badge pending";
  }
}

export function WebhookManager({ contractId }: WebhookManagerProps) {
  const [webhooks, setWebhooks] = useState<WebhookEntry[]>([]);
  const [supportedEvents, setSupportedEvents] = useState<string[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesTotal, setDeliveriesTotal] = useState(0);
  const [stats, setStats] = useState<WebhookDeliveryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newUrl, setNewUrl] = useState("");
  const [newEvents, setNewEvents] = useState<string[]>([]);
  const [registering, setRegistering] = useState(false);
  const [freshSecret, setFreshSecret] = useState<{ webhookId: number; secret: string } | null>(null);

  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [eventFilter, setEventFilter] = useState("all");
  const [testingId, setTestingId] = useState<number | null>(null);
  const [actionId, setActionId] = useState<number | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventsRes, webhooksRes, statsRes, deliveriesRes] = await Promise.all([
        api.getWebhookEvents(),
        api.listWebhooks(contractId),
        api.getWebhookDeliveryStats(contractId),
        api.getWebhookDeliveries(contractId, {
          limit: 50,
          offset: 0,
          event: eventFilter === "all" ? undefined : eventFilter,
          status: statusFilter === "all" ? undefined : statusFilter,
        }),
      ]);
      setSupportedEvents(eventsRes.data);
      setWebhooks(webhooksRes.data);
      setStats(statsRes.data);
      setDeliveries(deliveriesRes.data);
      setDeliveriesTotal(deliveriesRes.pagination.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, [contractId, eventFilter, statusFilter]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  function toggleNewEvent(event: string) {
    setNewEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!newUrl.trim()) return;
    setRegistering(true);
    setError(null);
    setNotice(null);
    setFreshSecret(null);
    try {
      const result = await api.registerWebhook(contractId, newUrl.trim(), newEvents);
      setNewUrl("");
      setNewEvents([]);
      if (result.secret) {
        setFreshSecret({ webhookId: result.webhookId, secret: result.secret });
      }
      setNotice(`Webhook #${result.webhookId} registered successfully.`);
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to register webhook");
    } finally {
      setRegistering(false);
    }
  }

  async function handleDeregister(webhook: WebhookEntry) {
    if (!window.confirm(`Remove webhook ${webhook.url}?`)) return;
    setActionId(webhook.id);
    setError(null);
    try {
      await api.deregisterWebhook(contractId, webhook.id);
      setNotice(`Webhook #${webhook.id} removed.`);
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to remove webhook");
    } finally {
      setActionId(null);
    }
  }

  async function handleTest(webhook: WebhookEntry) {
    setTestingId(webhook.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.testWebhook(contractId, webhook.id);
      if (result.success) {
        setNotice(`Test ping delivered to webhook #${webhook.id}.`);
      } else {
        setError(`Test ping to webhook #${webhook.id} failed: ${result.error ?? "unknown error"}`);
      }
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to test webhook");
    } finally {
      setTestingId(null);
    }
  }

  async function handleRotateSecret(webhook: WebhookEntry) {
    if (!window.confirm(`Rotate the HMAC secret for webhook #${webhook.id}? The old secret stops working immediately.`)) return;
    setActionId(webhook.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.rotateWebhookSecret(contractId, webhook.id);
      setFreshSecret({ webhookId: result.webhookId, secret: result.secret });
      setNotice(`Secret rotated for webhook #${webhook.id}. Update the receiver now.`);
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to rotate secret");
    } finally {
      setActionId(null);
    }
  }

  if (loading && webhooks.length === 0 && !stats) {
    return (
      <div className="webhook-manager">
        <div className="webhook-loading">Loading webhooks...</div>
      </div>
    );
  }

  const deliveryRate = stats && stats.total > 0 ? Math.round((stats.delivered / stats.total) * 100) : null;

  return (
    <div className="webhook-manager">
      <div className="webhook-header">
        <h3>Webhook Integrations</h3>
        <button className="webhook-refresh-btn" onClick={loadAll} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="webhook-error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="webhook-notice">{notice}</div>}

      {freshSecret && (
        <div className="webhook-secret-banner" role="alert">
          <strong>New HMAC secret for webhook #{freshSecret.webhookId} (shown once):</strong>
          <code>{freshSecret.secret}</code>
          <p>
            Signatures arrive in the <code>X-Webhook-Signature</code> header as{" "}
            <code>sha256=&lt;hex&gt;</code> over the raw request body. Verify with HMAC-SHA256 and
            your stored secret.
          </p>
          <button onClick={() => setFreshSecret(null)}>Dismiss</button>
        </div>
      )}

      {stats && (
        <div className="webhook-stats" aria-label="Delivery status dashboard">
          <div className="webhook-stat">
            <span className="webhook-stat-value">{stats.total}</span>
            <span className="webhook-stat-label">Total deliveries</span>
          </div>
          <div className="webhook-stat">
            <span className="webhook-stat-value">{stats.delivered}</span>
            <span className="webhook-stat-label">Delivered</span>
          </div>
          <div className="webhook-stat">
            <span className="webhook-stat-value">{stats.failed}</span>
            <span className="webhook-stat-label">Failed (retrying)</span>
          </div>
          <div className="webhook-stat">
            <span className="webhook-stat-value">{stats.exhausted}</span>
            <span className="webhook-stat-label">Exhausted</span>
          </div>
          <div className="webhook-stat">
            <span className="webhook-stat-value">{deliveryRate == null ? "-" : `${deliveryRate}%`}</span>
            <span className="webhook-stat-label">Delivery rate</span>
          </div>
        </div>
      )}

      <form className="webhook-register-form" onSubmit={handleRegister}>
        <h4>Register a webhook</h4>
        <div className="webhook-form-row">
          <input
            type="url"
            required
            placeholder="https://example.com/hook"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            aria-label="Webhook URL"
          />
          <button type="submit" disabled={registering || !newUrl.trim()}>
            {registering ? "Registering..." : "Register"}
          </button>
        </div>
        {supportedEvents.length > 0 && (
          <fieldset className="webhook-events-fieldset">
            <legend>Subscribed events (none selected = all events)</legend>
            <div className="webhook-events-grid">
              {supportedEvents.map((event) => (
                <label key={event} className="webhook-event-checkbox">
                  <input
                    type="checkbox"
                    checked={newEvents.includes(event)}
                    onChange={() => toggleNewEvent(event)}
                  />
                  <code>{event}</code>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </form>

      <div className="webhook-list-section">
        <h4>Registered webhooks ({webhooks.length})</h4>
        {webhooks.length === 0 ? (
          <div className="webhook-empty">No webhooks registered for this contract yet.</div>
        ) : (
          <div className="webhook-list">
            {webhooks.map((webhook) => (
              <div key={webhook.id} className="webhook-item">
                <div className="webhook-item-header">
                  <span className="webhook-id">#{webhook.id}</span>
                  <span className="webhook-url" title={webhook.url}>
                    {webhook.url}
                  </span>
                </div>
                <div className="webhook-item-meta">
                  <span title="Subscribed events">{webhook.events.length} event(s)</span>
                  <span title="HMAC secret configured">{webhook.hasSecret ? "HMAC signed" : "Unsigned"}</span>
                  {webhook.retryCount > 0 && (
                    <span className="webhook-retry-note">
                      {webhook.retryCount} retr{webhook.retryCount === 1 ? "y" : "ies"} pending
                      {webhook.nextRetryTime ? `, next ${formatDate(webhook.nextRetryTime)}` : ""}
                    </span>
                  )}
                </div>
                <div className="webhook-item-events">
                  {webhook.events.map((event) => (
                    <code key={event} className="webhook-event-tag">
                      {event}
                    </code>
                  ))}
                </div>
                <div className="webhook-item-actions">
                  <button onClick={() => handleTest(webhook)} disabled={testingId === webhook.id}>
                    {testingId === webhook.id ? "Testing..." : "Send test ping"}
                  </button>
                  <button onClick={() => handleRotateSecret(webhook)} disabled={actionId === webhook.id}>
                    Rotate secret
                  </button>
                  <button
                    className="webhook-danger-btn"
                    onClick={() => handleDeregister(webhook)}
                    disabled={actionId === webhook.id}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="webhook-history-section">
        <h4>Delivery history ({deliveriesTotal})</h4>
        <div className="webhook-history-filters">
          <label>
            Event
            <select value={eventFilter} onChange={(e) => setEventFilter(e.target.value)}>
              <option value="all">All events</option>
              {supportedEvents.map((event) => (
                <option key={event} value={event}>
                  {event}
                </option>
              ))}
              <option value="webhook.test">webhook.test</option>
            </select>
          </label>
          <label>
            Status
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as (typeof STATUS_FILTERS)[number])}
            >
              {STATUS_FILTERS.map((status) => (
                <option key={status} value={status}>
                  {status === "all" ? "All statuses" : status}
                </option>
              ))}
            </select>
          </label>
        </div>
        {deliveries.length === 0 ? (
          <div className="webhook-empty">No deliveries recorded yet.</div>
        ) : (
          <div className="webhook-delivery-table-wrapper">
            <table className="webhook-delivery-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Webhook</th>
                  <th>Status</th>
                  <th>HTTP</th>
                  <th>Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td title={delivery.createdAt}>{formatDate(delivery.createdAt)}</td>
                    <td>
                      <code>{delivery.event}</code>
                    </td>
                    <td title={delivery.url}>
                      {delivery.webhookId != null ? `#${delivery.webhookId}` : "-"}
                    </td>
                    <td>
                      <span className={statusBadgeClass(delivery.status)}>{delivery.status}</span>
                    </td>
                    <td>{delivery.httpStatus ?? "-"}</td>
                    <td>{delivery.durationMs != null ? `${delivery.durationMs} ms` : "-"}</td>
                    <td className="webhook-error-cell" title={delivery.error ?? ""}>
                      {delivery.error ? delivery.error.slice(0, 80) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
