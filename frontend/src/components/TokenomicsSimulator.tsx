import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { escapeCSV, downloadCSV } from "../utils/export";
import { exportElementToPDF } from "../utils/dashboardExport";
import "./TokenomicsSimulator.css";

/* ------------------------------------------------------------------ */
/* Types & pure helpers (exported for unit testing)                    */
/* ------------------------------------------------------------------ */

export interface AllocationInput {
  name: string;
  amount: number;
  tgePercent: number;
  cliffMonths: number;
  vestingMonths: number;
}

export interface SupplyPoint {
  date: string;
  totalSupply: number;
  circulatingSupply: number;
  lockedSupply: number;
  circulatingPercent: number;
}

export interface UnlockEvent {
  date: string;
  month: number;
  unlockedAmount: number;
  circulatingSupply: number;
  circulatingPercent: number;
}

export interface VestingScheduleInput {
  label: string;
  beneficiary: string;
  totalAmount: number;
  releasedAmount: number;
  startDate: string;
  cliffMonths: number;
  vestingMonths: number;
}

export const DEFAULT_ALLOCATIONS: AllocationInput[] = [
  { name: "Team", amount: 200_000_000, tgePercent: 0, cliffMonths: 12, vestingMonths: 36 },
  { name: "Investors", amount: 150_000_000, tgePercent: 10, cliffMonths: 6, vestingMonths: 24 },
  { name: "Community", amount: 400_000_000, tgePercent: 15, cliffMonths: 0, vestingMonths: 48 },
  { name: "Treasury", amount: 250_000_000, tgePercent: 5, cliffMonths: 3, vestingMonths: 36 },
];

export function sumAllocations(allocations: AllocationInput[]): number {
  return allocations.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
}

/** Returns an error message when the allocation set is invalid, else null. */
export function validateAllocations(
  allocations: AllocationInput[],
  totalSupply: number,
): string | null {
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) {
    return "Total supply must be a positive number";
  }
  if (allocations.length === 0) {
    return "Add at least one allocation";
  }
  if (sumAllocations(allocations) > totalSupply + 1) {
    return `Allocations exceed total supply by ${formatTokenAmount(
      sumAllocations(allocations) - totalSupply,
    )}`;
  }
  return null;
}

/**
 * Build a scenario by shifting every allocation's TGE unlock / cliff /
 * duration by the given deltas.
 */
export function buildScenarioAllocations(
  allocations: AllocationInput[],
  deltas: { tgeDelta: number; cliffDelta: number; vestingDelta: number },
): AllocationInput[] {
  return allocations.map((a) => ({
    ...a,
    tgePercent: Math.min(100, Math.max(0, a.tgePercent + deltas.tgeDelta)),
    cliffMonths: Math.max(0, a.cliffMonths + deltas.cliffDelta),
    vestingMonths: Math.max(0, a.vestingMonths + deltas.vestingDelta),
  }));
}

export function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function buildSupplyCsv(points: SupplyPoint[]): string {
  const header =
    "Date,Total Supply,Circulating Supply,Locked Supply,Circulating %";
  const rows = points.map((p) =>
    [
      escapeCSV(p.date),
      escapeCSV(p.totalSupply),
      escapeCSV(p.circulatingSupply),
      escapeCSV(p.lockedSupply),
      escapeCSV(p.circulatingPercent),
    ].join(","),
  );
  return [header, ...rows].join("\r\n");
}

