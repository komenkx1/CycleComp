package com.cyclecomp

fun main() {
  val estimator = RidePositionSpeedEstimator()
  check(estimator.update(-8.0, 115.0, 4.0, 1_000) == null)
  check(estimator.update(-7.99998, 115.0, 4.0, 2_000) == null)
  check(estimator.update(-7.99996, 115.0, 4.0, 3_000) == null)
  val moving = estimator.update(-7.99990, 115.0, 4.0, 4_000)
  check(moving != null && moving.speedMetersPerSecond in 3.0..5.0 && moving.windowStartedAtMillis == 2_000L)
  check(estimator.update(-7.99990, 115.0, 100.0, 5_000) == null)
  check(estimator.update(-7.99980, 115.0, 4.0, 6_000) == null)
  check(estimator.update(-7.99970, 115.0, 4.0, 10_000) == null)
  println("RidePositionSpeedEstimator checks passed")
}
