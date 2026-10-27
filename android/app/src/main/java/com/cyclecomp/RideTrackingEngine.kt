package com.cyclecomp

import android.content.Context
import android.location.Location
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

internal object RideTrackingEngine {
  private const val preferencesName = "cyclecomp_ride_tracking"
  private const val activeRideKey = "active_ride"
  private var ride: Ride? = null
  private val ridePoints = mutableListOf<RidePoint>()
  private var accumulatedDistanceMeters = 0.0
  private var accumulatedMovingSeconds = 0.0
  private var accumulatedAscentMeters = 0.0
  private var accumulatedDescentMeters = 0.0
  private var lastCreditedElevationMeters: Double? = null
  private var totalPausedSeconds = 0.0
  private var totalAutoPausedSeconds = 0.0
  private var lastCheckpointAt = 0L
  private var stationarySinceMillis = 0L
  private var movingSinceMillis = 0L
  private var nextPointStartsSegment = true

  private data class Ride(
    val id: String,
    val startedAtMillis: Long,
    var status: String,
    var finishedAtMillis: Long? = null,
    var pausedAtMillis: Long? = null,
    var autoPaused: Boolean = false,
  )

  private data class RidePoint(
    val timestampMillis: Long,
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float,
    val verticalAccuracyMeters: Float?,
    val elevationMeters: Double?,
    val speedMetersPerSecond: Float?,
    val segmentStart: Boolean,
  )

  @Synchronized
  fun initialize(context: Context) {
    if (ride != null) return
    val savedRide = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
      .getString(activeRideKey, null) ?: return
    try {
      val savedState = JSONObject(savedRide)
      ride = Ride(
        id = savedState.getString("id"),
        startedAtMillis = savedState.getLong("startedAtMillis"),
        status = if (savedState.optString("status") == "paused") "paused" else "recoveryNeeded",
        finishedAtMillis = savedState.optLong("finishedAtMillis").takeIf { it > 0 },
        pausedAtMillis = System.currentTimeMillis(),
        autoPaused = savedState.optBoolean("autoPaused", false),
      )
      totalPausedSeconds = savedState.optDouble("totalPausedSeconds", 0.0)
      totalAutoPausedSeconds = savedState.optDouble("totalAutoPausedSeconds", 0.0)
      loadRidePoints(context)
      recalculateRideStatistics()
    } catch (_: Exception) {
      context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
        .edit().remove(activeRideKey).apply()
      ride = null
    }
  }

