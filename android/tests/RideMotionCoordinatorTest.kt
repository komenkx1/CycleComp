package com.cyclecomp

fun main() {
  val coordinator = RideMotionCoordinator()
  fun sample(time: Long, latitude: Double, speed: Double?, accuracy: Double?, displacement: Double = 0.0) =
    coordinator.observe(RideMotionCoordinator.Sample(latitude, 115.0, 4.0, speed, accuracy, displacement, time))
  check(sample(1_000, -8.0, 0.0, 0.2) == null)
  check(sample(2_000, -8.0, 0.0, 0.2) == null)
  check(sample(3_000, -8.0, 0.0, 0.2) == null)
  val stopped = sample(4_000, -8.0, 0.0, 0.2)
  check(stopped?.state == RideAutoPausePolicy.MotionState.stationary && stopped.effectiveAtMillis == 2_000L)
  check(sample(5_000, -7.99999, 2.0, 0.2, 1.1) == null)
  val resumed = sample(6_000, -7.99995, 2.0, 0.2, 4.4)
  check(resumed?.state == RideAutoPausePolicy.MotionState.moving && resumed.effectiveAtMillis == 5_000L)
  val missing = sample(10_000, -7.99990, 2.0, 0.2, 5.5)
  check(missing?.state == RideAutoPausePolicy.MotionState.unknown && missing.effectiveAtMillis == 9_000L)
  coordinator.reset()
  for (time in 11_000L..15_000L step 1_000L) check(sample(time, -8.0, 0.0, null) == null)
  check(coordinator.state == RideAutoPausePolicy.MotionState.unknown)
  coordinator.reset()
  var activityStop: RideAutoPausePolicy.Transition? = null
  for (time in 20_000L..24_000L step 1_000L) {
    activityStop = coordinator.observe(RideMotionCoordinator.Sample(
      -8.0, 115.0, 4.0, 0.45, 0.2, 0.0, time, motionActivityIsStationary = true,
    )) ?: activityStop
  }
  check(activityStop?.state == RideAutoPausePolicy.MotionState.stationary)
  println("RideMotionCoordinator checks passed")
}
