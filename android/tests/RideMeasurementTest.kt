package com.cyclecomp

import kotlin.math.abs

fun main() {
  val smoother = RideSpeedSmoother()
  check(smoother.update(10.0, 0, false) == 10.0)
  val smoothedSpeed = smoother.update(8.0, 1_000, false)!!
  check(smoothedSpeed in 8.0..10.0 && smoothedSpeed != 8.0 && smoothedSpeed != 10.0)
  check(smoother.update(0.04, 2_000, true) == 0.0)
  smoother.reset()
  check(smoother.update(5.0, 0, false) == 5.0)
  for (second in 1..4) check(smoother.update(null, second * 1_000L, false) == 5.0)
  check(smoother.update(null, 5_000, false) == null)
  check(smoother.update(4.0, 6_000, false) == 4.0)
  check(smoother.update(Double.NaN, 7_000, false) == 4.0)
  check(smoother.update(41.0, 11_001, false) == null)
  check(smoother.update(2.0, 12_000, false) == 2.0)
  check(smoother.update(5.0, 11_000, false) == 5.0)

  for (slope in listOf(0.05, -0.05)) {
    val grade = RideGradeEstimator()
    var measuredGrade: Double? = null
    for (index in 0..6) {
      val distance = index * 4.0
      measuredGrade = grade.update(distance, 30 + distance * slope, index * 1_000L, "barometer:1", true)
      if (index < 6) check(measuredGrade == null)
    }
    check(abs(measuredGrade!! - slope * 100) < 1e-9)
    check(grade.measurementWindowMeters == 24.0 && grade.measurementSampleCount == 7)
    check(grade.update(28.0, null, 7_000, "barometer:1", true) == null)
    check(grade.measurementSampleCount == 0)
  }

  val gpsGrade = RideGradeEstimator()
  var gpsResult: Double? = null
  for (index in 0..12) {
    val distance = index * 5.0
    gpsResult = gpsGrade.update(distance, distance * 0.03, index * 1_000L, "gps", true, 15.0)
    if (index < 12) check(gpsResult == null)
  }
  check(abs(gpsResult!! - 3.0) < 1e-9)
  check(gpsGrade.update(65.0, 2.0, 13_000, "gps", true, 16.0) == null)
  check(gpsGrade.measurementSampleCount == 0)
  check(gpsGrade.update(70.0, 2.0, 14_000, "gps", true, 0.0) == null)
  check(gpsGrade.update(70.0, 2.0, 14_000, "gps", true, null) == null)
  check(gpsGrade.update(70.0, 2.0, 14_000, "unknown", true) == null)
  check(gpsGrade.update(70.0, 2.0, 14_000, "barometer:1", false) == null)

  val interrupted = RideGradeEstimator()
  for (index in 0..6) interrupted.update(index * 4.0, index * 0.2, index * 1_000L, "barometer:1", true)
  check(interrupted.update(28.0, 1.4, 7_000, "barometer:2", true) == null)
  check(interrupted.measurementSampleCount == 1)
  check(interrupted.update(32.0, 1.6, 13_000, "barometer:2", true) == null)
  check(interrupted.measurementSampleCount == 1)
  check(interrupted.update(31.0, 1.5, 14_000, "barometer:2", true) == null)
  check(interrupted.measurementSampleCount == 1)
  check(interrupted.update(35.0, 1.7, 14_000, "barometer:2", true) == null)
  check(interrupted.measurementSampleCount == 1)
  println("Ride speed smoothing and grade checks passed")
}