  @Synchronized
  fun snapshot(context: Context): Map<String, Any?> {
    initialize(context)
    val activeRide = ride ?: return baseSnapshot(context) + mapOf(
      "status" to "idle",
      "trackSegments" to emptyList<List<List<Double>>>(),
    )
    val now = System.currentTimeMillis()
    val rideClock = rideClock(activeRide, now)
    val lastPoint = ridePoints.lastOrNull()
    val firstRecordedElevation = ridePoints.firstNotNullOfOrNull { it.elevationMeters }
    val positionQuality = lastPoint?.accuracyMeters?.let { accuracyMeters ->
      when {
        accuracyMeters <= highAccuracyThresholdMeters -> "high"
        accuracyMeters <= mediumAccuracyThresholdMeters -> "medium"
        else -> "low"
      }
    } ?: "unavailable"
    return baseSnapshot(context) + mapOf(
      "status" to activeRide.status,
      "rideId" to activeRide.id,
      "startedAt" to isoTimestamp(activeRide.startedAtMillis),
      "finishedAt" to activeRide.finishedAtMillis?.let(::isoTimestamp),
      "elapsedSeconds" to ((now - activeRide.startedAtMillis) / 1000.0).coerceAtLeast(0.0),
      "timerSeconds" to rideClock,
      "durationSeconds" to rideClock,
      "durationUpdatedAt" to isoTimestamp(now),
      "movingSeconds" to accumulatedMovingSeconds,
      "manualPausedSeconds" to (totalPausedSeconds - totalAutoPausedSeconds +
        if (activeRide.status == "paused" && !activeRide.autoPaused && activeRide.pausedAtMillis != null) {
          (now - activeRide.pausedAtMillis!!) / 1000.0
        } else 0.0),
      "autoPausedSeconds" to (totalAutoPausedSeconds +
        if (activeRide.autoPaused && activeRide.pausedAtMillis != null) {
          (now - activeRide.pausedAtMillis!!) / 1000.0
        } else 0.0),
      "unknownMotionSeconds" to 0,
      "distanceMeters" to accumulatedDistanceMeters,
      "ascentMeters" to accumulatedAscentMeters,
      "descentMeters" to accumulatedDescentMeters,
      "elevationDataAvailable" to ridePoints.any { it.elevationMeters != null },
      "speedMetersPerSecond" to lastPoint?.speedMetersPerSecond,
      "speedSource" to lastPoint?.speedMetersPerSecond?.let { "gps" },
      "rawSpeedMetersPerSecond" to lastPoint?.speedMetersPerSecond,
      "elevationMeters" to lastPoint?.elevationMeters,
      "elevationSource" to lastPoint?.elevationMeters?.let { "gps" },
      "elevationAnchorQuality" to lastPoint?.elevationMeters?.let { "gps" },
      "relativeElevationMeters" to if (lastPoint?.elevationMeters != null && firstRecordedElevation != null) {
        lastPoint.elevationMeters - firstRecordedElevation
      } else null,
      "horizontalAccuracyMeters" to lastPoint?.accuracyMeters,
      "positionMatchQuality" to positionQuality,
      "lastFixAt" to lastPoint?.let { isoTimestamp(it.timestampMillis) },
      "lastCoordinate" to lastPoint?.let { listOf(it.longitude, it.latitude) },
      "autoPaused" to activeRide.autoPaused,
      "pointCount" to ridePoints.size,
      "trackSegments" to trackSegments(),
    )
  }

  @Synchronized
  fun start(context: Context): Map<String, Any?> {
    initialize(context)
    check(ride == null) { "Selesaikan atau pulihkan perjalanan yang sudah ada." }
    val now = System.currentTimeMillis()
    ride = Ride(UUID.randomUUID().toString(), now, "active")
    ridePoints.clear()
    accumulatedDistanceMeters = 0.0
    accumulatedMovingSeconds = 0.0
    accumulatedAscentMeters = 0.0
    accumulatedDescentMeters = 0.0
    lastCreditedElevationMeters = null
    totalPausedSeconds = 0.0
    totalAutoPausedSeconds = 0.0
    stationarySinceMillis = 0L
    movingSinceMillis = 0L
    nextPointStartsSegment = true
    val trackingDirectory = recordingDirectory(context)
    trackingDirectory.mkdirs()
    sampleFile(context, ride!!.id).writeText("")
    saveRide(context)
    return snapshot(context)
  }

  @Synchronized
  fun pause(context: Context, automatic: Boolean = false): Map<String, Any?> {
    val activeRide = requireActiveRide("active")
    val now = System.currentTimeMillis()
    activeRide.status = "paused"
    activeRide.autoPaused = automatic
    activeRide.pausedAtMillis = now
    stationarySinceMillis = 0L
    movingSinceMillis = 0L
    nextPointStartsSegment = true
    saveRide(context)
    return snapshot(context)
  }

  @Synchronized
  fun resume(context: Context): Map<String, Any?> {
    val activeRide = ride ?: error("Tidak ada perjalanan yang perlu dilanjutkan.")
    check(activeRide.status == "paused" || activeRide.status == "recoveryNeeded") {
      "Tidak ada perjalanan yang perlu dilanjutkan."
    }
    activeRide.pausedAtMillis?.let {
      val pausedSeconds = (System.currentTimeMillis() - it) / 1000.0
      totalPausedSeconds += pausedSeconds
      if (activeRide.autoPaused) totalAutoPausedSeconds += pausedSeconds
    }
    activeRide.pausedAtMillis = null
    activeRide.status = "active"
    activeRide.autoPaused = false
    stationarySinceMillis = 0L
    movingSinceMillis = 0L
    nextPointStartsSegment = true
    saveRide(context)
    return snapshot(context)
  }

