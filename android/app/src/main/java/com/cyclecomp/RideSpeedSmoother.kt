package com.cyclecomp

import kotlin.math.exp

internal class RideSpeedSmoother {
  private var filteredSpeedMetersPerSecond: Double? = null
  private var lastUpdateAtMillis: Long? = null

  fun update(speedMetersPerSecond: Double?, timestampMillis: Long, stationary: Boolean): Double? {
    if (stationary) {
      filteredSpeedMetersPerSecond = 0.0
      lastUpdateAtMillis = timestampMillis
      return 0.0
    }
    if (speedMetersPerSecond == null || !speedMetersPerSecond.isFinite() || speedMetersPerSecond !in 0.0..40.0) {
      val previousSpeed = filteredSpeedMetersPerSecond
      val lastUpdate = lastUpdateAtMillis
      if (previousSpeed != null && lastUpdate != null && timestampMillis >= lastUpdate && timestampMillis - lastUpdate <= 4_000) {
        return previousSpeed
      }
      reset()
      return null
    }
    val previousSpeed = filteredSpeedMetersPerSecond
    val lastUpdate = lastUpdateAtMillis
    if (previousSpeed == null || lastUpdate == null || timestampMillis <= lastUpdate || timestampMillis - lastUpdate > 5_000) {
      filteredSpeedMetersPerSecond = speedMetersPerSecond
      lastUpdateAtMillis = timestampMillis
      return speedMetersPerSecond
    }
    val elapsedSeconds = (timestampMillis - lastUpdate) / 1000.0
    val smoothedSpeed = previousSpeed + (1 - exp(-elapsedSeconds)) * (speedMetersPerSecond - previousSpeed)
    filteredSpeedMetersPerSecond = smoothedSpeed
    lastUpdateAtMillis = timestampMillis
    return smoothedSpeed
  }

  fun reset() {
    filteredSpeedMetersPerSecond = null
    lastUpdateAtMillis = null
  }
}
