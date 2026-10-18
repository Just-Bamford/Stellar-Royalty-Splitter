import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ABTestingService,
  Experiment,
  ExperimentResult,
  ExperimentMetric,
  Variant,
} from '../services/ab-testing';


export interface ExperimentDashboardProps {
  service?: ABTestingService;
  initialExperiments?: Experiment[];
  onExperimentCreated?: (experiment: Experiment) => void;
  onWinnerLaunched?: (experiment: Experiment) => void;
}


interface NewExperimentForm {
  name: string;
  description: string;
  featureKey: string;
  controlName: string;
  treatmentName: string;
  controlWeight: number;
  conversionMetric: string;
}


const defaultForm: NewExperimentForm = {
  name: '',
  description: '',
  featureKey: '',
  controlName: 'Control',
  treatmentName: 'Treatment',
  controlWeight: 50,
  conversionMetric: 'conversion',
};


function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0.00%';
  return `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString();
}


export const ExperimentDashboard: React.FC<ExperimentDashboardProps> = ({
  service,
  initialExperiments,
  onExperimentCreated,
  onWinnerLaunched,
}) => {

  const abService = useMemo(() => service ?? new ABTestingService(), [service]);
  const [experiments, setExperiments] = useState<Experiment[]>(initialExperiments ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<NewExperimentForm>(defaultForm);
  const [result, setResult] = useState<ExperimentResult | null>(null);
  const [error, setError] = useState<string | null>(null);


  const refreshExperiments = useCallback(() => {
    setExperiments(abService.listExperiments());
  }, [abService]);


  useEffect(() => {
    refreshExperiments();
  }, [refreshExperiments]);


  useEffect(() => {
    if (!selectedId) {
      setResult(null);
      return;
    }
    try {
      setResult(abService.getResults(selectedId));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedId, abService]);


  const selectedExperiment = useMemo(
    () => experiments.find((e) => e.id === selectedId) ?? null,
    [experiments, selectedId],
  );


  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {

      const controlWeight = Math.max(0, Math.min(form.controlWeight, 100));
      const variants: Array<Omit<Variant, 'id'>> = [
        { name: form.controlName || 'Control', weight: controlWeight, isControl: true },
        { name: form.treatmentName || 'Treatment', weight: 100 - controlWeight, isControl: false },
      ];
      const metrics: ExperimentMetric[] = [
        { name: form.conversionMetric || 'conversion', type: 'conversion', goal: 'higher' },
      ];
      const experiment = abService.createExperiment({
        name: form.name,
        description: form.description,
        featureKey: form.featureKey,
        variants,
        metrics,
      });

      setExperiments(abService.listExperiments());
      setSelectedId(experiment.id);
      setForm(defaultForm);
      onExperimentCreated?.(experiment);
    } catch (err) {
      setError((err as Error).message);
    }
  };


  const handleLaunch = () => {
    if (!selectedId) return;
    setError(null);
    try {

      abService.launchExperiment(selectedId);
      setExperiments(abService.listExperiments());
      setResult(abService.getResults(selectedId));
    } catch (err) {
      setError((err as Error).message);
    }
  };


  const handleLaunchWinner = () => {
    if (!selectedId) return;
    setError(null);
    try {

      const exp = abService.launchWinner(selectedId);
      setExperiments(abService.listExperiments());
      setResult(abService.getResults(selectedId));
      onWinnerLaunched?.(exp);
    } catch (err) {
      setError((err as Error).message);
    }
  };


  return (
    <div className="experiment-dashboard">
      <header className="experiment-dashboard__header">
        <h1>A/B Testing Dashboard</h1>

        <p>Create experiments, configure traffic, monitor results, and launch winners.</p>
      </header>


      {error && (
        <div className="experiment-dashboard__error" role="alert">
          {error}
        </div>
      )}


      <section className="experiment-dashboard__create">
        <h2>Create Experiment</h2>
        <form onSubmit={handleCreate}>

          <label>
            Name
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>

          <label>
            Feature Key
            <input
              type="text"
              value={form.featureKey}
              onChange={(e) => setForm({ ...form, featureKey: e.target.value })}
              required
            />
          </label>

          <label>
            Description
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>

          <label>
            Control Name
            <input
              type="text"
              value={form.controlName}
              onChange={(e) => setForm({ ...form, controlName: e.target.value })}
            />
          </label>

          <label>
            Treatment Name
            <input
              type="text"
              value={form.treatmentName}
              onChange={(e) => setForm({ ...form, treatmentName: e.target.value })}
            />
          </label>

          <label>
            Control Traffic Weight (%)
            <input
              type="number"
              min={0}
              max={100}
              value={form.controlWeight}
              onChange={(e) => setForm({ ...form, controlWeight: Number(e.target.value) })}
            />
          </label>

          <label>
            Conversion Metric
            <input
              type="text"
              value={form.conversionMetric}
              onChange={(e) => setForm({ ...form, conversionMetric: e.target.value })}
            />
          </label>

          <button type="submit">Create Experiment</button>
        </form>
      </section>


      <section className="experiment-dashboard__list">
        <h2>Experiments</h2>
        {experiments.length === 0 ? (

          <p>No experiments yet.</p>
        ) : (
          <ul>
            {experiments.map((exp) => (
              <li key={exp.id}>

                <button
                  type="button"
                  onClick={() => setSelectedId(exp.id)}
                  aria-pressed={selectedId === exp.id}
                >
                  {exp.name} <span className="experiment-dashboard__status">{exp.status}</span>
                </button>
              </li>

            ))}
          </ul>
        )}
      </section>


      {selectedExperiment && (
        <section className="experiment-dashboard__detail">
          <h2>{selectedExperiment.name}</h2>

          <p>{selectedExperiment.description}</p>
          <div className="experiment-dashboard__actions">
            <button type="button" onClick={handleLaunch} disabled={selectedExperiment.status === 'running'}>
              Launch
            </button>

            <button type="button" onClick={handleLaunchWinner} disabled={!result?.winnerId}>
              Launch Winner to All Users
            </button>
          </div>


          {result && (
            <div className="experiment-dashboard__results">
              <p className="experiment-dashboard__recommendation">{result.recommendation}</p>

              <p>Total exposures: {formatNumber(result.totalExposures)}</p>
              <table>
                <thead>

                  <tr>
                    <th>Variant</th>
                    <th>Exposures</th>
                    <th>Conversions</th>
                    <th>Conversion Rate</th>
                    <th>Revenue</th>
                    <th>Avg. Engagement</th>
                    <th>Confidence</th>
                  </tr>
                </thead>

                <tbody>
                  {result.variantStats.map((stat) => {
                    const sig = result.significance.find((s) => s.treatmentVariantId === stat.variantId);
                    const confidence = sig ? formatPercent(sig.confidenceLevel) : '-';

                    return (
                      <tr key={stat.variantId}>
                        <td>{stat.variantId}</td>
                        <td>{formatNumber(stat.exposures)}</td>
                        <td>{formatNumber(stat.conversions)}</td>
                        <td>{formatPercent(stat.conversionRate)}</td>
                        <td>{formatNumber(stat.totalRevenue)}</td>
                        <td>{stat.avgEngagement.toFixed(2)}</td>
                        <td>{confidence}</td>
                      </tr>
                    );

                  })}
                </tbody>
              </table>
            </div>

          )}
        </section>
      )}

    </div>
  );
};


export default ExperimentDashboard;

