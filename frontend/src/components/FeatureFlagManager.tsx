/**
 * FeatureFlagManager (#1075)
 *
 * Admin UI for the advanced feature flags system:
 *   - create and modify flags (enable/disable without a redeploy)
 *   - set targeting rules (user / org / role)
 *   - drive a gradual rollout and monitor error/latency metrics
 *   - roll a flag back instantly
 *   - inspect the flag's change history
 */

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type FeatureFlag,
  type FeatureFlagHealth,
  type FeatureFlagHistoryEntry,
} from "../api";
import "./FeatureFlagManager.css";

type RuleType = "user" | "org" | "role";

export function FeatureFlagManager() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [ruleType, setRuleType] = useState<RuleType>("user");
  const [ruleValue, setRuleValue] = useState("");
  const [health, setHealth] = useState<FeatureFlagHealth | null>(null);
  const [history, setHistory] = useState<FeatureFlagHistoryEntry[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { flags: fetched } = await api.listFeatureFlags();
      setFlags(fetched);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load feature flags");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, message: string) {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      await action();
      setStatus(message);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) {
      setError("Flag name is required");
      return;
    }
    await run(async () => {
      await api.createFeatureFlag({
        name: newName.trim(),
        description: newDescription.trim() || null,
      });
      setNewName("");
      setNewDescription("");
    }, "Feature flag created");
  }

  async function openDetails(name: string) {
    setExpanded(name);
    setHealth(null);
    setHistory([]);
    try {
      const [healthData, historyData] = await Promise.all([
        api.getFeatureFlagMetrics(name),
        api.getFeatureFlagHistory(name),
      ]);
      setHealth(healthData);
      setHistory(historyData.history);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load flag details");
    }
  }

  async function handleAddRule(name: string) {
    if (!ruleValue.trim()) {
      setError("Rule value is required");
      return;
    }
    await run(
      () => api.addFeatureFlagRule(name, { ruleType, value: ruleValue.trim(), enabled: true }),
      "Targeting rule added",
    );
    setRuleValue("");
  }

  return (
    <section className="feature-flag-manager" aria-label="Feature flag manager">
      <header className="ffm-header">
        <h2>Feature Flags</h2>
        <p className="ffm-subtitle">
          Toggle features at runtime, target specific users or orgs, and roll out gradually.
        </p>
      </header>

      {error && (
        <p className="ffm-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="ffm-status" role="status">
          {status}
        </p>
      )}

      <form className="ffm-create" onSubmit={handleCreate} aria-label="Create feature flag">
        <h3>Create a flag</h3>
        <div className="ffm-create-row">
          <label htmlFor="ffm-name">Name</label>
          <input
            id="ffm-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="checkout-v2"
          />
        </div>
        <div className="ffm-create-row">
          <label htmlFor="ffm-description">Description</label>
          <input
            id="ffm-description"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="Optional description"
          />
        </div>
        <button className="btn-primary" type="submit" disabled={loading}>
          Create flag
        </button>
      </form>

      <div className="ffm-list" aria-label="Feature flags">
        {flags.length === 0 && !loading && <p>No feature flags yet.</p>}
        {flags.map((flag) => {
          const isExpanded = expanded === flag.name;
          return (
            <article className="ffm-card" key={flag.name}>
              <div className="ffm-card-head">
                <div>
                  <h3>
                    {flag.name}
                    {flag.killed && <span className="ffm-badge ffm-badge-killed">KILLED</span>}
                    {!flag.killed && flag.enabled && (
                      <span className="ffm-badge ffm-badge-on">ON</span>
                    )}
                    {!flag.killed && !flag.enabled && (
                      <span className="ffm-badge ffm-badge-off">OFF</span>
                    )}
                  </h3>
                  {flag.description && <p className="ffm-desc">{flag.description}</p>}
                  <p className="ffm-rollout-label">
                    Rollout: {flag.rolloutPercentage}% &middot; {flag.rules?.length ?? 0} rule(s)
                  </p>
                </div>
                <div className="ffm-actions">
                  <button
                    type="button"
                    onClick={() =>
                      run(
                        () => api.updateFeatureFlag(flag.name, { enabled: !flag.enabled }),
                        `Flag ${flag.enabled ? "disabled" : "enabled"}`,
                      )
                    }
                    disabled={loading}
                    aria-label={`Toggle ${flag.name}`}
                  >
                    {flag.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    className="ffm-danger"
                    onClick={() =>
                      run(() => api.rollbackFeatureFlag(flag.name, "Manual rollback"), "Flag rolled back")
                    }
                    disabled={loading}
                    aria-label={`Rollback ${flag.name}`}
                  >
                    Rollback
                  </button>
                  <button
                    type="button"
                    onClick={() => (isExpanded ? setExpanded(null) : openDetails(flag.name))}
                    aria-label={`Details for ${flag.name}`}
                  >
                    {isExpanded ? "Hide" : "Details"}
                  </button>
                </div>
              </div>

              <div className="ffm-rollout">
                <label htmlFor={`ffm-rollout-${flag.name}`}>
                  Rollout percentage for {flag.name}
                </label>
                <input
                  id={`ffm-rollout-${flag.name}`}
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={flag.rolloutPercentage}
                  onBlur={(e) => {
                    const next = Number(e.target.value);
                    if (Number.isFinite(next) && next !== flag.rolloutPercentage) {
                      void run(
                        () => api.setFeatureFlagRollout(flag.name, next),
                        `Rollout set to ${next}%`,
                      );
                    }
                  }}
                />
              </div>

              {isExpanded && (
                <div className="ffm-details">
                  <div className="ffm-rules">
                    <h4>Targeting rules</h4>
                    <ul>
                      {(flag.rules ?? []).map((rule) => (
                        <li key={rule.id}>
                          <span>
                            {rule.ruleType}: {rule.value} ({rule.enabled ? "on" : "off"})
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              run(
                                () => api.removeFeatureFlagRule(flag.name, rule.id),
                                "Rule removed",
                              )
                            }
                            disabled={loading}
                            aria-label={`Remove rule ${rule.value}`}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                      {(flag.rules ?? []).length === 0 && <li>No rules configured.</li>}
                    </ul>
                    <div className="ffm-rule-form">
                      <label htmlFor={`ffm-rule-type-${flag.name}`}>Rule type</label>
                      <select
                        id={`ffm-rule-type-${flag.name}`}
                        value={ruleType}
                        onChange={(e) => setRuleType(e.target.value as RuleType)}
                      >
                        <option value="user">User</option>
                        <option value="org">Org</option>
                        <option value="role">Role</option>
                      </select>
                      <input
                        aria-label={`Rule value for ${flag.name}`}
                        value={ruleValue}
                        onChange={(e) => setRuleValue(e.target.value)}
                        placeholder="Wallet, org id, or role"
                      />
                      <button type="button" onClick={() => handleAddRule(flag.name)} disabled={loading}>
                        Add rule
                      </button>
                    </div>
                  </div>

                  {health && (
                    <div className="ffm-health" aria-label={`Metrics for ${flag.name}`}>
                      <h4>Rollout health</h4>
                      <p>
                        {health.healthy ? "Healthy" : `Unhealthy: ${health.reasons.join("; ")}`}
                      </p>
                      <ul>
                        <li>Requests: {health.metrics.requests}</li>
                        <li>Errors: {health.metrics.errors}</li>
                        <li>Error rate: {(health.metrics.errorRate * 100).toFixed(2)}%</li>
                        <li>p95 latency: {health.metrics.p95LatencyMs ?? "n/a"} ms</li>
                      </ul>
                      <button
                        type="button"
                        onClick={() =>
                          run(
                            () => api.monitorFeatureFlag(flag.name),
                            "Rollout monitored",
                          )
                        }
                        disabled={loading}
                      >
                        Monitor now
                      </button>
                    </div>
                  )}

                  {history.length > 0 && (
                    <div className="ffm-history">
                      <h4>History</h4>
                      <ul>
                        {history.slice(0, 10).map((entry) => (
                          <li key={entry.id}>
                            {entry.action} by {entry.changedBy || "system"} —{" "}
                            {new Date(entry.timestamp).toLocaleString()}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default FeatureFlagManager;
