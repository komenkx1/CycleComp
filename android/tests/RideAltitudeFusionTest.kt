package com.cyclecomp

import kotlin.math.abs

private fun expectClose(actual: Double?, expected: Double) {
  check(actual != null && abs(actual - expected) < 0.001) { "Expected $expected, got $actual" }
}

fun main() {
  val fusion = RideAltitudeFusion()
  fusion.startNewEpoch()
  fusion.recordPressure(0.0, 101.0, 1_000)
  val unanchored = fusion.reading(null, null, 1_000)
  check(unanchored.elevationMeters == null && unanchored.anchorQuality == "unanchored")
  expectClose(unanchored.relativeElevationMeters, 0.0)

  val fallback = fusion.reading(-10.0, 20.0, 4_000)
  expectClose(fallback.elevationMeters, -10.0)
  check(fallback.elevationSource == "gps" && fallback.pressureKilopascals == null)
  check(fusion.reading(12.0, 61.0, 4_000).elevationMeters == null)

  for (index in 0..5) {
    val timestamp = 10_000L + index * 2_000L
    fusion.recordPressure(index.toDouble(), 101.0, timestamp)
    fusion.reading(100.0 + index, 5.0, timestamp)
  }
  fusion.recordPressure(6.0, 101.0, 21_000)
  val calibrated = fusion.reading(null, null, 21_000)
  expectClose(calibrated.elevationMeters, 106.0)
  check(calibrated.elevationSource == "barometer_gps" && calibrated.anchorQuality == "calibrated")

  fusion.recordPressure(99.0, 101.0, 20_000)
  expectClose(fusion.reading(null, null, 21_000).elevationMeters, 106.0)
  fusion.startNewEpoch(calibrated.elevationMeters, true)
  fusion.recordPressure(0.0, 100.0, 30_000)
  expectClose(fusion.reading(null, null, 30_000).elevationMeters, 106.0)
  check(fusion.reading(null, null, 33_000).elevationMeters == null)
  println("RideAltitudeFusion checks passed")
}
