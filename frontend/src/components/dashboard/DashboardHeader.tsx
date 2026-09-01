import React, { useState } from "react";

export interface DateRange {
  start: string;
  end: string;
}

interface DashboardHeaderProps {
  allTime: boolean;
  dateRange: DateRange;
  onAllTimeToggle: () => void;
  onDateRangeChange: (range: DateRange) => void;
  onRefresh: () => void;
  /** Optional sort controls shown when the performance section is active. */
  sortBy?: "revenue" | "transactions" | "name";
  onSortByChange?: (v: "revenue" | "transactions" | "name") => void;
  sortDirection?: "asc" | "desc";
  onSortDirectionChange?: (v: "asc" | "desc") => void;
  /** Disables the refresh button while data is loading. */
  loading?: boolean;
}

/**
 * DashboardHeader — date range filter, optional sort controls, and refresh
 * button for the analytics dashboard. Validates start/end ordering and
 * surfaces an inline error.
 */
export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  allTime,
  dateRange,
  onAllTimeToggle,
  onDateRangeChange,
  onRefresh,
  sortBy,
  onSortByChange,
  sortDirection,
  onSortDirectionChange,
  loading = false,
}) => {
  const [dateError, setDateError] = useState<string | null>(null);
  const today = new Date().toISOString().split("T")[0];

  const handleStartChange = (start: string) => {
    if (start > dateRange.end) {
      setDateError("Start date must be on or before end date.");
    } else {
      setDateError(null);
      onDateRangeChange({ ...dateRange, start });
    }
  };

  const handleEndChange = (end: string) => {
    if (end < dateRange.start) {
      setDateError("End date must be on or after start date.");
    } else {
      setDateError(null);
      onDateRangeChange({ ...dateRange, end });
    }
  };

  return (
    <header className="dashboard-header">
      <div className="dashboard-header-copy">
        <h1>Contract Performance Dashboard</h1>
        <p className="dashboard-subtitle">
          Monitor which contracts generate the most revenue and activity.
        </p>
      </div>

      <div className="dashboard-toolbar" role="region" aria-label="Dashboard filters">
        <div className="toolbar-group toolbar-dates">
          <span className="toolbar-label">Date range</span>
          <div className="toolbar-controls">
            <button
              type="button"
              onClick={onAllTimeToggle}
              className={`preset-btn${allTime ? " active" : ""}`}
              aria-pressed={allTime}
            >
              All time
            </button>
            <div className="date-inputs">
              <label className="sr-only" htmlFor="performance-start-date">
                Start date
              </label>
              <input
                id="performance-start-date"
                type="date"
                value={dateRange.start}
                max={today}
                disabled={allTime}
                aria-label="Start date"
                onChange={(e) => handleStartChange(e.target.value)}
              />
              <span className="date-separator" aria-hidden="true">
                to
              </span>
              <label className="sr-only" htmlFor="performance-end-date">
                End date
              </label>
              <input
                id="performance-end-date"
                type="date"
                value={dateRange.end}
                max={today}
                disabled={allTime}
                aria-label="End date"
                onChange={(e) => handleEndChange(e.target.value)}
              />
            </div>
          </div>
        </div>

        {onSortByChange && sortBy !== undefined && (
          <div className="toolbar-group toolbar-sort">
            <span className="toolbar-label">Sort by</span>
            <div className="toolbar-controls">
              <select
                id="performance-sort"
                aria-label="Sort contracts"
                value={sortBy}
                onChange={(e) =>
                  onSortByChange(e.target.value as "revenue" | "transactions" | "name")
                }
              >
                <option value="revenue">Revenue</option>
                <option value="transactions">Transactions</option>
                <option value="name">Name</option>
              </select>
              {onSortDirectionChange && sortDirection !== undefined && (
                <button
                  type="button"
                  className="sort-direction-btn"
                  aria-label={`Sort direction: ${sortDirection === "asc" ? "ascending" : "descending"}`}
                  onClick={() =>
                    onSortDirectionChange(sortDirection === "asc" ? "desc" : "asc")
                  }
                >
                  {sortDirection === "asc" ? "↑ Asc" : "↓ Desc"}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="toolbar-group toolbar-actions">
          <button
            type="button"
            onClick={onRefresh}
            className="refresh-btn"
            disabled={loading}
          >
            Refresh
          </button>
        </div>

        {dateError && (
          <div className="date-error" role="alert">
            {dateError}
          </div>
        )}
      </div>
    </header>
  );
};

export default DashboardHeader;