  @Synchronized
  fun finish(context: Context): Map<String, Any?> {
    val activeRide = ride ?: error("Tidak ada perjalanan untuk diselesaikan.")
    val now = System.currentTimeMillis()
    activeRide.finishedAtMillis = now
    if (activeRide.status == "paused" || activeRide.status == "recoveryNeeded") {
      activeRide.pausedAtMillis?.let {
        val pausedSeconds = (now - it) / 1000.0
        totalPausedSeconds += pausedSeconds
        if (activeRide.autoPaused) totalAutoPausedSeconds += pausedSeconds
      }
      activeRide.pausedAtMillis = null
    }
    val finishedSnapshot = snapshot(context) + mapOf(
      "status" to "finished",
      "finishedAt" to isoTimestamp(now),
      "fileUrl" to if (ridePoints.isEmpty()) null else Uri.fromFile(exportGpx(context, activeRide, now)).toString(),
    )
    context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
      .edit().remove(activeRideKey).apply()
    sampleFile(context, activeRide.id).delete()
    ride = null
    ridePoints.clear()
    stationarySinceMillis = 0L
    movingSinceMillis = 0L
    return finishedSnapshot
  }

  @Synchronized
  fun onLocation(context: Context, location: Location): Map<String, Any?>? {
    initialize(context)
    val activeRide = ride?.takeIf {
      it.status == "active" || (it.status == "paused" && it.autoPaused)
    } ?: return null
    if (!location.latitude.isFinite() || !location.longitude.isFinite() ||
      location.accuracy < 0 || location.accuracy > maximumHorizontalAccuracyMeters) return null

    val previousPoint = ridePoints.lastOrNull()
    val elapsedSeconds = previousPoint?.let { (location.time - it.timestampMillis) / 1000.0 } ?: 0.0
    val movedMeters = previousPoint?.let {
      val previousLocation = Location("CycleComp").apply {
        latitude = it.latitude
        longitude = it.longitude
      }
      location.distanceTo(previousLocation).toDouble()
    } ?: 0.0
    val estimatedSpeed = if (elapsedSeconds > 0 && elapsedSeconds <= maximumDistanceCreditIntervalSeconds) {
      movedMeters / elapsedSeconds
    } else null
    val gpsSpeed = if (Build.VERSION.SDK_INT >= 26) {
      if (location.hasSpeed()) location.speed else null
    } else {
      location.speed.takeIf { it > 0 }
    }
    val acceptedSpeed: Double? = gpsSpeed?.toDouble()?.takeIf { it.isFinite() && it >= 0 }
      ?: estimatedSpeed?.takeIf { it.isFinite() }

    if (activeRide.status == "paused") {
      if ((acceptedSpeed ?: 0.0) >= autoResumeSpeedMetersPerSecond) {
        if (movingSinceMillis == 0L) movingSinceMillis = location.time
        if (location.time - movingSinceMillis < autoResumeDurationMillis) return null
        resume(context)
      } else {
        movingSinceMillis = 0L
        return null
      }
    }

    if (previousPoint != null && elapsedSeconds > 0 && elapsedSeconds <= maximumDistanceCreditIntervalSeconds &&
      movedMeters / elapsedSeconds <= maximumPlausibleSpeedMetersPerSecond &&
      (acceptedSpeed ?: 0.0) >= minimumDistanceCreditSpeedMetersPerSecond) {
      accumulatedDistanceMeters += movedMeters
    }
    if (previousPoint != null && elapsedSeconds in 0.0..movingIntervalLimitSeconds &&
      (previousPoint.speedMetersPerSecond ?: 0f) >= minimumMovingSpeedMetersPerSecond) {
      accumulatedMovingSeconds += elapsedSeconds
    }

    val ridePoint = RidePoint(
      timestampMillis = location.time,
      latitude = location.latitude,
      longitude = location.longitude,
      accuracyMeters = location.accuracy,
      verticalAccuracyMeters = if (Build.VERSION.SDK_INT >= 26 && location.hasVerticalAccuracy()) {
        location.verticalAccuracyMeters
      } else null,
      elevationMeters = acceptedGpsElevation(location),
      speedMetersPerSecond = acceptedSpeed?.toFloat(),
      segmentStart = nextPointStartsSegment || previousPoint == null,
    )
    ridePoints.add(ridePoint)
    nextPointStartsSegment = false
    updateElevationTotals(ridePoint)
    appendRidePoint(context, activeRide.id, ridePoint)
    if (preferences(context).getBoolean("auto_pause", false) &&
      (acceptedSpeed ?: autoPauseSpeedThresholdMetersPerSecond + 1) <= autoPauseSpeedThresholdMetersPerSecond) {
      if (stationarySinceMillis == 0L) stationarySinceMillis = location.time
      if (location.time - stationarySinceMillis >= autoPauseDurationMillis) pause(context, automatic = true)
    } else {
      stationarySinceMillis = 0L
    }
    if (System.currentTimeMillis() - lastCheckpointAt > 10_000) saveRide(context)
    return snapshot(context).filterKeys { it != "trackSegments" } + mapOf(
      "newCoordinate" to listOf(ridePoint.longitude, ridePoint.latitude),
      "newSegment" to ridePoint.segmentStart,
    )
  }

