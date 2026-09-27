import { Router } from "express";
import { getAdvancedAnalytics } from "../services/analytics-engine.js";
import { getMaterializedSnapshot } from "../database/materialized-views.js";

export const advancedAnalyticsRouter = Router();

advancedAnalyticsRouter.get("/analytics/advanced/:contractId", (req, res, next) => {
  try {
    const hours = Math.min(Math.max(Number.parseInt(req.query.hours ?? "24", 10) || 24, 1), 168);
    const days = Math.min(Math.max(Number.parseInt(req.query.days ?? "30", 10) || 30, 1), 365);
    const weeks = Math.min(Math.max(Number.parseInt(req.query.weeks ?? "12", 10) || 12, 1), 52);
    const data = getAdvancedAnalytics(req.params.contractId, {
      hours,
      days,
      weeks,
      refresh: req.query.refresh === "true",
      onAlert: (anomaly) => req.app.emit("analytics:anomaly", { contractId: req.params.contractId, anomaly }),
    });
    res.set("Cache-Control", "private, max-age=30");
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// Real-time hourly analytics endpoint
advancedAnalyticsRouter.get("/analytics/realtime/hourly/:contractId", (req, res, next) => {
  try {
    const hours = Math.min(Math.max(Number.parseInt(req.query.hours ?? "24", 10) || 24, 1), 168);
    const snapshot = getMaterializedSnapshot(req.params.contractId, { hours });
    
    res.set("Cache-Control", "private, max-age=60");
    res.json({ 
      success: true, 
      data: {
        contractId: req.params.contractId,
        hourly: snapshot.hourly,
        summary: {
          totalDistributions: snapshot.hourly.reduce((sum, h) => sum + h.distributionCount, 0),
          totalFailed: snapshot.hourly.reduce((sum, h) => sum + h.failedCount, 0),
          totalAmount: snapshot.hourly.reduce((sum, h) => sum + parseFloat(h.totalAmount || 0), 0),
          totalEarnings: snapshot.hourly.reduce((sum, h) => sum + parseFloat(h.collaboratorEarnings || 0), 0),
          avgGasPerHour: snapshot.hourly.length > 0 
            ? snapshot.hourly.reduce((sum, h) => sum + h.gasUsage, 0) / snapshot.hourly.length 
            : 0
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// Real-time daily analytics endpoint
advancedAnalyticsRouter.get("/analytics/realtime/daily/:contractId", (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number.parseInt(req.query.days ?? "30", 10) || 30, 1), 365);
    const snapshot = getMaterializedSnapshot(req.params.contractId, { days });
    
    res.set("Cache-Control", "private, max-age=300");
    res.json({ 
      success: true, 
      data: {
        contractId: req.params.contractId,
        daily: snapshot.daily,
        trends: calculateDailyTrends(snapshot.daily),
        summary: {
          totalDistributions: snapshot.daily.reduce((sum, d) => sum + d.distributionCount, 0),
          totalFailed: snapshot.daily.reduce((sum, d) => sum + d.failedCount, 0),
          totalAmount: snapshot.daily.reduce((sum, d) => sum + parseFloat(d.totalAmount || 0), 0),
          totalEarnings: snapshot.daily.reduce((sum, d) => sum + parseFloat(d.collaboratorEarnings || 0), 0),
          avgActiveCollaborators: snapshot.daily.length > 0 
            ? snapshot.daily.reduce((sum, d) => sum + d.activeCollaborators, 0) / snapshot.daily.length 
            : 0,
          successRate: calculateSuccessRate(snapshot.daily)
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// Real-time weekly analytics with cohort analysis
advancedAnalyticsRouter.get("/analytics/realtime/weekly/:contractId", (req, res, next) => {
  try {
    const weeks = Math.min(Math.max(Number.parseInt(req.query.weeks ?? "12", 10) || 12, 1), 52);
    const snapshot = getMaterializedSnapshot(req.params.contractId, { weeks });
    
    res.set("Cache-Control", "private, max-age=600");
    res.json({ 
      success: true, 
      data: {
        contractId: req.params.contractId,
        weekly: snapshot.weekly,
        cohortAnalysis: {
          avgGrowthRate: calculateAverage(snapshot.weekly.map(w => w.growthRate)),
          avgRetentionRate: calculateAverage(snapshot.weekly.map(w => w.retentionRate)),
          totalNewCollaborators: snapshot.weekly.reduce((sum, w) => sum + w.newCollaborators, 0),
          avgPayoutPerCollaborator: calculateAverage(snapshot.weekly.map(w => w.avgPayoutPerCollaborator))
        },
        summary: {
          totalDistributions: snapshot.weekly.reduce((sum, w) => sum + w.distributionCount, 0),
          totalFailed: snapshot.weekly.reduce((sum, w) => sum + w.failedCount, 0),
          totalAmount: snapshot.weekly.reduce((sum, w) => sum + parseFloat(w.totalAmount || 0), 0),
          totalEarnings: snapshot.weekly.reduce((sum, w) => sum + parseFloat(w.collaboratorEarnings || 0), 0),
          peakActiveCollaborators: Math.max(...snapshot.weekly.map(w => w.activeCollaborators), 0)
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// Dashboard overview endpoint combining all time ranges
advancedAnalyticsRouter.get("/analytics/dashboard/:contractId", (req, res, next) => {
  try {
    const snapshot = getMaterializedSnapshot(req.params.contractId, { 
      hours: 24, 
      days: 30, 
      weeks: 12 
    });
    
    const latestHour = snapshot.hourly[0] || {};
    const latestDay = snapshot.daily[0] || {};
    const latestWeek = snapshot.weekly[0] || {};
    
    res.set("Cache-Control", "private, max-age=60");
    res.json({ 
      success: true, 
      data: {
        contractId: req.params.contractId,
        timestamp: new Date().toISOString(),
        current: {
          lastHour: {
            distributions: latestHour.distributionCount || 0,
            failures: latestHour.failedCount || 0,
            amount: parseFloat(latestHour.totalAmount || 0),
            earnings: parseFloat(latestHour.collaboratorEarnings || 0)
          },
          today: {
            distributions: latestDay.distributionCount || 0,
            failures: latestDay.failedCount || 0,
            amount: parseFloat(latestDay.totalAmount || 0),
            earnings: parseFloat(latestDay.collaboratorEarnings || 0),
            activeCollaborators: latestDay.activeCollaborators || 0
          },
          thisWeek: {
            distributions: latestWeek.distributionCount || 0,
            failures: latestWeek.failedCount || 0,
            amount: parseFloat(latestWeek.totalAmount || 0),
            earnings: parseFloat(latestWeek.collaboratorEarnings || 0),
            activeCollaborators: latestWeek.activeCollaborators || 0,
            growthRate: latestWeek.growthRate || 0,
            retentionRate: latestWeek.retentionRate || 0
          }
        },
        trends: {
          hourly: snapshot.hourly.slice(0, 24),
          daily: snapshot.daily.slice(0, 7),
          weekly: snapshot.weekly.slice(0, 4)
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

// Helper functions
function calculateDailyTrends(dailyData) {
  if (dailyData.length < 2) return { direction: "stable", changePercent: 0 };
  
  const recent = dailyData.slice(0, 7);
  const previous = dailyData.slice(7, 14);
  
  const recentAvg = recent.reduce((sum, d) => sum + d.distributionCount, 0) / recent.length;
  const previousAvg = previous.length > 0 
    ? previous.reduce((sum, d) => sum + d.distributionCount, 0) / previous.length 
    : recentAvg;
  
  const changePercent = previousAvg > 0 ? ((recentAvg - previousAvg) / previousAvg) * 100 : 0;
  const direction = changePercent > 5 ? "up" : changePercent < -5 ? "down" : "stable";
  
  return { direction, changePercent: Math.round(changePercent * 100) / 100 };
}

function calculateSuccessRate(dailyData) {
  const total = dailyData.reduce((sum, d) => sum + d.distributionCount + d.failedCount, 0);
  const successful = dailyData.reduce((sum, d) => sum + d.distributionCount, 0);
  return total > 0 ? Math.round((successful / total) * 10000) / 100 : 100;
}

function calculateAverage(numbers) {
  if (numbers.length === 0) return 0;
  const sum = numbers.reduce((acc, num) => acc + (num || 0), 0);
  return Math.round((sum / numbers.length) * 100) / 100;
}
