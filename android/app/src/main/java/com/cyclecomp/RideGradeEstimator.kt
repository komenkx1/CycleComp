package com.cyclecomp

internal class RideGradeEstimator {
  private data class Sample(val distanceMeters: Double, val elevationMeters: Double, val timestampMillis: Long)
  private val samples = mutableListOf<Sample>()
  private var currentSource: String? = null

  val measurementWindowMeters: Double?
    get() = if (samples.isEmpty()) null else samples.last().distanceMeters - samples.first().distanceMeters
  val measurementSampleCount: Int get() = samples.size

  fun update(
    distanceMeters: Double,
    elevationMeters: Double?,
    timestampMillis: Long,
    source: String?,
    isMoving: Boolean,
    gpsVerticalAccuracyMeters: Double? = null,
  ): Double? {
    val isBarometer = source?.startsWith("barometer:") == true
    val validGps = source == "gps" && gpsVerticalAccuracyMeters != null &&
      gpsVerticalAccuracyMeters.isFinite() && gpsVerticalAccuracyMeters > 0 && gpsVerticalAccuracyMeters <= 15
    if (!isMoving || elevationMeters == null || !elevationMeters.isFinite() || !distanceMeters.isFinite() ||
      (!isBarometer && !validGps)) {
      reset()
      return null
    }
    if (currentSource != source) {
      samples.clear()
      currentSource = source
    }
    val previousSample = samples.lastOrNull()
    if (previousSample != null && (timestampMillis <= previousSample.timestampMillis ||
        distanceMeters < previousSample.distanceMeters || timestampMillis - previousSample.timestampMillis > 5_000)) {
      samples.clear()
    }
    if (samples.lastOrNull()?.let { distanceMeters <= it.distanceMeters } == true) return null
    samples.add(Sample(distanceMeters, elevationMeters, timestampMillis))
    val targetWindowMeters = if (isBarometer) 60.0 else 100.0
    samples.removeAll { distanceMeters - it.distanceMeters > targetWindowMeters }
    return calculateGrade(
      minimumDistanceMeters = if (isBarometer) 20.0 else 60.0,
      minimumSampleCount = if (isBarometer) 6 else 8,
      minimumDurationMillis = if (isBarometer) 6_000 else 12_000,
    )
  }

  fun reset() {
    samples.clear()
    currentSource = null
  }

  private fun calculateGrade(minimumDistanceMeters: Double, minimumSampleCount: Int, minimumDurationMillis: Long): Double? {
    val first = samples.firstOrNull() ?: return null
    val last = samples.last()
    if (samples.size < minimumSampleCount || last.distanceMeters - first.distanceMeters < minimumDistanceMeters ||
      last.timestampMillis - first.timestampMillis < minimumDurationMillis) return null
    val meanDistance = samples.sumOf { it.distanceMeters } / samples.size
    val meanElevation = samples.sumOf { it.elevationMeters } / samples.size
    val covariance = samples.sumOf { (it.distanceMeters - meanDistance) * (it.elevationMeters - meanElevation) }
    val distanceVariance = samples.sumOf { (it.distanceMeters - meanDistance) * (it.distanceMeters - meanDistance) }
    return if (distanceVariance > 0) 100 * covariance / distanceVariance else null
  }
}
