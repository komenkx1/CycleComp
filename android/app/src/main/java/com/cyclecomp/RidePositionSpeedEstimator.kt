package com.cyclecomp

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

internal class RidePositionSpeedEstimator {
  data class Estimate(val speedMetersPerSecond: Double, val windowStartedAtMillis: Long)
  private data class Sample(val latitude: Double, val longitude: Double, val accuracyMeters: Double, val timestampMillis: Long)
  private val samples = mutableListOf<Sample>()

  fun reset() = samples.clear()

  fun update(latitude: Double, longitude: Double, accuracyMeters: Double, timestampMillis: Long): Estimate? {
    if (!latitude.isFinite() || latitude !in -90.0..90.0 || !longitude.isFinite() || longitude !in -180.0..180.0 ||
      !accuracyMeters.isFinite() || accuracyMeters !in 0.0..20.0) {
      reset()
      return null
    }
    samples.lastOrNull()?.let { lastSample ->
      val interval = timestampMillis - lastSample.timestampMillis
      if (interval <= 0) return null
      if (interval > 3_000) reset()
    }
    val latest = Sample(latitude, longitude, accuracyMeters, timestampMillis)
    samples.add(latest)
    samples.removeAll { timestampMillis - it.timestampMillis > 8_000 }
    if (samples.size < 3) return null
    for (first in samples.dropLast(2).asReversed()) {
      val duration = (timestampMillis - first.timestampMillis) / 1000.0
      if (duration !in 2.0..8.0) continue
      val latitudeDelta = Math.toRadians(latest.latitude - first.latitude)
      val longitudeDelta = Math.toRadians(latest.longitude - first.longitude)
      val haversine = sin(latitudeDelta / 2).let { it * it } +
        cos(Math.toRadians(first.latitude)) * cos(Math.toRadians(latest.latitude)) *
        sin(longitudeDelta / 2).let { it * it }
      val displacement = 2 * 6_371_000 * asin(min(1.0, sqrt(haversine)))
      if (displacement <= max(8.0, first.accuracyMeters + latest.accuracyMeters)) continue
      val speed = displacement / duration
      if (speed in 0.25..25.0) return Estimate(speed, first.timestampMillis)
    }
    return null
  }
}
