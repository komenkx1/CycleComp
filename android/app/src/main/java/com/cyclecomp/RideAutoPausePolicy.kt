package com.cyclecomp

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

internal class RideAutoPausePolicy {
  enum class MotionState { unknown, moving, stationary }
  data class Transition(val state: MotionState, val effectiveAtMillis: Long)
  private data class Coordinate(val latitude: Double, val longitude: Double)

  var state = MotionState.unknown
    private set
  private var stationaryCandidateAt: Long? = null
  private var stationaryCandidateCount = 0
  private var stationaryCandidateCoordinate: Coordinate? = null
  private var movementCandidateAt: Long? = null
  private var movementCandidateCount = 0
  private var movementCandidateDistance = 0.0
  private var movementCandidateOrigin: Coordinate? = null
  private var previousCoordinate: Coordinate? = null
  private var lastSampleAt: Long? = null
  private var invalidEvidenceStartedAt: Long? = null

  fun reset() {
    state = MotionState.unknown
    resetCandidates()
    lastSampleAt = null
    invalidEvidenceStartedAt = null
    previousCoordinate = null
  }

  fun observe(
    speedMetersPerSecond: Double?,
    horizontalAccuracyMeters: Double,
    speedAccuracyMetersPerSecond: Double,
    displacementSincePreviousMeters: Double,
    timestampMillis: Long,
    positionSpeedMetersPerSecond: Double? = null,
    positionSpeedWindowStartedAtMillis: Long? = null,
    latitude: Double? = null,
    longitude: Double? = null,
    motionActivityIsStationary: Boolean = false,
  ): Transition? {
    lastSampleAt?.let { previousTimestamp ->
      if (timestampMillis <= previousTimestamp) return null
      if (timestampMillis - previousTimestamp > 3_000) {
        state = MotionState.unknown
        resetCandidates()
        invalidEvidenceStartedAt = null
        previousCoordinate = null
        lastSampleAt = timestampMillis
        return Transition(state, previousTimestamp + 3_000)
      }
    }
    lastSampleAt = timestampMillis
    val coordinate = if (latitude != null && longitude != null && latitude.isFinite() && longitude.isFinite() &&
      latitude in -90.0..90.0 && longitude in -180.0..180.0) Coordinate(latitude, longitude) else null
    val previousPosition = previousCoordinate
    previousCoordinate = coordinate
    val horizontalValid = horizontalAccuracyMeters.isFinite() && horizontalAccuracyMeters in 0.0..20.0 &&
      displacementSincePreviousMeters.isFinite() && displacementSincePreviousMeters >= 0
    if (!horizontalValid) return observeInvalidEvidence(timestampMillis)
    val gpsSpeedValid = speedAccuracyMetersPerSecond.isFinite() && speedAccuracyMetersPerSecond in 0.0..4.5 &&
      speedMetersPerSecond != null && speedMetersPerSecond.isFinite() && speedMetersPerSecond in 0.0..40.0
    if (!gpsSpeedValid) {
      if (positionSpeedMetersPerSecond == null || !positionSpeedMetersPerSecond.isFinite() ||
        positionSpeedMetersPerSecond !in 0.25..40.0) return observeInvalidEvidence(timestampMillis)
      invalidEvidenceStartedAt = null
      return observePositionSpeed(positionSpeedMetersPerSecond, positionSpeedWindowStartedAtMillis ?: timestampMillis,
        displacementSincePreviousMeters, timestampMillis)
    }
    invalidEvidenceStartedAt = null
    val preciseStop = speedMetersPerSecond <= 0.15 && speedAccuracyMetersPerSecond <= 1.0
    val lowSpeedStop = speedMetersPerSecond <= 0.35 && displacementSincePreviousMeters <= 2.0 && coordinate != null
    val activityStop = motionActivityIsStationary && speedMetersPerSecond <= 0.5 &&
      speedAccuracyMetersPerSecond <= 2.0 && horizontalAccuracyMeters <= 12 && coordinate != null
    if (preciseStop || lowSpeedStop || activityStop) {
      resetMovementCandidate()
      if (coordinate != null) {
        val candidateCoordinate = stationaryCandidateCoordinate
        if (candidateCoordinate != null && distanceMeters(candidateCoordinate, coordinate) > max(3.0, horizontalAccuracyMeters * 0.6)) {
          stationaryCandidateAt = null
          stationaryCandidateCount = 0
          stationaryCandidateCoordinate = null
        }
        if (stationaryCandidateCoordinate == null) stationaryCandidateCoordinate = coordinate
      }
      if (stationaryCandidateAt == null) stationaryCandidateAt = timestampMillis
      stationaryCandidateCount += 1
      if (stationaryCandidateCount >= 3 && timestampMillis - stationaryCandidateAt!! >= (if (preciseStop) 1_500 else 2_500) &&
        state != MotionState.stationary) {
        val stoppedAt = stationaryCandidateAt!!
        state = MotionState.stationary
        stationaryCandidateAt = null
        stationaryCandidateCount = 0
        stationaryCandidateCoordinate = null
        return Transition(state, stoppedAt)
      }
      return null
    }
    stationaryCandidateAt = null
    stationaryCandidateCount = 0
    stationaryCandidateCoordinate = null
    val fastMovement = speedMetersPerSecond >= 0.7
    val slowMovement = speedMetersPerSecond >= 0.25 && displacementSincePreviousMeters >= 0.2
    if ((!fastMovement && !slowMovement) || state == MotionState.moving) {
      resetMovementCandidate()
      return null
    }
    if (movementCandidateAt == null) {
      movementCandidateAt = timestampMillis
      movementCandidateOrigin = previousPosition
    }
    movementCandidateCount += 1
    movementCandidateDistance += displacementSincePreviousMeters
    val duration = timestampMillis - movementCandidateAt!!
    val origin = movementCandidateOrigin
    val supported = if (state == MotionState.stationary && origin != null && coordinate != null) {
      val minimumDisplacement = if (motionActivityIsStationary) max(5.0, horizontalAccuracyMeters) else max(2.0, horizontalAccuracyMeters * 0.5)
      distanceMeters(origin, coordinate) >= minimumDisplacement
    } else true
    if ((fastMovement && movementCandidateCount >= 2 && duration >= 1_000 && supported) ||
      (slowMovement && movementCandidateCount >= 3 && duration >= 2_000 && movementCandidateDistance >= 0.75 && supported)) {
      val startedAt = movementCandidateAt!!
      state = MotionState.moving
      resetCandidates()
      return Transition(state, startedAt)
    }
    return null
  }