  @Synchronized
  fun elevationTrack(): List<List<Map<String, Any?>>> = ridePoints
    .fold(mutableListOf<MutableList<Map<String, Any?>>>() ) { segments, point ->
      if (point.segmentStart || segments.isEmpty()) segments.add(mutableListOf())
      segments.last().add(mapOf(
        "coordinate" to listOf(point.longitude, point.latitude),
        "elevationMeters" to point.elevationMeters,
      ))
      segments
    }

  @Synchronized
  fun baseSnapshot(context: Context): Map<String, Any?> = mapOf(
    "autoPauseEnabled" to preferences(context).getBoolean("auto_pause", false),
    "autoPaused" to false,
    "sensorDiagnosticsEnabled" to false,
    "sensorTraceStatus" to "off",
    "barometerStatus" to "unavailable",
    "motionSensorStatus" to "unavailable",
    "motionActivityStatus" to "unavailable",
    "terrainMatchStatus" to "noPack",
    "forwardPathQuality" to "unavailable",
    "profileQuality" to "unavailable",
    "terrainClimbStatus" to "unavailable",
    "watchHeartRateEnabled" to false,
    "watchHeartRateStatus" to "unavailable",
    "watchHeartRateMessage" to "Integrasi detak jantung jam belum tersedia di Android.",
  )

  @Synchronized
  fun setAutoPause(context: Context, enabled: Boolean): Map<String, Any?> {
    preferences(context).edit().putBoolean("auto_pause", enabled).apply()
    return snapshot(context)
  }

  @Synchronized
  fun setDiagnostics(context: Context, enabled: Boolean): Map<String, Any?> {
    check(ride == null) { "Ubah diagnostik sensor sebelum memulai perjalanan." }
    check(!enabled) { "Diagnostik sensor belum tersedia pada Android." }
    return snapshot(context)
  }

  @Synchronized
  fun setHeartRateEnabled(context: Context, enabled: Boolean): Map<String, Any?> {
    check(!enabled) { "Sensor detak jantung belum tersedia pada Android." }
    return snapshot(context)
  }

  @Synchronized
  fun listSavedRides(context: Context): List<Map<String, Any?>> = ridesDirectory(context)
    .listFiles { file -> file.isFile && file.extension.equals("gpx", ignoreCase = true) }
    .orEmpty()
    .sortedByDescending { it.lastModified() }
    .map { file ->
      val baseName = file.nameWithoutExtension
      mapOf(
        "id" to baseName.removePrefix("CycleComp-"),
        "fileName" to file.name,
        "fileUrl" to Uri.fromFile(file).toString(),
        "filePath" to file.absolutePath,
        "fileSizeBytes" to file.length(),
        "createdAt" to isoTimestamp(file.lastModified()),
        "hasSensorTrace" to File(file.parentFile, "$baseName-sensor.jsonl").exists(),
      )
    }

