package com.cyclecomp

internal class RideMotionCoordinator {
  data class Sample(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double,
    val speedMetersPerSecond: Double?,
    val speedAccuracyMetersPerSecond: Double?,
    val displacementMeters: Double,
    val timestampMillis: Long,
  )

  private val policy = RideAutoPausePolicy()
  private val positionSpeedEstimator = RidePositionSpeedEstimator()
  private var lastTimestampMillis: Long? = null
  val state: RideAutoPausePolicy.MotionState get() = policy.state

  fun reset() {
    policy.reset()
    positionSpeedEstimator.reset()
    lastTimestampMillis = null
  }

  fun observe(sample: Sample): RideAutoPausePolicy.Transition? {
    val previousTimestamp = lastTimestampMillis
    if (previousTimestamp != null && sample.timestampMillis <= previousTimestamp) return null
    lastTimestampMillis = sample.timestampMillis
    val positionSpeed = positionSpeedEstimator.update(sample.latitude, sample.longitude, sample.accuracyMeters, sample.timestampMillis)
    if (previousTimestamp == null) return null
    val validSpeed = sample.speedMetersPerSecond?.takeIf { it.isFinite() && it in 0.0..40.0 }
    val validSpeedAccuracy = sample.speedAccuracyMetersPerSecond?.takeIf { it.isFinite() && it in 0.0..1.5 }
    return policy.observe(
      speedMetersPerSecond = if (validSpeedAccuracy != null) validSpeed else null,
      horizontalAccuracyMeters = sample.accuracyMeters,
      speedAccuracyMetersPerSecond = sample.speedAccuracyMetersPerSecond ?: -1.0,
      displacementSincePreviousMeters = if (sample.timestampMillis - previousTimestamp <= 3_000) sample.displacementMeters else 0.0,
      timestampMillis = sample.timestampMillis,
      positionSpeedMetersPerSecond = positionSpeed?.speedMetersPerSecond,
      positionSpeedWindowStartedAtMillis = positionSpeed?.windowStartedAtMillis,
      latitude = sample.latitude,
      longitude = sample.longitude,
    )
  }
}
