import { useState, useEffect } from "react";
import { formatCurrency } from "../utils/format";
import { useSettings } from "../context/SettingsContext";
import "./EarningsForecastCalculator.css";

interface ForecastData {
  currentBalance: number;
  dailyRate: number;
  monthlyRate: number;
  yearlyRate: number;
}

interface ScenarioForecast {
  scenario: "conservative" | "realistic" | "optimistic";
  multiplier: number;
  oneMonth: { projected: number; netGain: number };
  threeMonths: { projected: number; netGain: number };
  oneYear: { projected: number; netGain: number };
}

interface EarningsForecastCalculatorProps {
  contractId: string;
}

export const EarningsForecastCalculator: React.FC<EarningsForecastCalculatorProps> = ({
  contractId,
}) => {
  const { settings } = useSettings();
  const [forecastData, setForecastData] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customRate, setCustomRate] = useState<string>("");
  const [useCustomRate, setUseCustomRate] = useState(false);

  useEffect(() => {
    loadForecastData();
  }, [contractId]);

  const loadForecastData = async () => {
    if (!contractId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Calculate daily rate from recent analytics data
      // For now, we'll use a simplified calculation based on last 30 days
      const response = await fetch(
        `/api/v1/analytics/${contractId}?startDate=${getStartDate(30)}&endDate=${getEndDate()}`
      );
      
      if (!response.ok) {
        throw new Error("Failed to fetch analytics data");
      }

      const data = await response.json();
      
      if (data.success && data.data) {
        const totalDistributed = data.data.summary?.totalDistributed || 0;
        const dailyRate = totalDistributed / 30; // Simple daily rate calculation
        
        setForecastData({
          currentBalance: totalDistributed,
          dailyRate,
          monthlyRate: dailyRate * 30,
          yearlyRate: dailyRate * 365,
        });
      } else {
        setError("No analytics data available");
      }
    } catch (err) {
      console.error("Error loading forecast data:", err);
      setError("Error loading forecast data");
    } finally {
      setLoading(false);
    }
  };

  const getStartDate = (daysAgo: number): string => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return date.toISOString().split("T")[0];
  };

  const getEndDate = (): string => {
    return new Date().toISOString().split("T")[0];
  };

  const calculateScenarios = (data: ForecastData): ScenarioForecast[] => {
    const scenarios: Array<{ scenario: "conservative" | "realistic" | "optimistic"; multiplier: number }> = [
      { scenario: "conservative", multiplier: 0.5 },
      { scenario: "realistic", multiplier: 1 },
      { scenario: "optimistic", multiplier: 2 },
    ];

    const effectiveRate = useCustomRate && customRate ? parseFloat(customRate) : data.dailyRate;

    return scenarios.map(({ scenario, multiplier }) => {
      const adjustedDailyRate = effectiveRate * multiplier;
      
      return {
        scenario,
        multiplier,
        oneMonth: {
          projected: data.currentBalance + adjustedDailyRate * 30,
          netGain: adjustedDailyRate * 30,
        },
        threeMonths: {
          projected: data.currentBalance + adjustedDailyRate * 90,
          netGain: adjustedDailyRate * 90,
        },
        oneYear: {
          projected: data.currentBalance + adjustedDailyRate * 365,
          netGain: adjustedDailyRate * 365,
        },
      };
    });
  };

  if (!contractId) {
    return (
      <div className="forecast-calculator">
        <div className="empty-state">
          <div className="empty-icon">📈</div>
          <h2>No Contract Selected</h2>
          <p>Please initialize or select a contract to view earnings forecasts.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="forecast-calculator">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading forecast data...</p>
        </div>
      </div>
    );
  }

  if (error || !forecastData) {
    return (
      <div className="forecast-calculator">
        <div className="error-state">
          <div className="error-icon">⚠️</div>
          <h2>Unable to Load Forecast</h2>
          <p>{error || "No data available"}</p>
          <button onClick={loadForecastData} className="retry-btn">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const scenarios = calculateScenarios(forecastData);
  const effectiveDailyRate = useCustomRate && customRate ? parseFloat(customRate) : forecastData.dailyRate;
  const effectiveMonthlyRate = effectiveDailyRate * 30;
  const effectiveYearlyRate = effectiveDailyRate * 365;

  return (
    <div className="forecast-calculator">
      <div className="forecast-header">
        <h1>Earnings Forecast Calculator</h1>
        <div className="disclaimer">
          ⚠️ <strong>Disclaimer:</strong> Forecasts assume the current earning rate remains constant. 
          Actual earnings may vary based on market conditions, sales volume, and other factors.
        </div>
      </div>

      <div className="current-stats">
        <div className="stat-card">
          <div className="stat-label">Current Balance</div>
          <div className="stat-value">
            {formatCurrency(forecastData.currentBalance, settings.displayCurrency)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Daily Earning Rate</div>
          <div className="stat-value">
            {formatCurrency(effectiveDailyRate, settings.displayCurrency)}
          </div>
          <div className="stat-unit">per day</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Monthly Earning Rate</div>
          <div className="stat-value">
            {formatCurrency(effectiveMonthlyRate, settings.displayCurrency)}
          </div>
          <div className="stat-unit">per month</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Yearly Earning Rate</div>
          <div className="stat-value">
            {formatCurrency(effectiveYearlyRate, settings.displayCurrency)}
          </div>
          <div className="stat-unit">per year</div>
        </div>
      </div>

      <div className="custom-rate-section">
        <label className="custom-rate-toggle">
          <input
            type="checkbox"
            checked={useCustomRate}
            onChange={(e) => setUseCustomRate(e.target.checked)}
          />
          Use custom daily rate
        </label>
        {useCustomRate && (
          <div className="custom-rate-input">
            <input
              type="number"
              value={customRate}
              onChange={(e) => setCustomRate(e.target.value)}
              placeholder="Enter daily rate"
              step="0.01"
              min="0"
            />
            <span className="currency-symbol">{settings.displayCurrency}</span>
          </div>
        )}
      </div>

      <div className="scenarios-container">
        {scenarios.map((scenario) => (
          <div key={scenario.scenario} className={`scenario-card scenario-${scenario.scenario}`}>
            <div className="scenario-header">
              <h3 className="scenario-title">
                {scenario.scenario === "conservative" && "🐢 Conservative"}
                {scenario.scenario === "realistic" && "📊 Realistic"}
                {scenario.scenario === "optimistic" && "🚀 Optimistic"}
              </h3>
              <div className="scenario-multiplier">
                {scenario.multiplier}x current rate
              </div>
            </div>

            <div className="forecast-periods">
              <div className="forecast-period">
                <div className="period-label">1 Month</div>
                <div className="period-projected">
                  {formatCurrency(scenario.oneMonth.projected, settings.displayCurrency)}
                </div>
                <div className="period-gain positive">
                  +{formatCurrency(scenario.oneMonth.netGain, settings.displayCurrency)}
                </div>
              </div>

              <div className="forecast-period">
                <div className="period-label">3 Months</div>
                <div className="period-projected">
                  {formatCurrency(scenario.threeMonths.projected, settings.displayCurrency)}
                </div>
                <div className="period-gain positive">
                  +{formatCurrency(scenario.threeMonths.netGain, settings.displayCurrency)}
                </div>
              </div>

              <div className="forecast-period">
                <div className="period-label">1 Year</div>
                <div className="period-projected">
                  {formatCurrency(scenario.oneYear.projected, settings.displayCurrency)}
                </div>
                <div className="period-gain positive">
                  +{formatCurrency(scenario.oneYear.netGain, settings.displayCurrency)}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="forecast-footer">
        <button onClick={loadForecastData} className="refresh-btn">
          🔄 Refresh Data
        </button>
      </div>
    </div>
  );
};
