import express from "express";
import { calculateForecast } from "../../services/forecast.js";
import { sendError } from "../../error-response.js";

const router = express.Router();

/**
 * GET /api/v1/analytics/forecast
 * Earnings forecast simulator endpoint.
 */
router.get("/", (req, res) => {
  try {
    const { contractId, address, frequency, avgPayout, secondaryVolume } = req.query;

    const forecast = calculateForecast({
      contractId,
      address,
      frequency: frequency || "monthly",
      avgPayout: avgPayout ? parseFloat(avgPayout) : undefined,
      secondaryVolume: secondaryVolume ? parseFloat(secondaryVolume) : 0,
    });

    res.set("Cache-Control", "max-age=60");
    res.json({
      success: true,
      data: forecast,
    });
  } catch (error) {
    sendError(res, 500, "forecast_calculation_failed", "Failed to calculate earnings forecast");
  }
});

export { router as forecastRouter };
