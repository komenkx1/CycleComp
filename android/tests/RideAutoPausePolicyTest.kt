package com.cyclecomp

fun main() {
  val policy = RideAutoPausePolicy()
  fun observe(speed: Double?, time: Long, latitude: Double = -8.0, displacement: Double = 0.0, accuracy: Double = 3.0) =
    policy.observe(speed, accuracy, 0.5, displacement, time, latitude = latitude, longitude = 115.0)
  check(observe(0.0, 1_000) == null)
  check(observe(0.0, 2_000) == null)
  check(observe(0.0, 3_000)?.state == RideAutoPausePolicy.MotionState.stationary)
  check(observe(2.0, 4_000, -7.99999, 1.0) == null)
  check(observe(2.0, 5_000, -7.99995, 4.0)?.state == RideAutoPausePolicy.MotionState.moving)
  check(observe(null, 6_000, accuracy = 30.0) == null)
  check(observe(null, 7_000, accuracy = 30.0) == null)
  check(observe(null, 8_000, accuracy = 30.0) == null)
  val unknown = observe(null, 9_000, accuracy = 30.0)
  check(unknown?.state == RideAutoPausePolicy.MotionState.unknown && unknown.effectiveAtMillis == 6_000L)
  check(observe(0.0, 8_000) == null)
  check(observe(0.0, 14_000)?.state == RideAutoPausePolicy.MotionState.unknown)
  println("RideAutoPausePolicy checks passed")
}
