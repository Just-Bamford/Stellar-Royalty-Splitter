import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";

type Change = { path: string; value: string | number | boolean };

export function CollaborationConsole({ contractId }: { contractId: string }) {
  const [document, setDocument] = useState<any>(null);
  const [field, setField] = useState("royaltyRate");
  const [value, setValue] = useState(500);
  const [actor, setActor] = useState("admin");
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [audit, setAudit] = useState<any>(null);
  const [status, setStatus] = useState("Loading collaboration state…");

  const load = useCallback(async () => {
    try {
      const [collaboration, oracle] = await Promise.all([
        api.getCollaboration(contractId),
        api.getOracleRecommendations(),
      ]);
      setDocument(collaboration.data);
      setRecommendations(oracle.data ?? []);
      setStatus("Connected");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to load console");
    }
  }, [contractId]);

  useEffect(() => {
    void load();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socket.onopen = () => socket.send(JSON.stringify({ type: "subscribe_collaboration", contractId }));
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "collaboration_update") setDocument(message.data);
      } catch { /* ignore malformed frames */ }
    };
    return () => socket.close();
  }, [contractId, load]);

  const currentValue = useMemo(() => document?.settings?.[field] ?? value, [document, field, value]);

  async function applyChange() {
    if (!document) return;
    try {
      const result = await api.applyCollaborationOperation(contractId, {
        actor,
        baseRevision: document.revision,
        operation: { type: "set", path: field, value: Number(value) || value },
      });
      setDocument(result.data);
      setStatus(result.data.change.rebased ? "Change rebased onto a newer revision" : "Change saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Change rejected");
    }
  }

  async function collectRecommendation() {
    const result = await api.collectOracleMarketData({ collectionId: contractId, floorPrice: 100, volume: 20, supply: 1000, source: "manual-dashboard" });
    setRecommendations((items) => [result.data, ...items.filter((item) => item.collectionId !== contractId)]);
  }

  async function verifyAudit() {
    try {
      setAudit((await api.getComplianceAudit(contractId)).data);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Audit verification failed");
    }
  }

  return (
    <div className="page-section" style={{ display: "grid", gap: 24 }}>
      <header><h1>Collaborative contract operations</h1><p>{status}</p><small>Revision {document?.revision ?? "—"} · Live WebSocket updates and deterministic rebasing</small></header>
      <section>
        <h2>Shared settings editor</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <input aria-label="actor" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Actor" />
          <input aria-label="field" value={field} onChange={(e) => setField(e.target.value)} />
          <input aria-label="value" value={currentValue} onChange={(e) => setValue(Number(e.target.value) || e.target.value as any)} />
          <button type="button" onClick={applyChange}>Apply change</button>
        </div>
      </section>
      <section>
        <h2>Oracle recommendations</h2>
        <button type="button" onClick={collectRecommendation}>Collect weekly market snapshot</button>
        <ul>{recommendations.map((item) => <li key={`${item.collectionId}-${item.createdAt}`}>{item.collectionId}: <strong>{item.recommendedRate} bps</strong> ({item.status})</li>)}</ul>
      </section>
      <section>
        <h2>Compliance audit</h2>
        <button type="button" onClick={verifyAudit}>Verify hash chain</button>
        {audit && <p role="status">{audit.valid ? `Integrity verified (${audit.entries} entries)` : "Integrity failure"}</p>}
      </section>
    </div>
  );
}
