import React, { useState, useEffect } from "react";
import "./EarningsForecastCalculator.css";

interface EarningsForecastProps {
  contractId?: string;
  address?: string;
}

export const EarningsForecast: React.FC<EarningsForecastProps> = ({
  contractId,
  address,
}) => {
  const [frequency, setFrequency] = useState<"weekly" | "monthly" | "quarterly">("monthly");
  const [avgPayout, setAvgPayout] = useState<string>("100");
  const [secondaryVolume, setSecondaryVolume] = useState<string>("5000");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [forecast, setForecast] = useState<{
    monthlyBaseRate: number;
    projections: {
      month3: { base: number; bestCase: number; worstCase: number; confidenceBand: [number, number] };
      month6: { base: number; bestCase: number; worstCase: number; confidenceBand: [number, number] };
      month12: { base: number; bestCase: number; worstCase: number; confidenceBand: [number, number] };
    };
    monthlyTimeline: Array<{
      month: number;
      base: number;
      bestCase: number;
      worstCase: number;
      confidenceLower: number;
      confidenceUpper: number;
    }>;
  } | null>(null);

  const fetchForecast = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (contractId) params.append("contractId", contractId);
      if (address) params.append("address", address);
      params.append("frequency", frequency);
      if (avgPayout) params.append("avgPayout", avgPayout);
      if (secondaryVolume) params.append("secondaryVolume", secondaryVolume);

      const res = await fetch(`/api/v1/analytics/forecast?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch forecast");
      const json = await res.json();
      if (json.success && json.data) {
        setForecast(json.data);
      } else {
        throw new Error(json.message || "Invalid forecast response");
      }
    } catch (err: any) {
      // Client-side fallback calculation if network/mock API fails
      const basePayoutNum = parseFloat(avgPayout) || 100;
      const secVolNum = parseFloat(secondaryVolume) || 0;
      let freqMultiplier = 1;
      if (frequency === "weekly") freqMultiplier = 4.33;
      if (frequency === "quarterly") freqMultiplier = 1 / 3;

      const monthlyBase = basePayoutNum * freqMultiplier + secVolNum * 0.05;
      const timeline = [];
      let cumBase = 0;
      let cumBest = 0;
      let cumWorst = 0;

      for (let m = 1; m <= 12; m++) {
        cumBase += monthlyBase;
        cumBest += monthlyBase * 1.25;
        cumWorst += monthlyBase * 0.75;
        timeline.push({
          month: m,
          base: Math.round(cumBase),
          bestCase: Math.round(cumBest),
          worstCase: Math.round(cumWorst),
          confidenceLower: Math.round(cumBase * 0.9),
          confidenceUpper: Math.round(cumBase * 1.15),
        });
      }

      setForecast({
        monthlyBaseRate: Math.round(monthlyBase),
        projections: {
          month3: {
            base: Math.round(monthlyBase * 3),
            bestCase: Math.round(monthlyBase * 3 * 1.25),
            worstCase: Math.round(monthlyBase * 3 * 0.75),
            confidenceBand: [Math.round(monthlyBase * 3 * 0.9), Math.round(monthlyBase * 3 * 1.15)],
          },
          month6: {
            base: Math.round(monthlyBase * 6),
            bestCase: Math.round(monthlyBase * 6 * 1.25),
            worstCase: Math.round(monthlyBase * 6 * 0.75),
            confidenceBand: [Math.round(monthlyBase * 6 * 0.85), Math.round(monthlyBase * 6 * 1.2)],
          },
          month12: {
            base: Math.round(monthlyBase * 12),
            bestCase: Math.round(monthlyBase * 12 * 1.25),
            worstCase: Math.round(monthlyBase * 12 * 0.75),
            confidenceBand: [Math.round(monthlyBase * 12 * 0.8), Math.round(monthlyBase * 12 * 1.25)],
          },
        },
        monthlyTimeline: timeline,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchForecast();
  }, [frequency, avgPayout, secondaryVolume, contractId, address]);

  const maxVal = forecast?.monthlyTimeline
    ? Math.max(...forecast.monthlyTimeline.map((t) => t.bestCase), 100)
    : 1000;

  return (
    <div className="card earnings-forecast" data-testid="earnings-forecast">
      <div className="forecast-header">
        <h2>📈 Earnings Forecast Simulator</h2>
        <p>Project future royalty earnings based on payout patterns and volume.</p>
      </div>

      <div className="forecast-inputs-grid">
        <div className="input-group">
          <label htmlFor="frequency-select">Distribution Frequency</label>
          <select
            id="frequency-select"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as any)}
            data-testid="frequency-select"
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
        </div>

        <div className="input-group">
          <label htmlFor="avg-payout-input">Average Payout Amount ($)</label>
          <input
            id="avg-payout-input"
            type="number"
            value={avgPayout}
            onChange={(e) => setAvgPayout(e.target.value)}
            placeholder="100"
            data-testid="avg-payout-input"
          />
        </div>

        <div className="input-group">
          <label htmlFor="secondary-vol-input">Projected Secondary Volume ($)</label>
          <input
            id="secondary-vol-input"
            type="number"
            value={secondaryVolume}
            onChange={(e) => setSecondaryVolume(e.target.value)}
            placeholder="5000"
            data-testid="secondary-vol-input"
          />
        </div>
      </div>

      {loading && <div className="loading-state">Calculating forecast...</div>}

      {forecast && (
        <div className="forecast-results" data-testid="forecast-results">
          <div className="projections-summary-cards">
            <div className="projection-card">
              <h4>3 Months Projection</h4>
              <div className="base-val">${forecast.projections.month3.base.toLocaleString()}</div>
              <div className="scenario-row">
                <span className="best">Best: ${forecast.projections.month3.bestCase.toLocaleString()}</span>
                <span className="worst">Worst: ${forecast.projections.month3.worstCase.toLocaleString()}</span>
              </div>
            </div>

            <div className="projection-card">
              <h4>6 Months Projection</h4>
              <div className="base-val">${forecast.projections.month6.base.toLocaleString()}</div>
              <div className="scenario-row">
                <span className="best">Best: ${forecast.projections.month6.bestCase.toLocaleString()}</span>
                <span className="worst">Worst: ${forecast.projections.month6.worstCase.toLocaleString()}</span>
              </div>
            </div>

            <div className="projection-card highlight">
              <h4>12 Months Projection</h4>
              <div className="base-val">${forecast.projections.month12.base.toLocaleString()}</div>
              <div className="scenario-row">
                <span className="best">Best: ${forecast.projections.month12.bestCase.toLocaleString()}</span>
                <span className="worst">Worst: ${forecast.projections.month12.worstCase.toLocaleString()}</span>
              </div>
            </div>
          </div>

          <div className="chart-container" data-testid="forecast-chart-container">
            <h4>12-Month Projected Growth & Confidence Bands</h4>
            <div className="svg-chart-wrapper">
              <svg viewBox="0 0 600 200" className="forecast-svg-chart" data-testid="forecast-chart">
                {/* Confidence band polygon */}
                <polygon
                  points={
                    forecast.monthlyTimeline
                      .map((t, idx) => `${(idx / 11) * 560 + 20},${180 - (t.confidenceUpper / maxVal) * 160}`)
                      .join(" ") +
                    " " +
                    forecast.monthlyTimeline
                      .slice()
                      .reverse()
                      .map((t, idx) => `${((11 - idx) / 11) * 560 + 20},${180 - (t.confidenceLower / maxVal) * 160}`)
                      .join(" ")
                  }
                  fill="rgba(59, 130, 246, 0.15)"
                />

                {/* Best Case Line (Green dashed) */}
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="2"
                  strokeDasharray="4"
                  points={forecast.monthlyTimeline
                    .map((t, idx) => `${(idx / 11) * 560 + 20},${180 - (t.bestCase / maxVal) * 160}`)
                    .join(" ")}
                />

                {/* Base Case Line (Blue solid) */}
                <polyline
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth="3"
                  points={forecast.monthlyTimeline
                    .map((t, idx) => `${(idx / 11) * 560 + 20},${180 - (t.base / maxVal) * 160}`)
                    .join(" ")}
                />

                {/* Worst Case Line (Red dashed) */}
                <polyline
                  fill="none"
                  stroke="#ef4444"
                  strokeWidth="2"
                  strokeDasharray="4"
                  points={forecast.monthlyTimeline
                    .map((t, idx) => `${(idx / 11) * 560 + 20},${180 - (t.worstCase / maxVal) * 160}`)
                    .join(" ")}
                />
              </svg>
            </div>
            <div className="chart-legend">
              <span className="legend-item"><span className="dot best"></span> Best Case (+25%)</span>
              <span className="legend-item"><span className="dot base"></span> Base Case</span>
              <span className="legend-item"><span className="dot worst"></span> Worst Case (-25%)</span>
              <span className="legend-item"><span className="dot band"></span> Confidence Band</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
