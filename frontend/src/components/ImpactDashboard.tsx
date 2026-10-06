import { useCallback, useEffect, useState } from "react";
import {
  api,
  type CarbonFootprint,
  type CarbonOffsetRecord,
  type CarbonProject,
  type CarbonProjectFootprint,
  type CarbonSharePayload,
} from "../api";
import "./ImpactDashboard.css";

interface ImpactDashboardProps {
  contractId: string;
  walletAddress: string | null;
}

function formatKg(grams: number): string {
  return `${(grams / 1000).toFixed(3)} kg`;
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function EmissionsChart({ data }: { data: { date: string; grams: number }[] }) {
  const recent = data.slice(-14);
  if (recent.length === 0) {
    return <div className="impact-empty">No emissions recorded in this period.</div>;
  }
  const max = Math.max(...recent.map((d) => d.grams), 0.000001);
  return (
    <div className="impact-chart" role="img" aria-label="Emissions over time">
      {recent.map((d) => (
        <div key={d.date} className="impact-bar-group" title={`${d.date}: ${d.grams.toFixed(3)} g CO2`}>
          <div className="impact-bar" style={{ height: `${Math.max(4, (d.grams / max) * 100)}px` }} />
          <span className="impact-bar-label">{formatDate(d.date)}</span>
        </div>
      ))}
    </div>
  );
}

export function ImpactDashboard({ contractId, walletAddress }: ImpactDashboardProps) {
  const [footprint, setFootprint] = useState<CarbonFootprint | null>(null);
  const [project, setProject] = useState<CarbonProjectFootprint | null>(null);
  const [offsets, setOffsets] = useState<CarbonOffsetRecord[]>([]);
  const [projects, setProjects] = useState<CarbonProject[]>([]);
  const [share, setShare] = useState<CarbonSharePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [tonnes, setTonnes] = useState("0.01");
  const [projectId, setProjectId] = useState("mixed");
  const [purchasing, setPurchasing] = useState(false);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoPct, setAutoPct] = useState("1");
  const [savingSettings, setSavingSettings] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projectsRes, projectRes] = await Promise.all([
        api.getCarbonProjects(),
        api.getCarbonProject(contractId),
      ]);
      setProjects(projectsRes.data);
      setProject(projectRes.data);
      if (walletAddress) {
        const [footprintRes, offsetsRes, settingsRes, shareRes] = await Promise.all([
          api.getCarbonFootprint(walletAddress),
          api.getCarbonOffsets(walletAddress, 20, 0),
          api.getCarbonSettings(walletAddress),
          api.getCarbonShare(walletAddress),
        ]);
        setFootprint(footprintRes.data);
        setOffsets(offsetsRes.data);
        setAutoEnabled(settingsRes.data.autoOffsetEnabled);
        setAutoPct(String(settingsRes.data.offsetPercentage));
        setShare(shareRes.data);
      } else {
        setFootprint(null);
        setOffsets([]);
        setShare(null);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load impact data");
    } finally {
      setLoading(false);
    }
  }, [contractId, walletAddress]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function handlePurchase(e: React.FormEvent) {
    e.preventDefault();
    if (!walletAddress) return;
    const parsed = Number(tonnes);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a positive number of tonnes to offset.");
      return;
    }
    setPurchasing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.purchaseCarbonOffsets({
        walletAddress,
        contractId,
        tonnes: parsed,
        project: projectId,
      });
      setNotice(
        `Offset ${result.data.tonnes.toFixed(4)} tCO2e via ${result.data.project} (${result.data.status}).`,
      );
      setTonnes("0.01");
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to purchase offsets");
    } finally {
      setPurchasing(false);
    }
  }

  async function handleContribute(projectEntry: CarbonProject) {
    if (!walletAddress) return;
    setPurchasing(true);
    setError(null);
    setNotice(null);
    try {
      // Contribute a fixed 0.005 tCO2e (≈5 kg) to the chosen forest/ocean project.
      const result = await api.purchaseCarbonOffsets({
        walletAddress,
        contractId,
        tonnes: 0.005,
        project: projectEntry.id,
      });
      setNotice(`Contributed 0.005 tCO2e to ${projectEntry.name} (${result.data.status}).`);
      await loadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to contribute");
    } finally {
      setPurchasing(false);
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!walletAddress) return;
    const pct = Number(autoPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError("Offset percentage must be between 0 and 100.");
      return;
    }
    setSavingSettings(true);
    setError(null);
    try {
      await api.saveCarbonSettings(walletAddress, { autoOffsetEnabled: autoEnabled, offsetPercentage: pct });
      setNotice(
        autoEnabled
          ? `Auto-offset enabled: ${pct}% of future earnings will buy offsets.`
          : "Auto-offset disabled.",
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSavingSettings(false);
    }
  }

  function handleCopyLink() {
    if (!share) return;
    const text = `${share.text} ${share.shareUrls.x}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        },
        () => setError("Could not copy to clipboard."),
      );
    }
  }

  if (loading && !footprint && !project) {
    return (
      <div className="impact-dashboard">
        <div className="impact-loading">Loading environmental impact...</div>
      </div>
    );
  }

  const coverage = footprint ? Math.round(footprint.offsetCoveragePercent) : 0;

  return (
    <div className="impact-dashboard">
      <div className="impact-header">
        <h3>Environmental Impact</h3>
        <button className="impact-refresh-btn" onClick={loadAll} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="impact-error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="impact-notice">{notice}</div>}

      {walletAddress && footprint && (
        <section className="impact-section" aria-label="Personal carbon footprint">
          <h4>Your footprint</h4>
          <div className="impact-stats">
            <div className="impact-stat">
              <span className="impact-stat-value">{formatKg(footprint.totalGrams)}</span>
              <span className="impact-stat-label">Total CO2 ({footprint.txCount} txns)</span>
            </div>
            <div className="impact-stat">
              <span className="impact-stat-value">{footprint.offsetTonnes.toFixed(4)} t</span>
              <span className="impact-stat-label">Offset ({footprint.offsetPurchases} purchases)</span>
            </div>
            <div className="impact-stat">
              <span className="impact-stat-value">{formatKg(Math.max(0, footprint.netGrams))}</span>
              <span className="impact-stat-label">Net CO2</span>
            </div>
            <div className="impact-stat">
              <span className="impact-stat-value">{coverage}%</span>
              <span className="impact-stat-label">Offset coverage</span>
            </div>
          </div>
          <div className="impact-progress" aria-label={`${coverage}% offset`}>
            <div className="impact-progress-fill" style={{ width: `${Math.min(100, coverage)}%` }} />
          </div>
          <EmissionsChart data={footprint.byDay} />
        </section>
      )}

      {project && (
        <section className="impact-section" aria-label="Project-wide impact">
          <h4>Project-wide impact</h4>
          <div className="impact-stats">
            <div className="impact-stat">
              <span className="impact-stat-value">{formatKg(project.totalGrams)}</span>
              <span className="impact-stat-label">
                Total CO2 ({project.txCount} txns, {project.contributorCount} contributors)
              </span>
            </div>
            <div className="impact-stat">
              <span className="impact-stat-value">{project.offsetTonnes.toFixed(4)} t</span>
              <span className="impact-stat-label">
                Offset ({project.offsetPurchases} purchases, {project.offsetContributors} contributors)
              </span>
            </div>
          </div>
          <EmissionsChart data={project.byDay} />
        </section>
      )}

      {walletAddress && (
        <section className="impact-section" aria-label="Buy carbon offsets">
          <h4>Buy carbon offsets</h4>
          <form className="impact-form-row" onSubmit={handlePurchase}>
            <input
              type="number"
              min="0.0001"
              step="0.0001"
              value={tonnes}
              onChange={(e) => setTonnes(e.target.value)}
              aria-label="Tonnes of CO2e to offset"
            />
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Offset project">
              <option value="mixed">Mixed portfolio</option>
              <option value="forest">Forest (any)</option>
              <option value="ocean">Ocean (any)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={purchasing}>
              {purchasing ? "Purchasing..." : "Purchase"}
            </button>
          </form>

          <form className="impact-form-row" onSubmit={handleSaveSettings}>
            <label className="impact-checkbox">
              <input type="checkbox" checked={autoEnabled} onChange={(e) => setAutoEnabled(e.target.checked)} />
              Auto-offset
            </label>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={autoPct}
              onChange={(e) => setAutoPct(e.target.value)}
              aria-label="Percentage of earnings to auto-offset"
            />
            <span className="impact-pct-label">% of earnings</span>
            <button type="submit" disabled={savingSettings}>
              {savingSettings ? "Saving..." : "Save"}
            </button>
          </form>

          {offsets.length > 0 && (
            <div className="impact-delivery-table-wrapper">
              <table className="impact-delivery-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Tonnes</th>
                    <th>USD</th>
                    <th>Project</th>
                    <th>Status</th>
                    <th>Auto</th>
                  </tr>
                </thead>
                <tbody>
                  {offsets.map((o) => (
                    <tr key={o.id}>
                      <td>{new Date(o.createdAt).toLocaleDateString()}</td>
                      <td>{o.tonnes.toFixed(4)}</td>
                      <td>${(o.amountUsdCents / 100).toFixed(2)}</td>
                      <td>{o.project}</td>
                      <td>{o.status}</td>
                      <td>{o.autoPurchase ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="impact-section" aria-label="Support offset projects">
        <h4>Forest &amp; ocean projects</h4>
        <div className="impact-projects">
          {projects.map((p) => (
            <div key={p.id} className="impact-project-card">
              <div className="impact-project-icon">{p.type === "forest" ? "🌳" : "🌊"}</div>
              <strong>{p.name}</strong>
              <span className="impact-project-location">{p.location}</span>
              <p>{p.description}</p>
              <button onClick={() => handleContribute(p)} disabled={!walletAddress || purchasing}>
                Contribute 5 kg CO2e
              </button>
            </div>
          ))}
        </div>
      </section>

      {share && (
        <section className="impact-section" aria-label="Share your impact">
          <h4>Share your impact</h4>
          <p className="impact-share-text">{share.text}</p>
          <div className="impact-share-actions">
            <a href={share.shareUrls.x} target="_blank" rel="noopener noreferrer">
              Share on X
            </a>
            <a href={share.shareUrls.facebook} target="_blank" rel="noopener noreferrer">
              Share on Facebook
            </a>
            <a href={share.shareUrls.linkedin} target="_blank" rel="noopener noreferrer">
              Share on LinkedIn
            </a>
            <button onClick={handleCopyLink}>{copied ? "Copied!" : "Copy message"}</button>
          </div>
        </section>
      )}
    </div>
  );
}

export default ImpactDashboard;