  @Synchronized
  fun readSavedRide(context: Context, fileUrl: String): String = savedRideFile(context, fileUrl).readText()

  @Synchronized
  fun deleteSavedRide(context: Context, fileUrl: String): Boolean {
    val file = savedRideFile(context, fileUrl)
    val traceFile = File(file.parentFile, "${file.nameWithoutExtension}-sensor.jsonl")
    traceFile.delete()
    return file.delete()
  }

  fun savedRideFile(context: Context, fileUrl: String): File {
    val file = File(Uri.parse(fileUrl).path ?: error("File GPX tidak valid.")).canonicalFile
    check(file.parentFile?.canonicalFile == ridesDirectory(context).canonicalFile && file.extension == "gpx") {
      "File GPX tidak ditemukan di penyimpanan CycleComp."
    }
    check(file.isFile) { "File GPX tidak ditemukan di penyimpanan CycleComp." }
    return file
  }

  private fun requireActiveRide(expectedStatus: String): Ride =
    ride?.takeIf { it.status == expectedStatus } ?: error("Tidak ada perjalanan aktif untuk dijeda.")

  private fun rideClock(activeRide: Ride, atMillis: Long): Double {
    val pauseStartedAt = activeRide.pausedAtMillis
    val currentPauseSeconds = if (pauseStartedAt != null) (atMillis - pauseStartedAt) / 1000.0 else 0.0
    return ((atMillis - activeRide.startedAtMillis) / 1000.0 - totalPausedSeconds - currentPauseSeconds)
      .coerceAtLeast(0.0)
  }

  private fun trackSegments(): List<List<List<Double>>> {
    val segments = mutableListOf<MutableList<List<Double>>>()
    ridePoints.forEach { point ->
      if (point.segmentStart || segments.isEmpty()) segments.add(mutableListOf())
      segments.last().add(listOf(point.longitude, point.latitude))
    }
    return segments
  }

  private fun loadRidePoints(context: Context) {
    ridePoints.clear()
    val activeRide = ride ?: return
    val file = sampleFile(context, activeRide.id)
    if (!file.exists()) return
    file.forEachLine { line ->
      try {
        val point = JSONObject(line)
        ridePoints.add(RidePoint(
          timestampMillis = point.getLong("timestampMillis"),
          latitude = point.getDouble("latitude"),
          longitude = point.getDouble("longitude"),
          accuracyMeters = point.optDouble("accuracyMeters", 0.0).toFloat(),
          verticalAccuracyMeters = point.optDouble("verticalAccuracyMeters")
            .takeIf { !point.isNull("verticalAccuracyMeters") }?.toFloat(),
          elevationMeters = point.optDouble("elevationMeters").takeIf { !point.isNull("elevationMeters") },
          speedMetersPerSecond = point.optDouble("speedMetersPerSecond").takeIf { !point.isNull("speedMetersPerSecond") }?.toFloat(),
          segmentStart = point.optBoolean("segmentStart"),
        ))
      } catch (_: Exception) { }
    }
  }

