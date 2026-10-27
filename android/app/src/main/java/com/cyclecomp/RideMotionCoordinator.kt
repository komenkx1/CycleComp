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
    val motionActivityIsStationary: Boolean = false,
  )

  data class Observation(
    val sample: Sample,
    val measuredSpeedMetersPerSecond: Double?,
    val displacementMeters: Double,
    val positionSpeedMetersPerSecond: Double?,
    val positionSpeedWindowStartedAtMillis: Long?,
    val stateBefore: RideAutoPausePolicy.MotionState,
    val stateAfter: RideAutoPausePolicy.MotionState,
    val transition: RideAutoPausePolicy.Transition?,
  )

  private val policy = RideAutoPausePolicy()
  private val positionSpeedEstimator = RidePositionSpeedEstimator()
  private val positionSpeedsByTimestamp = linkedMapOf<Long, RidePositionSpeedEstimator.Estimate>()
  private var lastTimestampMillis: Long? = null
  val state: RideAutoPausePolicy.MotionState get() = policy.state
  var lastObservation: Observation? = null
    private set

  fun reset() {
    policy.reset()
    positionSpeedEstimator.reset()
    positionSpeedsByTimestamp.clear()
    lastTimestampMillis = null
    lastObservation = null
  }

  fun observe(sample: Sample): RideAutoPausePolicy.Transition? {
    lastObservation = null
    val previousTimestamp = lastTimestampMillis
    if (previousTimestamp != null && sample.timestampMillis <= previousTimestamp) return null
    lastTimestampMillis = sample.timestampMillis
    val positionSpeed = positionSpeedEstimator.update(sample.latitude, sample.longitude, sample.accuracyMeters, sample.timestampMillis)
    if (positionSpeed != null) {
      positionSpeedsByTimestamp[sample.timestampMillis] = positionSpeed
      while (positionSpeedsByTimestamp.size > 20) positionSpeedsByTimestamp.remove(positionSpeedsByTimestamp.keys.first())
    }
    if (previousTimestamp == null) return null
    val validSpeed = sample.speedMetersPerSecond?.takeIf { it.isFinite() && it in 0.0..40.0 }
    val validSpeedAccuracy = sample.speedAccuracyMetersPerSecond?.takeIf { it.isFinite() && it in 0.0..1.5 }
    val measuredSpeed = if (validSpeedAccuracy != null) validSpeed else null
    val displacement = if (sample.timestampMillis - previousTimestamp <= 3_000) sample.displacementMeters else 0.0
    val stateBefore = policy.state
    val transition = policy.observe(
      speedMetersPerSecond = measuredSpeed,
      horizontalAccuracyMeters = sample.accuracyMeters,
      speedAccuracyMetersPerSecond = sample.speedAccuracyMetersPerSecond ?: -1.0,
      displacementSincePreviousMeters = displacement,
      timestampMillis = sample.timestampMillis,
      positionSpeedMetersPerSecond = positionSpeed?.speedMetersPerSecond,
      positionSpeedWindowStartedAtMillis = positionSpeed?.windowStartedAtMillis,
      latitude = sample.latitude,
      longitude = sample.longitude,
      motionActivityIsStationary = sample.motionActivityIsStationary,
    )
    lastObservation = Observation(sample, measuredSpeed, displacement, positionSpeed?.speedMetersPerSecond,
      positionSpeed?.windowStartedAtMillis, stateBefore, policy.state, transition)
    return transition
  }

  fun takePositionSpeed(timestampMillis: Long): RidePositionSpeedEstimator.Estimate? = positionSpeedsByTimestamp.remove(timestampMillis)
}