export function buildUnlockEventsCsv(events: UnlockEvent[]): string {
  const header = "Date,Unlocked Amount,Circulating Supply,Circulating %";
  const rows = events.map((e) =>
    [
      escapeCSV(e.date),
      escapeCSV(e.unlockedAmount),
      escapeCSV(e.circulatingSupply),
      escapeCSV(e.circulatingPercent),
    ].join(","),
  );
  return [header, ...rows].join("\r\n");
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

const PAGE_STEP = 30;

export const TokenomicsSimulator: React.FC = () => {
  const [totalSupply, setTotalSupply] = useState(1_000_000_000);
  const [tgeDate, setTgeDate] = useState("2025-01-01");
  const [horizonMonths, setHorizonMonths] = useState(36);
  const [allocations, setAllocations] = useState<AllocationInput[]>(DEFAULT_ALLOCATIONS);

  const [model, setModel] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [scenario, setScenario] = useState({
    tgeDelta: 0,
    cliffDelta: 0,
    vestingDelta: 0,
  });
  const [simulation, setSimulation] = useState<any>(null);

  const [schedule, setSchedule] = useState<VestingScheduleInput>({
    label: "Team",
    beneficiary: "GABC...",
    totalAmount: 200_000_000,
    releasedAmount: 0,
    startDate: "2025-01-01",
    cliffMonths: 12,
    vestingMonths: 36,
  });
  const [vesting, setVesting] = useState<any>(null);
  const [vestingError, setVestingError] = useState<string | null>(null);

  const reportRef = useRef<HTMLDivElement>(null);

  const config = useMemo(
    () => ({
      tokenSymbol: "SRS",
      totalSupply,
      tgeDate: new Date(`${tgeDate}T00:00:00.000Z`).toISOString(),
      allocations,
    }),
    [totalSupply, tgeDate, allocations],
  );

  const validationError = validateAllocations(allocations, totalSupply);

  const loadModel = useCallback(async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.getTokenEconomicsModel(config, { horizonMonths });
      setModel(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load token economics");
    } finally {
      setLoading(false);
    }
  }, [config, horizonMonths, validationError]);

  useEffect(() => {
    loadModel();
  }, [loadModel]);

  const updateAllocation = (index: number, patch: Partial<AllocationInput>) => {
    setAllocations((prev) =>
      prev.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    );
  };

  const addAllocation = () => {
    setAllocations((prev) => [
      ...prev,
      { name: `Allocation ${prev.length + 1}`, amount: 0, tgePercent: 0, cliffMonths: 0, vestingMonths: 12 },
    ]);
  };

  const removeAllocation = (index: number) => {
    setAllocations((prev) => prev.filter((_, i) => i !== index));
  };

  const runSimulation = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const scenarioAllocations = buildScenarioAllocations(allocations, scenario);
      const res = await api.simulateTokenDistribution(
        config,
        { allocations: scenarioAllocations },
        { horizonMonths },
      );
      setSimulation(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setLoading(false);
    }
  };

  const loadVesting = async () => {
    setVestingError(null);
    try {
      const res = await api.getVestingAnalytics([schedule], { horizonMonths });
      setVesting(res.data);
    } catch (err) {
      setVestingError(err instanceof Error ? err.message : "Failed to load vesting analytics");
    }
  };

  const exportSupplyCsv = () => {
    if (!model) return;
    const csv = buildSupplyCsv(model.projection.points);
    downloadCSV(csv, `tokenomics-supply-${new Date().toISOString().split("T")[0]}.csv`);
  };

  const exportUnlocksCsv = () => {
    if (!model) return;
    const csv = buildUnlockEventsCsv(model.unlockEvents);
    downloadCSV(csv, `tokenomics-unlocks-${new Date().toISOString().split("T")[0]}.csv`);
  };

  const exportPdf = async () => {
    if (!reportRef.current) return;
    setExporting(true);
    try {
      const date = new Date().toISOString().split("T")[0];
      await exportElementToPDF(reportRef.current, `tokenomics-report-${date}.pdf`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF export failed");
    } finally {
      setExporting(false);
    }
  };

  const projectedAvailable = useMemo(() => {
    if (!model?.projection?.points) return [];
    return model.projection.points.filter(
      (_: SupplyPoint, i: number) => i % 3 === 0 || i === model.projection.points.length - 1,
    );
  }, [model]);

  return (
    <div className="tokenomics-simulator" data-testid="tokenomics-simulator">
      <div className="tokenomics-header">
        <div>
          <h1>Token Economics &amp; Vesting Analytics</h1>
          <p className="tokenomics-subtitle">
            Model supply, dilution and vesting, then simulate alternative
            distribution strategies.
          </p>
        </div>
        <div className="tokenomics-actions">
          <button type="button" onClick={loadModel} disabled={loading}>
            🔄 Recalculate
          </button>
          <button type="button" onClick={exportSupplyCsv} disabled={!model}>
            ⬇️ Supply CSV
          </button>
          <button type="button" onClick={exportUnlocksCsv} disabled={!model}>
            ⬇️ Unlocks CSV
          </button>
          <button type="button" onClick={exportPdf} disabled={!model || exporting}>
            {exporting ? "Exporting…" : "🖨️ PDF"}
          </button>
        </div>
      </div>

      {error && (
        <div className="tokenomics-error" role="alert">
          {error}
        </div>
      )}

      <div className="tokenomics-config">
        <label>
          Total Supply
          <input
            type="number"
            min={1}
            value={totalSupply}
            onChange={(e) => setTotalSupply(Number(e.target.value))}
          />
        </label>
        <label>
          TGE Date
          <input type="date" value={tgeDate} onChange={(e) => setTgeDate(e.target.value)} />
        </label>
        <label>
          Horizon (months)
          <input
            type="number"
            min={1}
            max={120}
            value={horizonMonths}
            onChange={(e) => setHorizonMonths(Number(e.target.value))}
          />
        </label>
      </div>

      <div ref={reportRef} className="tokenomics-report">
        {validationError && (
          <div className="tokenomics-error" role="alert">
            {validationError}
          </div>
        )}

        {model && (
          <>
            <section className="tokenomics-stats">
              <div className="stat-card">
                <span className="stat-label">Total Supply</span>
                <span className="stat-value">{formatTokenAmount(model.totalSupply)}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Circulating</span>
                <span className="stat-value">
                  {formatTokenAmount(model.current.circulatingSupply)}
                </span>
                <span className="stat-unit">{model.current.circulatingPercent}%</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Locked</span>
                <span className="stat-value">
                  {formatTokenAmount(model.current.lockedSupply)}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">
                  Dilution ({model.dilution.horizonMonths}m)
                </span>
                <span className="stat-value">{model.dilution.dilutionPercent}%</span>
                <span className="stat-unit">
                  {formatTokenAmount(model.dilution.newlyUnlocked)} unlocking
                </span>
              </div>
            </section>

            <section className="tokenomics-section">
              <h2>Allocations</h2>
              <table className="tokenomics-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Amount</th>
                    <th>TGE %</th>
                    <th>Cliff (mo)</th>
                    <th>Vesting (mo)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((a, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          value={a.name}
                          onChange={(e) => updateAllocation(i, { name: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          value={a.amount}
                          onChange={(e) =>
                            updateAllocation(i, { amount: Number(e.target.value) })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={a.tgePercent}
                          onChange={(e) =>
                            updateAllocation(i, { tgePercent: Number(e.target.value) })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          value={a.cliffMonths}
                          onChange={(e) =>
                            updateAllocation(i, { cliffMonths: Number(e.target.value) })
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          value={a.vestingMonths}
                          onChange={(e) =>
                            updateAllocation(i, { vestingMonths: Number(e.target.value) })
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          aria-label={`Remove ${a.name}`}
                          onClick={() => removeAllocation(i)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="tokenomics-inline">
                <button type="button" onClick={addAllocation}>
                  + Add allocation
                </button>
                <span>
                  Allocated: {formatTokenAmount(sumAllocations(allocations))} /{" "}
                  {formatTokenAmount(totalSupply)}
                </span>
              </div>
            </section>

            <section className="tokenomics-section">
              <h2>Supply Projection</h2>
              <table className="tokenomics-table" data-testid="supply-projection">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Circulating</th>
                    <th>Locked</th>
                    <th>Circulating %</th>
                  </tr>
                </thead>
                <tbody>
                  {projectedAvailable.map((p: SupplyPoint) => (
                    <tr key={p.date}>
                      <td>{p.date.split("T")[0]}</td>
                      <td>{formatTokenAmount(p.circulatingSupply)}</td>
                      <td>{formatTokenAmount(p.lockedSupply)}</td>
                      <td>{p.circulatingPercent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {model.unlockEvents.length > 0 && (
              <section className="tokenomics-section">
                <h2>Unlock Events</h2>
                <table className="tokenomics-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Unlocked</th>
                      <th>Circulating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.unlockEvents.slice(0, 12).map((e: UnlockEvent) => (
                      <tr key={e.date}>
                        <td>{e.date.split("T")[0]}</td>
                        <td>{formatTokenAmount(e.unlockedAmount)}</td>
                        <td>{formatTokenAmount(e.circulatingSupply)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <section className="tokenomics-section">
              <h2>Strategy Simulation</h2>
              <div className="tokenomics-config">
                <label>
                  TGE % shift
                  <input
                    type="number"
                    min={-100}
                    max={100}
                    value={scenario.tgeDelta}
                    onChange={(e) =>
                      setScenario((s) => ({ ...s, tgeDelta: Number(e.target.value) }))
                    }
                  />
                </label>
                <label>
                  Cliff shift (mo)
                  <input
                    type="number"
                    value={scenario.cliffDelta}
                    onChange={(e) =>
                      setScenario((s) => ({ ...s, cliffDelta: Number(e.target.value) }))
                    }
                  />
                </label>
                <label>
                  Vesting shift (mo)
                  <input
                    type="number"
                    value={scenario.vestingDelta}
                    onChange={(e) =>
                      setScenario((s) => ({ ...s, vestingDelta: Number(e.target.value) }))
                    }
                  />
                </label>
                <button type="button" onClick={runSimulation}>
                  ▶️ Simulate
                </button>
              </div>

              {simulation && (
                <div className="simulation-results" data-testid="simulation-results">
                  <div className="stat-card">
                    <span className="stat-label">Base dilution</span>
                    <span className="stat-value">
                      {simulation.base.dilution.dilutionPercent}%
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Scenario dilution</span>
                    <span className="stat-value">
                      {simulation.scenario.dilution.dilutionPercent}%
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Dilution delta</span>
                    <span className="stat-value">
                      {simulation.comparison.dilutionDelta > 0 ? "+" : ""}
                      {simulation.comparison.dilutionDelta}%
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Unlock delta</span>
                    <span className="stat-value">
                      {formatTokenAmount(simulation.comparison.unlockDelta)}
                    </span>
                  </div>
                </div>
              )}
            </section>

            <section className="tokenomics-section">
              <h2>Vesting Analytics</h2>
              <div className="tokenomics-config">
                <label>
                  Label
                  <input
                    value={schedule.label}
                    onChange={(e) => setSchedule((s) => ({ ...s, label: e.target.value }))}
                  />
                </label>
                <label>
                  Beneficiary
                  <input
                    value={schedule.beneficiary}
                    onChange={(e) =>
                      setSchedule((s) => ({ ...s, beneficiary: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Total amount
                  <input
                    type="number"
                    min={1}
                    value={schedule.totalAmount}
                    onChange={(e) =>
                      setSchedule((s) => ({ ...s, totalAmount: Number(e.target.value) }))
                    }
                  />
                </label>
                <label>
                  Start date
                  <input
                    type="date"
                    value={schedule.startDate}
                    onChange={(e) =>
                      setSchedule((s) => ({ ...s, startDate: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Cliff (mo)
                  <input
                    type="number"
                    min={0}
                    value={schedule.cliffMonths}
                    onChange={(e) =>
                      setSchedule((s) => ({ ...s, cliffMonths: Number(e.target.value) }))
                    }
                  />
                </label>
                <label>
                  Vesting (mo)
                  <input
                    type="number"
                    min={0}
                    value={schedule.vestingMonths}
                    onChange={(e) =>
                      setSchedule((s) => ({ ...s, vestingMonths: Number(e.target.value) }))
                    }
                  />
                </label>
                <button type="button" onClick={loadVesting}>
                  📊 Analyse vesting
                </button>
              </div>

              {vestingError && (
                <div className="tokenomics-error" role="alert">
                  {vestingError}
                </div>
              )}

              {vesting && (
                <div className="vesting-results" data-testid="vesting-results">
                  <div className="tokenomics-stats">
                    <div className="stat-card">
                      <span className="stat-label">Total</span>
                      <span className="stat-value">
                        {formatTokenAmount(vesting.totalAmount)}
                      </span>
                    </div>
                    <div className="stat-card">
                      <span className="stat-label">Vested</span>
                      <span className="stat-value">
                        {formatTokenAmount(vesting.totalVested)}
                      </span>
                    </div>
                    <div className="stat-card">
                      <span className="stat-label">Available</span>
                      <span className="stat-value">
                        {formatTokenAmount(vesting.totalAvailable)}
                      </span>
                    </div>
                    <div className="stat-card">
                      <span className="stat-label">Vested %</span>
                      <span className="stat-value">{vesting.vestedPercent}%</span>
                    </div>
                  </div>

                  {vesting.unlockEvents.length > 0 && (
                    <table className="tokenomics-table">
                      <thead>
                        <tr>
                          <th>Unlock date</th>
                          <th>Amount</th>
                          <th>Cumulative %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vesting.unlockEvents.slice(0, 12).map((e: any) => (
                          <tr key={e.date}>
                            <td>{e.date.split("T")[0]}</td>
                            <td>{formatTokenAmount(e.unlockedAmount)}</td>
                            <td>{e.vestedPercent}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <p className="tokenomics-disclaimer">
        Projections are mathematical models for planning only and are not
        financial advice.
      </p>
    </div>
  );
};

export default TokenomicsSimulator;

// Kept for callers that want a fixed sampling step in months.
export const SUPPLY_SAMPLE_STEP_DAYS = PAGE_STEP;
