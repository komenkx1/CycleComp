package com.cyclecomp

fun main() {
  fun event(kind: String, time: Long) = RideSessionEvent(kind, time, time)
  val events = listOf(event("motion_started", 2_000), event("motion_unknown", 5_000),
    event("manual_paused", 8_000), event("resumed", 12_000), event("motion_started", 14_000),
    event("motion_stopped", 18_000), event("finished", 20_000))
  check(RideMotionTiming.movingSeconds(events, 19_000, 20_000) == 7.0)
  check(RideMotionTiming.unknownSeconds(events, 0, 19_000, 20_000) == 7.0)
  check(RideMotionTiming.movingSeconds(listOf(event("motion_started", 1_000)), 2_000, 20_000) == 4.0)
  check(RideMotionTiming.endingEvent(RideAutoPausePolicy.MotionState.moving, 2_000, 8_000) == ("motion_unknown" to 5_000L))
  println("Ride motion timing checks passed")
}