  private fun recalculateRideStatistics() {
    accumulatedDistanceMeters = 0.0
    accumulatedMovingSeconds = 0.0
    accumulatedAscentMeters = 0.0
    accumulatedDescentMeters = 0.0
    lastCreditedElevationMeters = null
    ridePoints.forEachIndexed { index, point ->
      updateElevationTotals(point)
      if (index == 0) return@forEachIndexed
      val previousPoint = ridePoints[index - 1]
      val previousLocation = Location("CycleComp").apply {
        latitude = previousPoint.latitude
        longitude = previousPoint.longitude
      }
      val distanceMeters = Location("CycleComp").apply {
        latitude = point.latitude
        longitude = point.longitude
      }.distanceTo(previousLocation).toDouble()
      val elapsedSeconds = (point.timestampMillis - previousPoint.timestampMillis) / 1000.0
      if (!point.segmentStart && elapsedSeconds > 0 && elapsedSeconds <= maximumDistanceCreditIntervalSeconds &&
        distanceMeters / elapsedSeconds <= maximumPlausibleSpeedMetersPerSecond &&
        (point.speedMetersPerSecond ?: 0f) >= minimumDistanceCreditSpeedMetersPerSecond) {
        accumulatedDistanceMeters += distanceMeters
      }
      if (elapsedSeconds in 0.0..movingIntervalLimitSeconds &&
        (previousPoint.speedMetersPerSecond ?: 0f) >= minimumMovingSpeedMetersPerSecond) {
        accumulatedMovingSeconds += elapsedSeconds
      }
    }
  }

  private fun appendRidePoint(context: Context, rideId: String, point: RidePoint) {
    val jsonPoint = JSONObject().apply {
      put("timestampMillis", point.timestampMillis)
      put("latitude", point.latitude)
      put("longitude", point.longitude)
      put("accuracyMeters", point.accuracyMeters.toDouble())
      put("verticalAccuracyMeters", point.verticalAccuracyMeters?.toDouble() ?: JSONObject.NULL)
      put("elevationMeters", point.elevationMeters ?: JSONObject.NULL)
      put("speedMetersPerSecond", point.speedMetersPerSecond?.toDouble() ?: JSONObject.NULL)
      put("segmentStart", point.segmentStart)
    }
    FileWriter(sampleFile(context, rideId), true).use { writer ->
      writer.append(jsonPoint.toString()).append('\n')
      writer.flush()
    }
  }

  private fun saveRide(context: Context) {
    val activeRide = ride ?: return
    val snapshot = JSONObject().apply {
      put("id", activeRide.id)
      put("startedAtMillis", activeRide.startedAtMillis)
      put("status", activeRide.status)
      put("finishedAtMillis", activeRide.finishedAtMillis ?: JSONObject.NULL)
      put("pausedAtMillis", activeRide.pausedAtMillis ?: JSONObject.NULL)
      put("totalPausedSeconds", totalPausedSeconds)
      put("totalAutoPausedSeconds", totalAutoPausedSeconds)
      put("autoPaused", activeRide.autoPaused)
    }
    preferences(context).edit().putString(activeRideKey, snapshot.toString()).apply()
    lastCheckpointAt = System.currentTimeMillis()
  }

  private fun exportGpx(context: Context, activeRide: Ride, finishedAt: Long): File {
    val output = File(ridesDirectory(context), "CycleComp-${activeRide.id}.gpx")
    output.parentFile?.mkdirs()
    val timerSeconds = rideClock(activeRide, finishedAt)
    val elapsedSeconds = (finishedAt - activeRide.startedAtMillis) / 1000.0
    val elevationQuality = if (ridePoints.any { it.elevationMeters != null }) "gps" else "unavailable"
    val trackTimeSpanSeconds = if (ridePoints.size > 1) {
      (ridePoints.last().timestampMillis - ridePoints.first().timestampMillis) / 1000.0
    } else 0.0
    output.bufferedWriter().use { writer ->
      writer.appendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")
      writer.appendLine("<gpx version=\"1.1\" creator=\"CycleComp\" xmlns=\"http://www.topografix.com/GPX/1/1\" xmlns:cyclecomp=\"https://mangwahyu.tech/cyclecomp/gpx/1\">")
      writer.appendLine("<metadata><time>${isoTimestamp(activeRide.startedAtMillis)}</time><extensions>")
      writer.appendLine(
        "<cyclecomp:activitySummary algorithmVersion=\"android-gps-v1\" " +
          "distanceMeters=\"$accumulatedDistanceMeters\" elapsedSeconds=\"$elapsedSeconds\" " +
          "timerSeconds=\"$timerSeconds\" movingSeconds=\"$accumulatedMovingSeconds\" " +
          "manualPausedSeconds=\"${totalPausedSeconds - totalAutoPausedSeconds}\" " +
          "autoPausedSeconds=\"$totalAutoPausedSeconds\" trackTimeSpanSeconds=\"$trackTimeSpanSeconds\" " +
          "ascentMeters=\"$accumulatedAscentMeters\" descentMeters=\"$accumulatedDescentMeters\" " +
          "elevationQuality=\"$elevationQuality\" />",
      )
      writer.appendLine("<cyclecomp:finishedAt>${isoTimestamp(finishedAt)}</cyclecomp:finishedAt>")
      writer.appendLine("</extensions></metadata>")
      writer.appendLine("<trk><name>CycleComp ride</name><type>cycling</type>")
      var segmentOpen = false
      ridePoints.forEach { point ->
        if (point.segmentStart) {
          if (segmentOpen) writer.appendLine("</trkseg>")
          writer.appendLine("<trkseg>")
          segmentOpen = true
        }
        writer.append("<trkpt lat=\"").append(point.latitude.toString())
          .append("\" lon=\"").append(point.longitude.toString()).append("\">")
        point.elevationMeters?.let { writer.append("<ele>").append(it.toString()).append("</ele>") }
        writer.append("<time>").append(isoTimestamp(point.timestampMillis)).append("</time></trkpt>\n")
      }
      if (segmentOpen) writer.appendLine("</trkseg>")
      writer.appendLine("</trk></gpx>")
    }
    output.setLastModified(finishedAt)
    return output
  }

