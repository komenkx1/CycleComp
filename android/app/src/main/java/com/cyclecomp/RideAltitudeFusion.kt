package com.cyclecomp

import kotlin.math.abs
import kotlin.math.exp

internal data class RideAltitudeReading(
  val elevationMeters: Double?,
  val elevationSource: String?,
  val relativeElevationMeters: Double?,
  val pressureKilopascals: Double?,
  val anchorQuality: String,
  val barometerEpoch: Int?,
)

/** GPS anchors pressure changes; an unanchored barometer never invents an absolute altitude. */
internal class RideAltitudeFusion {
  private data class PressureSample(val relativeAltitudeMeters: Double, val pressureKilopascals: Double, val timestampMillis: Long)
  private data class AnchorCandidate(val elevationMeters: Double, val timestampMillis: Long)

  var epoch = 0
    private set
  private var firstRelativeAltitudeMeters: Double? = null
  private var latestPressureSample: PressureSample? = null
  private var anchorMeters: Double? = null
  private var anchorIsCalibrated = false
  private val anchorCandidates = mutableListOf<AnchorCandidate>()
  private var lastAnchorGpsMillis: Long? = null
  private var lastAnchorCorrectionMillis: Long? = null

  @Synchronized
  fun startNewEpoch(retainingElevationMeters: Double? = null, isCalibrated: Boolean = false) {
    epoch += 1
    firstRelativeAltitudeMeters = null
    latestPressureSample = null
    anchorCandidates.clear()
    lastAnchorGpsMillis = null
    lastAnchorCorrectionMillis = null
    anchorMeters = retainingElevationMeters?.takeIf { isCalibrated && it.isFinite() }
    anchorIsCalibrated = anchorMeters != null
  }

  @Synchronized
  fun recordPressure(relativeAltitudeMeters: Double, pressureKilopascals: Double, timestampMillis: Long) {
    if (!relativeAltitudeMeters.isFinite() || !pressureKilopascals.isFinite() || pressureKilopascals <= 0) return
    if (latestPressureSample != null && timestampMillis <= latestPressureSample!!.timestampMillis) return
    if (firstRelativeAltitudeMeters == null) firstRelativeAltitudeMeters = relativeAltitudeMeters
    latestPressureSample = PressureSample(relativeAltitudeMeters, pressureKilopascals, timestampMillis)
  }

  @Synchronized
  fun reading(gpsElevationMeters: Double?, gpsVerticalAccuracyMeters: Double?, gpsTimestampMillis: Long): RideAltitudeReading {
    val validGpsElevation = gpsElevationMeters?.takeIf { it.isFinite() && it > -12_000 && it < 12_000 }
    val validGpsAccuracy = gpsVerticalAccuracyMeters?.takeIf { it.isFinite() && it > 0 && it <= 60 }
    val pairedPressure = latestPressureSample?.takeIf { abs(gpsTimestampMillis - it.timestampMillis) <= 2_000 }
    val relativeElevation = pairedPressure?.let { sample -> firstRelativeAltitudeMeters?.let { sample.relativeAltitudeMeters - it } }
    if (validGpsElevation != null && validGpsAccuracy != null && validGpsAccuracy <= 15 &&
      relativeElevation != null && (lastAnchorGpsMillis == null || gpsTimestampMillis > lastAnchorGpsMillis!!)) {
      val candidate = validGpsElevation - relativeElevation
      lastAnchorGpsMillis = gpsTimestampMillis
      anchorCandidates.removeAll { gpsTimestampMillis - it.timestampMillis > 30_000 }
      anchorCandidates.add(AnchorCandidate(candidate, gpsTimestampMillis))
      if (!anchorIsCalibrated && anchorCandidates.size >= 5 &&
        gpsTimestampMillis - anchorCandidates.first().timestampMillis >= 10_000) {
        val sorted = anchorCandidates.map { it.elevationMeters }.sorted()
        val middle = sorted.size / 2
        anchorMeters = if (sorted.size % 2 == 0) (sorted[middle - 1] + sorted[middle]) / 2 else sorted[middle]
        anchorIsCalibrated = true
        lastAnchorCorrectionMillis = gpsTimestampMillis
      } else if (anchorIsCalibrated && anchorMeters != null && abs(candidate - anchorMeters!!) <= 30) {
        val elapsedSeconds = (gpsTimestampMillis - (lastAnchorCorrectionMillis ?: gpsTimestampMillis)).coerceAtLeast(0) / 1000.0
        anchorMeters = anchorMeters!! + (candidate - anchorMeters!!) * (1 - exp(-elapsedSeconds / 180))
        lastAnchorCorrectionMillis = gpsTimestampMillis
      }
    }
    if (relativeElevation != null && anchorIsCalibrated && anchorMeters != null) {
      return RideAltitudeReading(anchorMeters!! + relativeElevation, "barometer_gps", relativeElevation,
        pairedPressure?.pressureKilopascals, "calibrated", epoch)
    }
    val fallback = validGpsElevation?.takeIf { validGpsAccuracy != null }
    return RideAltitudeReading(fallback, if (fallback == null) null else "gps", relativeElevation,
      pairedPressure?.pressureKilopascals,
      if (relativeElevation != null) { if (anchorIsCalibrated) "calibrated" else "unanchored" }
      else if (fallback == null) "unavailable" else "gps", if (pairedPressure == null) null else epoch)
  }
}