  private fun observeInvalidEvidence(timestampMillis: Long): Transition? {
    resetCandidates()
    if (state != MotionState.moving) {
      invalidEvidenceStartedAt = null
      return null
    }
    if (invalidEvidenceStartedAt == null) invalidEvidenceStartedAt = timestampMillis
    if (timestampMillis - invalidEvidenceStartedAt!! < 3_000) return null
    val unknownAt = invalidEvidenceStartedAt!!
    state = MotionState.unknown
    invalidEvidenceStartedAt = null
    return Transition(state, unknownAt)
  }

  private fun observePositionSpeed(speed: Double, windowStartedAt: Long, displacement: Double, timestamp: Long): Transition? {
    stationaryCandidateAt = null
    stationaryCandidateCount = 0
    if (state == MotionState.moving) return null
    if (movementCandidateAt == null) movementCandidateAt = windowStartedAt
    movementCandidateCount += 1
    movementCandidateDistance += displacement
    val duration = timestamp - movementCandidateAt!!
    if ((speed >= 0.7 && movementCandidateCount >= 2 && duration >= 1_000) ||
      (movementCandidateCount >= 3 && duration >= 2_000 && movementCandidateDistance >= 0.75)) {
      val startedAt = movementCandidateAt!!
      state = MotionState.moving
      resetCandidates()
      return Transition(state, startedAt)
    }
    return null
  }

  private fun resetCandidates() {
    stationaryCandidateAt = null
    stationaryCandidateCount = 0
    stationaryCandidateCoordinate = null
    resetMovementCandidate()
  }

  private fun resetMovementCandidate() {
    movementCandidateAt = null
    movementCandidateCount = 0
    movementCandidateDistance = 0.0
    movementCandidateOrigin = null
  }

  private fun distanceMeters(start: Coordinate, end: Coordinate): Double {
    val latitudeDelta = Math.toRadians(end.latitude - start.latitude)
    val longitudeDelta = Math.toRadians(end.longitude - start.longitude)
    val haversine = sin(latitudeDelta / 2).let { it * it } +
      cos(Math.toRadians(start.latitude)) * cos(Math.toRadians(end.latitude)) *
      sin(longitudeDelta / 2).let { it * it }
    return 2 * 6_371_000 * asin(min(1.0, sqrt(haversine)))
  }
}