  private fun recordingDirectory(context: Context) = File(context.filesDir, "RideTracking")
  private fun ridesDirectory(context: Context) = File(context.filesDir, "Rides")
  private fun sampleFile(context: Context, rideId: String) = File(recordingDirectory(context), "$rideId.jsonl")
  private fun preferences(context: Context) = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
  private fun isoTimestamp(timestampMillis: Long): String = SimpleDateFormat(
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    Locale.US,
  ).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(timestampMillis))

  private fun acceptedGpsElevation(location: Location): Double? {
    if (Build.VERSION.SDK_INT < 26 || !location.hasAltitude() || !location.hasVerticalAccuracy()) return null
    if (location.verticalAccuracyMeters > maximumVerticalAccuracyMeters || !location.altitude.isFinite()) return null
    return location.altitude
  }

  private fun updateElevationTotals(point: RidePoint) {
    val elevationMeters = point.elevationMeters ?: return
    if (point.segmentStart) {
      lastCreditedElevationMeters = elevationMeters
      return
    }
    val previousElevationMeters = lastCreditedElevationMeters ?: run {
      lastCreditedElevationMeters = elevationMeters
      return
    }
    val elevationChangeMeters = elevationMeters - previousElevationMeters
    if (elevationChangeMeters >= elevationChangeDeadbandMeters) {
      accumulatedAscentMeters += elevationChangeMeters
      lastCreditedElevationMeters = elevationMeters
    } else if (elevationChangeMeters <= -elevationChangeDeadbandMeters) {
      accumulatedDescentMeters -= elevationChangeMeters
      lastCreditedElevationMeters = elevationMeters
    }
  }

  private const val autoPauseSpeedThresholdMetersPerSecond = 0.5
  private const val autoPauseDurationMillis = 15_000L
  private const val autoResumeSpeedMetersPerSecond = 1.0
  private const val autoResumeDurationMillis = 3_000L
  private const val maximumHorizontalAccuracyMeters = 100f
  private const val maximumDistanceCreditIntervalSeconds = 30.0
  private const val maximumPlausibleSpeedMetersPerSecond = 40.0
  private const val minimumDistanceCreditSpeedMetersPerSecond = 0.25
  private const val movingIntervalLimitSeconds = 3.0
  private const val minimumMovingSpeedMetersPerSecond = 1f
  private const val maximumVerticalAccuracyMeters = 15f
  private const val elevationChangeDeadbandMeters = 3.0
  private const val highAccuracyThresholdMeters = 10f
  private const val mediumAccuracyThresholdMeters = 30f
}
