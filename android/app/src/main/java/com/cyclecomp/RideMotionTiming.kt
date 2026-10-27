package com.cyclecomp

internal data class RideSessionEvent(val kind: String, val effectiveAtMillis: Long, val detectedAtMillis: Long)

internal object RideMotionTiming {
  const val algorithmVersion = 3

  fun movingSeconds(events: List<RideSessionEvent>, lastLocationAtMillis: Long?, endMillis: Long): Double {
    var movingStartedAt: Long? = null
    var totalMillis = 0L
    for (event in ordered(events, endMillis)) {
      when (event.kind) {
        "motion_started" -> movingStartedAt = event.effectiveAtMillis
        "motion_stopped", "motion_unknown" -> {
          movingStartedAt?.let { totalMillis += (event.effectiveAtMillis - it).coerceAtLeast(0) }
          movingStartedAt = null
        }
      }
    }
    movingStartedAt?.let { startedAt ->
      val reliableUntil = lastLocationAtMillis?.plus(3_000) ?: startedAt
      totalMillis += (minOf(endMillis, reliableUntil) - startedAt).coerceAtLeast(0)
    }
    return totalMillis / 1000.0
  }

  fun unknownSeconds(events: List<RideSessionEvent>, startedAtMillis: Long, lastLocationAtMillis: Long?, endMillis: Long): Double {
    var motionIsUnknown = true
    var timerIsRunning = true
    var intervalStart = startedAtMillis
    var totalMillis = 0L
    val knownThrough = lastLocationAtMillis?.takeIf { it <= endMillis }?.plus(3_000)
    fun countUnknown(until: Long): Long {
      if (!timerIsRunning) return 0
      val unknownStartedAt = if (motionIsUnknown) intervalStart else maxOf(intervalStart, knownThrough ?: intervalStart)
      return (until - unknownStartedAt).coerceAtLeast(0)
    }
    for (event in ordered(events, endMillis)) {
      totalMillis += countUnknown(event.effectiveAtMillis)
      intervalStart = maxOf(startedAtMillis, event.effectiveAtMillis)
      when (event.kind) {
        "motion_started", "motion_stopped" -> motionIsUnknown = false
        "motion_unknown" -> motionIsUnknown = true
        "manual_paused", "auto_paused", "recording_error_paused" -> {
          timerIsRunning = false
          motionIsUnknown = true
        }
        "resumed" -> timerIsRunning = true
        "finished" -> timerIsRunning = false
      }
    }
    totalMillis += countUnknown(endMillis)
    return totalMillis / 1000.0
  }

  fun endingEvent(state: RideAutoPausePolicy.MotionState, lastLocationAtMillis: Long?, endMillis: Long): Pair<String, Long>? {
    if (state == RideAutoPausePolicy.MotionState.unknown) return null
    if (lastLocationAtMillis == null || lastLocationAtMillis > endMillis) return "motion_unknown" to endMillis
    val knownThrough = lastLocationAtMillis + 3_000
    if (endMillis > knownThrough) return "motion_unknown" to knownThrough
    return if (state == RideAutoPausePolicy.MotionState.moving) "motion_stopped" to endMillis else null
  }

  private fun ordered(events: List<RideSessionEvent>, endMillis: Long) = events
    .filter { it.effectiveAtMillis <= endMillis }
    .sortedWith(compareBy<RideSessionEvent> { it.effectiveAtMillis }.thenBy { it.detectedAtMillis })
}
