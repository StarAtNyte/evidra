export interface ForecastInterval {
  low: number;
  median: number;
  high: number;
}

export interface ForecastAssessment {
  observedDelta: number;
  covered: boolean;
  medianError: number;
  intervalWidth: number;
  normalizedError: number;
  calibration: "underestimated" | "overestimated" | "calibrated";
}

export interface ForecastCalibrationSummary {
  samples: number;
  coverage: number;
  overestimates: number;
  underestimates: number;
  meanNormalizedError: number;
}

/** Summarize recent assessments for controller policy without treating them as metric evidence. */
export function summarizeForecastAssessments(
  assessments: Array<Pick<ForecastAssessment, "covered" | "calibration" | "normalizedError">>,
): ForecastCalibrationSummary | undefined {
  const valid = assessments.filter((assessment) => Number.isFinite(assessment.normalizedError));
  if (valid.length < 3) return undefined;
  return {
    samples: valid.length,
    coverage: valid.filter((assessment) => assessment.covered).length / valid.length,
    overestimates: valid.filter((assessment) => assessment.calibration === "overestimated").length,
    underestimates: valid.filter((assessment) => assessment.calibration === "underestimated").length,
    meanNormalizedError: valid.reduce((total, assessment) => total + assessment.normalizedError, 0) / valid.length,
  };
}

/**
 * Compare a declared hypothesis forecast with the measured metric delta.
 * This is diagnostic evidence only: it never changes the evaluator or
 * promotes an experiment. A small interval that misses repeatedly is a
 * useful signal for search routing, while a wide interval is penalized less
 * for coverage but remains visibly uncertain.
 */
export function assessForecast(forecast: ForecastInterval, observedDelta: number): ForecastAssessment {
  if (![forecast.low, forecast.median, forecast.high, observedDelta].every(Number.isFinite)) {
    throw new Error("Forecast and observed delta must be finite.");
  }
  if (forecast.low > forecast.median || forecast.median > forecast.high) {
    throw new Error("Forecast interval must be ordered low <= median <= high.");
  }
  const intervalWidth = forecast.high - forecast.low;
  const medianError = observedDelta - forecast.median;
  const normalizedError = Math.abs(medianError) / Math.max(1e-9, intervalWidth, Math.abs(forecast.median), 1);
  const tolerance = Math.max(1e-9, intervalWidth * 0.1);
  return {
    observedDelta,
    covered: observedDelta >= forecast.low && observedDelta <= forecast.high,
    medianError,
    intervalWidth,
    normalizedError,
    calibration: Math.abs(medianError) <= tolerance ? "calibrated" : medianError > 0 ? "underestimated" : "overestimated",
  };
}
