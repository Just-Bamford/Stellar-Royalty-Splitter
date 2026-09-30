import { useEffect, useMemo, useState } from "react";

export type AutomationSchedule = {
  id: string | number;
  name: string;
  type: string;
  enabled: boolean;
  nextRunAt?: string | null;
  cron?: string | null;
  history?: Array<Record<string, unknown>>;
};

export type AutomationWorkflow = {
  id: string | number;
  name: string;
  enabled: boolean;
  trigger?: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
  executionHistory?: Array<Record<string, unknown>>;
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

export function AutomationDashboard() {
  const [schedules, setSchedules] = useState<AutomationSchedule[]>([]);
  const [workflows, setWorkflows] = useState<AutomationWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAutomation = async () => {
    try {
      setLoading(true);
      setError(null);
      const [scheduleResponse, workflowResponse] = await Promise.all([
        apiFetch<{ success: boolean; data: AutomationSchedule[] }>("/api/v1/automation/schedules"),
        apiFetch<{ success: boolean; data: AutomationWorkflow[] }>("/api/v1/automation/workflows"),
      ]);
      setSchedules(scheduleResponse.data ?? []);
      setWorkflows(workflowResponse.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load automation data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAutomation();
  }, []);

  const toggleSchedule = async (schedule: AutomationSchedule) => {
    try {
      const endpoint = schedule.enabled
        ? `/api/v1/automation/schedules/${schedule.id}/disable`
        : `/api/v1/automation/schedules/${schedule.id}/enable`;
      const response = await apiFetch<{ success: boolean; data: AutomationSchedule }>(endpoint, { method: "PATCH" });
      setSchedules((current) =>
        current.map((item) => (String(item.id) === String(schedule.id) ? response.data : item)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update schedule");
    }
  };

  const totalFailures = useMemo(
    () =>
      [...schedules, ...workflows].reduce((count, item) => {
        const history = (item as AutomationSchedule & AutomationWorkflow).history ?? (item as AutomationSchedule & AutomationWorkflow).executionHistory ?? [];
        return count + history.filter((entry) => (entry.status ?? entry.state) === "failed").length;
      }, 0),
    [schedules, workflows],
  );

  if (loading) {
    return (
      <section aria-live="polite" style={{ padding: 24 }}>
        <h2>Automation Dashboard</h2>
        <p>Loading schedules and workflows…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section style={{ padding: 24 }}>
        <h2>Automation Dashboard</h2>
        <p role="alert">{error}</p>
        <button type="button" onClick={() => void loadAutomation()}>Retry</button>
      </section>
    );
  }

  return (
    <section style={{ padding: 24, display: "grid", gap: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Automation Dashboard</h2>
        <span>{schedules.length + workflows.length} tracked items</span>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        <div style={{ border: "1px solid #d9d9d9", borderRadius: 8, padding: 16 }}>
          <div>Schedules</div>
          <strong>{schedules.length}</strong>
        </div>
        <div style={{ border: "1px solid #d9d9d9", borderRadius: 8, padding: 16 }}>
          <div>Workflows</div>
          <strong>{workflows.length}</strong>
        </div>
        <div style={{ border: "1px solid #d9d9d9", borderRadius: 8, padding: 16 }}>
          <div>Failed runs</div>
          <strong>{totalFailures}</strong>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <div style={{ border: "1px solid #d9d9d9", borderRadius: 8, padding: 16 }}>
          <h3>Schedules</h3>
          {schedules.length === 0 ? (
            <p>No schedules configured.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
              {schedules.map((schedule) => (
                <li key={String(schedule.id)} style={{ border: "1px solid #efefef", borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{schedule.name}</strong>
                    <button type="button" onClick={() => void toggleSchedule(schedule)}>
                      {schedule.enabled ? "Disable" : "Enable"}
                    </button>
                  </div>
                  <div>Type: {schedule.type}</div>
                  <div>Status: {schedule.enabled ? "enabled" : "disabled"}</div>
                  <div>Next run: {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "Not scheduled"}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={{ border: "1px solid #d9d9d9", borderRadius: 8, padding: 16 }}>
          <h3>Workflows</h3>
          {workflows.length === 0 ? (
            <p>No workflows configured.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
              {workflows.map((workflow) => (
                <li key={String(workflow.id)} style={{ border: "1px solid #efefef", borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{workflow.name}</strong>
                    <span>{workflow.enabled ? "enabled" : "disabled"}</span>
                  </div>
                  <div>Trigger: {String(workflow.trigger?.type ?? "custom")}</div>
                  <div>Actions: {Array.isArray(workflow.actions) ? workflow.actions.length : 0}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

export default AutomationDashboard;
