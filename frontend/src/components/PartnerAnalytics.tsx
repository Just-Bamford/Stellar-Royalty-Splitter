import React from "react";
import type { PartnerAnalytics as PartnerAnalyticsData } from "../api";
import "./PartnerAnalytics.css";

/**
 * PartnerAnalytics - Partner analytics dashboard
 *
 * Note: This is currently a stub component. Full implementation pending
 * backend endpoint development and complete type definitions.
 */
export const PartnerAnalytics: React.FC<{
  data: PartnerAnalyticsData;
  isLoading?: boolean;
  error?: string | null;
  onRangeChange?: (days: number) => void;
}> = ({ isLoading, error }) => {
  if (error) {
    return (
      <div className="partner-analytics" data-testid="partner-analytics">
        <div className="partner-error-banner" role="alert">
          {error}
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="partner-analytics" data-testid="partner-analytics">
        <p>Loading analytics...</p>
      </div>
    );
  }

  return (
    <div className="partner-analytics" data-testid="partner-analytics">
      <p>Partner analytics feature coming soon.</p>
    </div>
  );
};

export const PARTNER_RANGE_OPTIONS = [7, 30, 90] as const;
export type PartnerRange = (typeof PARTNER_RANGE_OPTIONS)[number];
