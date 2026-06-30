import { useState } from "react";
import { api } from "../api";
import "./Dashboard.css"; // Reuse dashboard styles for simplicity

export const TraceDashboard = () => {
  const [correlationId, setCorrelationId] = useState("");
  const [traces, setTraces] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTraces = async () => {
    if (!correlationId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api.getTraces(correlationId);
      if (response.success) {
        setTraces(response.traces);
        if (response.traces.length === 0) {
          setError("No traces found for this correlation ID.");
        }
      } else {
        setError("Failed to fetch traces.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to fetch traces.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Distributed Tracing Dashboard</h1>
        <p>Enter a Correlation ID to view request lifecycle spans (#481)</p>
      </div>

      <div className="search-bar" style={{ marginBottom: "20px", display: "flex", gap: "10px" }}>
        <input
          type="text"
          placeholder="Enter X-Correlation-ID..."
          value={correlationId}
          onChange={(e) => setCorrelationId(e.target.value)}
          style={{ flex: 1, padding: "8px" }}
        />
        <button onClick={fetchTraces} disabled={loading || !correlationId} className="btn-primary">
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {error && <div className="error-message" style={{ color: "red", marginBottom: "20px" }}>{error}</div>}

      <div className="traces-list">
        {traces.map((trace) => (
          <div key={trace.id} className="card" style={{ marginBottom: "15px", padding: "15px", border: "1px solid #ccc", borderRadius: "5px" }}>
            <h3>{trace.name}</h3>
            <p><strong>Trace ID:</strong> {trace.traceId}</p>
            <p><strong>Span ID:</strong> {trace.id}</p>
            <p><strong>Duration:</strong> {trace.endTime ? `${trace.endTime - trace.startTime}ms` : "Running..."}</p>
            <p><strong>Start Time:</strong> {new Date(trace.startTime).toISOString()}</p>
            <div>
              <strong>Attributes:</strong>
              <pre style={{ background: "#f5f5f5", padding: "10px", marginTop: "10px" }}>
                {JSON.stringify(trace.attributes, null, 2)}
              </pre>
            </div>
            {trace.events.length > 0 && (
              <div>
                <strong>Events:</strong>
                <pre style={{ background: "#f5f5f5", padding: "10px", marginTop: "10px" }}>
                  {JSON.stringify(trace.events, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
