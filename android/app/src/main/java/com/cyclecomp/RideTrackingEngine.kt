package com.cyclecomp

import android.content.Context
import android.content.Intent
import android.location.Location
import android.net.Uri
import android.os.Build
import android.system.Os
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
import java.io.FileWriter
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

internal object RideTrackingEngine {
  private const val preferencesName = "cyclecomp_ride_tracking"
  private const val activeRideKey = "active_ride"
  private var ride: Ride? = null
  private var recoveryError: String? = null
  private val sessionEvents = mutableListOf<RideSessionEvent>()
  private var hasMotionTimingEvents = false
  private val ridePoints = mutableListOf<RidePoint>()
  private var elevationDataAvailable = false
  private var accumulatedDistanceMeters = 0.0
  private var accumulatedMovingSeconds = 0.0
  private var accumulatedAscentMeters = 0.0
  private var accumulatedDescentMeters = 0.0
  private var lastCreditedElevationMeters: Double? = null
  private var lastCreditedElevationDistance = 0.0
  private var lastCreditedElevationSource: String? = null
  private val altitudeFusion = RideAltitudeFusion()
  private val sensorTrace = RideSensorTrace()
  private val heartRateRecorder = RideHeartRateRecorder()
  private var watchHeartRate: RealmeWatchHeartRate? = null
  private var phoneSensors: RidePhoneSensors? = null
  private var activityRecognition: RideActivityRecognition? = null
  private var sensorsRunning = false
  private val motionCoordinator = RideMotionCoordinator()
  private val speedSmoother = RideSpeedSmoother()
  private val gradeEstimator = RideGradeEstimator()
  private var lastMotionLocation: Location? = null
  private val pendingAutoPauseLocations = mutableListOf<Location>()
  private var displayedSpeed: Double? = null
  private var totalPausedSeconds = 0.0
  private var totalAutoPausedSeconds = 0.0
  private var lastCheckpointAt = 0L
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
    val elevationSource: String?,
    val elevationAnchorQuality: String?,
    val relativeElevationMeters: Double?,
    val barometerEpoch: Int?,
    val liveGradePercent: Double?,
    val liveGradeSource: String?,
    val liveGradeWindowMeters: Double?,
    val liveGradeSampleCount: Int?,
    val speedMetersPerSecond: Float?,
    val filteredSpeedMetersPerSecond: Double?,
    val speedSource: String?,
    val speedAccuracyMetersPerSecond: Float?,
    val courseDegrees: Float?,
    val barometricPressureKilopascals: Double?,
    val motionState: String?,
    val cumulativeDistanceMeters: Double?,
    val heartRateBpm: Int?,
    val heartRateRecordedAtMillis: Long?,
    val segmentStart: Boolean,
  )

  @Synchronized
  fun initialize(context: Context) {
    if (ride != null) return
    val savedRide = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
      .getString(activeRideKey, null) ?: return
    try {
      val savedState = JSONObject(savedRide)
      val savedStatus = savedState.optString("status")
      ride = Ride(
        id = savedState.getString("id"),
        startedAtMillis = savedState.getLong("startedAtMillis"),
        status = if (savedStatus == "paused") "paused" else "recoveryNeeded",
        finishedAtMillis = savedState.optLong("finishedAtMillis").takeIf { it > 0 },
        pausedAtMillis = savedState.optLong("pausedAtMillis").takeIf { it > 0 },
        autoPaused = savedState.optBoolean("autoPaused", false),
      )
      totalPausedSeconds = savedState.optDouble("totalPausedSeconds", 0.0)
      totalAutoPausedSeconds = savedState.optDouble("totalAutoPausedSeconds", 0.0)
      sessionEvents.clear()
      val savedEvents = savedState.optJSONArray("events")
      hasMotionTimingEvents = savedEvents != null
      if (savedEvents != null) {
        for (index in 0 until savedEvents.length()) {
          val event = savedEvents.getJSONObject(index)
          sessionEvents.add(RideSessionEvent(event.getString("kind"), event.getLong("effectiveAtMillis"), event.getLong("detectedAtMillis")))
        }
      }
      loadRidePoints(context)
      val recoveredRide = ride!!
      if (recoveredRide.pausedAtMillis == null) {
        recoveredRide.pausedAtMillis = (ridePoints.lastOrNull()?.timestampMillis ?: recoveredRide.startedAtMillis)
          .coerceIn(recoveredRide.startedAtMillis, System.currentTimeMillis())
      }
      nextPointStartsSegment = true
      recalculateRideStatistics()
      if (hasMotionTimingEvents && savedStatus != "paused") {
        appendSessionEvent("motion_unknown", recoveredRide.pausedAtMillis!!)
        appendSessionEvent("manual_paused", recoveredRide.pausedAtMillis!!)
      }
      if (File(recordingDirectory(context), "${recoveredRide.id}-hr.jsonl").isFile) {
        heartRateRecorder.open(recordingDirectory(context), recoveredRide.id)
      }
      recoveryError = null
    } catch (_: Exception) {
      ride = null
      recoveryError = "Checkpoint perjalanan tidak dapat dibaca. Data tersimpan dipertahankan."
    }
  }

  @Synchronized
  fun initializeWatch(context: Context) {
    if (preferences(context).getBoolean("watch_heart_rate", false)) {
      val watch = watchHeartRate ?: createWatch(context)
      if (!watch.enabled) watch.setEnabled(true)
    }
  }

  private fun createWatch(context: Context): RealmeWatchHeartRate {
    val appContext = context.applicationContext
    return RealmeWatchHeartRate(
      context = appContext,
      rideDurationSeconds = { (snapshot(appContext, includeTrack = false)["durationSeconds"] as? Number)?.toInt() ?: 0 },
      rideDistanceMeters = { (snapshot(appContext, includeTrack = false)["distanceMeters"] as? Number)?.toInt() ?: 0 },
      onChange = {
        val currentRide = snapshot(appContext, includeTrack = false)
        appContext.sendBroadcast(Intent(RideTrackingService.actionSnapshot).setPackage(appContext.packageName)
          .putExtra("snapshot", JSONObject(currentRide).toString()))
      },
      onSample = { bpm, timestamp -> recordHeartRate(appContext, bpm, timestamp) },
    ).also { watchHeartRate = it }
  }

  @Synchronized
  private fun recordHeartRate(context: Context, bpm: Int, timestampMillis: Long) {
    if (ride?.status != "active") return
    try {
      heartRateRecorder.append(bpm, timestampMillis)
    } catch (_: Exception) {
      context.sendBroadcast(Intent(RideTrackingService.actionError).setPackage(context.packageName)
        .putExtra("message", "Sampel HR tidak dapat disimpan. Rekaman GPS tetap berjalan."))
    }
  }

  @Synchronized
  fun startSensors(context: Context) {
    initialize(context)
    val activeRide = ride?.takeIf { it.status == "active" || (it.status == "paused" && it.autoPaused) } ?: return
    if (sensorsRunning) return
    if (preferences(context).getBoolean("sensor_diagnostics", false) && sensorTrace.file == null) {
      sensorTrace.open(activeRide.id, ridesDirectory(context))
      sensorTrace.append("session", JSONObject().put("reason", "recorder_recovered"))
    }
    val sensors = phoneSensors ?: RidePhoneSensors(context.applicationContext, altitudeFusion).also { phoneSensors = it }
    val lastPoint = ridePoints.lastOrNull()
    sensors.start(lastPoint?.elevationMeters, lastPoint?.elevationSource == "barometer_gps" &&
      lastPoint.elevationAnchorQuality == "calibrated")
    val activity = activityRecognition ?: RideActivityRecognition(context.applicationContext).also { activityRecognition = it }
    activity.start()
    sensorsRunning = true
  }

  @Synchronized
  fun stopSensors() {
    if (sensorsRunning) phoneSensors?.stop()
    if (sensorsRunning) activityRecognition?.stop()
    sensorsRunning = false
    sensorTrace.synchronize()
  }

  @Synchronized
  fun onActivityRecognition(context: Context, stillConfidence: Int, timestampMillis: Long) {
    initialize(context)
    val activeRide = ride ?: return
    if (!sensorsRunning || (activeRide.status != "active" && !(activeRide.status == "paused" && activeRide.autoPaused))) return
    val ageMillis = System.currentTimeMillis() - timestampMillis
    if (ageMillis !in -1_000L..30_000L) return
    activityRecognition?.update(stillConfidence, timestampMillis)
  }

  @Synchronized
  fun snapshot(context: Context, includeTrack: Boolean = true): Map<String, Any?> {
    initialize(context)
    val activeRide = ride ?: return baseSnapshot(context) + mapOf(
      "status" to if (recoveryError == null) "idle" else "recoveryNeeded",
      "recordingErrorMessage" to recoveryError,
    ) + if (includeTrack) mapOf("trackSegments" to emptyList<List<List<Double>>>()) else emptyMap()
    val now = System.currentTimeMillis()
    val rideClock = rideClock(activeRide, now)
    val lastPoint = ridePoints.lastOrNull()
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
      "movingSeconds" to movingSeconds(activeRide, now),
      "manualPausedSeconds" to (totalPausedSeconds - totalAutoPausedSeconds +
        if (activeRide.status == "paused" && !activeRide.autoPaused && activeRide.pausedAtMillis != null) {
          (now - activeRide.pausedAtMillis!!) / 1000.0
        } else 0.0),
      "autoPausedSeconds" to (totalAutoPausedSeconds +
        if (activeRide.autoPaused && activeRide.pausedAtMillis != null) {
          (now - activeRide.pausedAtMillis!!) / 1000.0
        } else 0.0),
      "unknownMotionSeconds" to unknownMotionSeconds(activeRide, now),
      "distanceMeters" to accumulatedDistanceMeters,
      "ascentMeters" to accumulatedAscentMeters,
      "descentMeters" to accumulatedDescentMeters,
      "elevationDataAvailable" to elevationDataAvailable,
      "speedMetersPerSecond" to displayedSpeed,
      "speedSource" to lastPoint?.speedSource,
      "rawSpeedMetersPerSecond" to lastPoint?.speedMetersPerSecond,
      "speedAccuracyMetersPerSecond" to lastPoint?.speedAccuracyMetersPerSecond,
      "speedLowerBoundMetersPerSecond" to lastPoint?.speedMetersPerSecond?.let { speed ->
        lastPoint.speedAccuracyMetersPerSecond?.let { accuracy -> (speed - accuracy).coerceAtLeast(0f) }
      },
      "speedUpperBoundMetersPerSecond" to lastPoint?.speedMetersPerSecond?.let { speed ->
        lastPoint.speedAccuracyMetersPerSecond?.let { accuracy -> speed + accuracy }
      },
      "courseDegrees" to lastPoint?.courseDegrees,
      "elevationMeters" to lastPoint?.elevationMeters,
      "elevationSource" to lastPoint?.elevationSource,
      "elevationAnchorQuality" to lastPoint?.elevationAnchorQuality,
      "relativeElevationMeters" to lastPoint?.relativeElevationMeters,
      "liveGradePercent" to lastPoint?.liveGradePercent?.takeIf { motionCoordinator.state == RideAutoPausePolicy.MotionState.moving },
      "liveGradeSource" to lastPoint?.liveGradeSource?.takeIf { motionCoordinator.state == RideAutoPausePolicy.MotionState.moving },
      "liveGradeQuality" to lastPoint?.liveGradeSource?.takeIf { motionCoordinator.state == RideAutoPausePolicy.MotionState.moving }
        ?.let { if (it == "gps") "gps_vertical" else "barometer_relative" },
      "liveGradeWindowMeters" to lastPoint?.liveGradeWindowMeters?.takeIf { motionCoordinator.state == RideAutoPausePolicy.MotionState.moving },
      "liveGradeSampleCount" to lastPoint?.liveGradeSampleCount?.takeIf { motionCoordinator.state == RideAutoPausePolicy.MotionState.moving },
      "liveGradeUpdatedAt" to lastPoint?.takeIf { it.liveGradePercent != null && motionCoordinator.state == RideAutoPausePolicy.MotionState.moving }
        ?.let { isoTimestamp(it.timestampMillis) },
      "horizontalAccuracyMeters" to lastPoint?.accuracyMeters,
      "positionMatchQuality" to positionQuality,
      "lastFixAt" to lastPoint?.let { isoTimestamp(it.timestampMillis) },
      "lastCoordinate" to lastPoint?.let { listOf(it.longitude, it.latitude) },
      "autoPaused" to activeRide.autoPaused,
      "pointCount" to ridePoints.size,
    ) + if (includeTrack) mapOf("trackSegments" to trackSegments()) else emptyMap()
  }

  @Synchronized
  fun start(context: Context): Map<String, Any?> {
    initialize(context)
    check(recoveryError == null) { recoveryError ?: "Checkpoint perjalanan tidak dapat dibaca." }
    check(ride == null) { "Selesaikan atau pulihkan perjalanan yang sudah ada." }
    val now = System.currentTimeMillis()
    val rideId = UUID.randomUUID().toString()
    heartRateRecorder.clear()
    if (preferences(context).getBoolean("watch_heart_rate", false)) {
      heartRateRecorder.open(recordingDirectory(context), rideId)
    }
    ride = Ride(rideId, now, "active")
    sessionEvents.clear()
    hasMotionTimingEvents = true
    ridePoints.clear()
    resetMotionMeasurements()
    elevationDataAvailable = false
    accumulatedDistanceMeters = 0.0
    accumulatedMovingSeconds = 0.0
    accumulatedAscentMeters = 0.0
    accumulatedDescentMeters = 0.0
    lastCreditedElevationMeters = null
    lastCreditedElevationSource = null
    lastCreditedElevationDistance = 0.0
    totalPausedSeconds = 0.0
    totalAutoPausedSeconds = 0.0
    pendingAutoPauseLocations.clear()
    nextPointStartsSegment = true
    val trackingDirectory = recordingDirectory(context)
    trackingDirectory.mkdirs()
    sampleFile(context, ride!!.id).writeText("")
    sensorTrace.clear()
    if (preferences(context).getBoolean("sensor_diagnostics", false)) {
      sensorTrace.open(ride!!.id, ridesDirectory(context))
      sensorTrace.append("session", JSONObject().put("reason", "started"))
    }
    saveRide(context)
    watchHeartRate?.startRide()
    return snapshot(context)
  }

  @Synchronized
  fun pause(context: Context, automatic: Boolean = false): Map<String, Any?> {
    val activeRide = requireActiveRide("active")
    val now = System.currentTimeMillis()
    if (!automatic) endMotionEvidence(now, sessionEvents)
    appendSessionEvent(if (automatic) "auto_paused" else "manual_paused", now)
    activeRide.status = "paused"
    activeRide.autoPaused = automatic
    activeRide.pausedAtMillis = now
    sensorTrace.append("session", JSONObject().put("reason", if (automatic) "auto_paused" else "manual_paused"))
    if (!automatic) stopSensors()
    watchHeartRate?.pauseRide()
    if (!automatic) {
      resetMotionMeasurements()
      pendingAutoPauseLocations.clear()
    } else {
      speedSmoother.reset()
      sensorTrace.append("speedReset", JSONObject().put("reason", "auto_pause"))
      gradeEstimator.reset()
    }
    nextPointStartsSegment = true
    saveRide(context)
    return snapshot(context)
  }

  @Synchronized
  fun resume(context: Context, automatic: Boolean = false): Map<String, Any?> {
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
    appendSessionEvent("resumed", System.currentTimeMillis())
    if (preferences(context).getBoolean("watch_heart_rate", false)) {
      heartRateRecorder.open(recordingDirectory(context), activeRide.id)
      initializeWatch(context)
      watchHeartRate?.resumeRide()
    }
    if (!automatic) {
      resetMotionMeasurements()
      pendingAutoPauseLocations.clear()
    }
    sensorTrace.append("session", JSONObject().put("reason", "resumed"))
    nextPointStartsSegment = true
    saveRide(context)
    return snapshot(context)
  }

  @Synchronized
  fun finish(context: Context): Map<String, Any?> {
    val activeRide = ride ?: error("Tidak ada perjalanan untuk diselesaikan.")
    val now = System.currentTimeMillis()
    val finalPauseSeconds = activeRide.pausedAtMillis?.let { ((now - it) / 1000.0).coerceAtLeast(0.0) } ?: 0.0
    val finalTotalPausedSeconds = totalPausedSeconds + finalPauseSeconds
    val finalTotalAutoPausedSeconds = totalAutoPausedSeconds + if (activeRide.autoPaused) finalPauseSeconds else 0.0
    val finishedRide = activeRide.copy(finishedAtMillis = now, pausedAtMillis = null)
    val finalEvents = sessionEvents.toMutableList()
    endMotionEvidence(now, finalEvents)
    finalEvents.add(RideSessionEvent("finished", now, now))
    val exportedFile = if (ridePoints.isEmpty()) null else exportGpx(
      context, finishedRide, now, finalTotalPausedSeconds, finalTotalAutoPausedSeconds, finalEvents,
    )
    val savedHeartRate = try {
      heartRateRecorder.exportTo(ridesDirectory(context))
    } catch (error: Exception) {
      if (activeRide.status == "active" && preferences(context).getBoolean("watch_heart_rate", false)) {
        runCatching { heartRateRecorder.open(recordingDirectory(context), activeRide.id) }
      }
      throw error
    }
    stopSensors()
    watchHeartRate?.finishRide()
    sensorTrace.append("session", JSONObject().put("reason", "finished"))
    sensorTrace.close()
    val finishedSnapshot = snapshot(context) + mapOf(
      "status" to "finished",
      "finishedAt" to isoTimestamp(now),
      "timerSeconds" to rideClock(finishedRide, now, finalTotalPausedSeconds),
      "durationSeconds" to rideClock(finishedRide, now, finalTotalPausedSeconds),
      "manualPausedSeconds" to finalTotalPausedSeconds - finalTotalAutoPausedSeconds,
      "autoPausedSeconds" to finalTotalAutoPausedSeconds,
      "movingSeconds" to movingSeconds(finishedRide, now, finalEvents),
      "unknownMotionSeconds" to unknownMotionSeconds(finishedRide, now, finalEvents, finalTotalPausedSeconds),
      "fileUrl" to exportedFile?.let { Uri.fromFile(it).toString() },
      "sensorTraceFileUrl" to sensorTrace.file?.takeIf { it.isFile }?.let { Uri.fromFile(it).toString() },
      "heartRateFileUrl" to savedHeartRate?.let { Uri.fromFile(it).toString() },
    )
    context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
      .edit().remove(activeRideKey).apply()
    sampleFile(context, activeRide.id).delete()
    File(recordingDirectory(context), "${activeRide.id}-hr.jsonl").delete()
    heartRateRecorder.clear()
    ride = null
    ridePoints.clear()
    pendingAutoPauseLocations.clear()
    return finishedSnapshot
  }

  @Synchronized
  fun onLocation(context: Context, location: Location, replayingBuffered: Boolean = false): Map<String, Any?>? {
    initialize(context)
    val activeRide = ride?.takeIf {
      it.status == "active" || (it.status == "paused" && it.autoPaused)
    } ?: return null
    val now = System.currentTimeMillis()
    if (!location.latitude.isFinite() || location.latitude !in -90.0..90.0 ||
      !location.longitude.isFinite() || location.longitude !in -180.0..180.0 ||
      !location.hasAccuracy() || !location.accuracy.isFinite() ||
      location.accuracy < 0 || location.accuracy > maximumHorizontalAccuracyMeters) {
      sensorTrace.append("locationRejected", JSONObject().put("reason", "recording_quality"))
      return null
    }
    if (location.time < activeRide.startedAtMillis || location.time > now ||
      now - location.time > if (replayingBuffered) 5_000 else 3_000) {
      sensorTrace.append("locationRejected", JSONObject().put("reason", when {
        location.time < activeRide.startedAtMillis -> "outside_ride_window"
        location.time > now -> "future_fix"
        else -> "stale_fix"
      }))
      return null
    }

    val previousPoint = ridePoints.lastOrNull()
    if (previousPoint != null && location.time <= previousPoint.timestampMillis) {
      sensorTrace.append("locationRejected", JSONObject().put("reason", "recording_out_of_order"))
      return null
    }
    val elapsedSeconds = previousPoint?.let { (location.time - it.timestampMillis) / 1000.0 } ?: 0.0
    val movedMeters = previousPoint?.let {
      val previousLocation = Location("CycleComp").apply {
        latitude = it.latitude
        longitude = it.longitude
      }
      location.distanceTo(previousLocation).toDouble()
    } ?: 0.0
    val gpsSpeed = if (Build.VERSION.SDK_INT >= 26) {
      if (location.hasSpeed()) location.speed else null
    } else {
      location.speed.takeIf { it > 0 }
    }
    val gpsSpeedAccuracy = if (Build.VERSION.SDK_INT >= 26 && location.hasSpeedAccuracy()) {
      location.speedAccuracyMetersPerSecond.takeIf { it.isFinite() && it >= 0f }
    } else null
    if (!replayingBuffered) {
      val previousMotionLocation = lastMotionLocation
      val displacement = previousMotionLocation?.distanceTo(location)?.toDouble() ?: 0.0
      val transition = motionCoordinator.observe(RideMotionCoordinator.Sample(
        location.latitude, location.longitude, location.accuracy.toDouble(), gpsSpeed?.toDouble(),
        if (Build.VERSION.SDK_INT >= 26 && location.hasSpeedAccuracy()) location.speedAccuracyMetersPerSecond.toDouble() else null,
        displacement, location.time, activityRecognition?.isStationary(location.time) == true,
      ))
      val observation = motionCoordinator.lastObservation
      if (observation == null) sensorTrace.append("locationBaseline") else appendMotionTrace(observation)
      if (transition != null) {
        val eventKind = when (transition.state) {
          RideAutoPausePolicy.MotionState.moving -> "motion_started"
          RideAutoPausePolicy.MotionState.stationary -> "motion_stopped"
          RideAutoPausePolicy.MotionState.unknown -> "motion_unknown"
        }
        if (transition.state == RideAutoPausePolicy.MotionState.moving && activeRide.status == "active") {
          backfillConfirmedDistance(transition.effectiveAtMillis)
        }
        appendSessionEvent(eventKind, transition.effectiveAtMillis)
        saveRide(context)
      }
      lastMotionLocation = Location(location)
      val autoPauseEnabled = preferences(context).getBoolean("auto_pause", false)
      if (activeRide.status == "paused" && activeRide.autoPaused) {
        pendingAutoPauseLocations.add(Location(location))
        pendingAutoPauseLocations.removeAll { location.time - it.time > 5_000 }
        if (autoPauseEnabled && transition?.state == RideAutoPausePolicy.MotionState.moving) {
          val movingLocations = pendingAutoPauseLocations.filter { it.time >= transition.effectiveAtMillis }
          pendingAutoPauseLocations.clear()
          resume(context, automatic = true)
          movingLocations.forEach { onLocation(context, it, replayingBuffered = true) }
          return snapshot(context)
        }
        return null
      }
      if (transition?.state == RideAutoPausePolicy.MotionState.unknown) {
        nextPointStartsSegment = true
        gradeEstimator.reset()
      }
      if (autoPauseEnabled && transition?.state == RideAutoPausePolicy.MotionState.stationary) {
        pause(context, automatic = true)
        pendingAutoPauseLocations.add(Location(location))
        return snapshot(context, includeTrack = false)
      }
    }

    val rawGpsSpeed = gpsSpeed?.takeIf { it.isFinite() && it in 0f..maximumPlausibleSpeedMetersPerSecond.toFloat() }
    val validSpeedAccuracy = gpsSpeedAccuracy?.takeIf { it <= 4f }
    val measuredGpsSpeed = rawGpsSpeed?.takeIf { validSpeedAccuracy != null }?.toDouble()
    val positionSpeed = motionCoordinator.takePositionSpeed(location.time)?.speedMetersPerSecond
    val acceptedSpeed = measuredGpsSpeed ?: positionSpeed
    if (!nextPointStartsSegment && previousPoint != null && elapsedSeconds > 0 &&
      (elapsedSeconds > maximumDistanceCreditIntervalSeconds || movedMeters / elapsedSeconds > maximumPlausibleSpeedMetersPerSecond)) {
      nextPointStartsSegment = true
    }
    val distanceBeforeLocation = accumulatedDistanceMeters
    val movingSecondsBeforeLocation = accumulatedMovingSeconds
    if (!nextPointStartsSegment && previousPoint != null && elapsedSeconds > 0 && elapsedSeconds <= maximumDistanceCreditIntervalSeconds &&
      movedMeters / elapsedSeconds <= maximumPlausibleSpeedMetersPerSecond &&
      (acceptedSpeed ?: 0.0) >= minimumDistanceCreditSpeedMetersPerSecond &&
      (!hasMotionTimingEvents || motionCoordinator.state == RideAutoPausePolicy.MotionState.moving)) {
      accumulatedDistanceMeters += movedMeters
    }
    if (!nextPointStartsSegment && previousPoint != null && elapsedSeconds in 0.0..movingIntervalLimitSeconds &&
      (previousPoint.speedMetersPerSecond ?: 0f) >= minimumMovingSpeedMetersPerSecond) {
      accumulatedMovingSeconds += elapsedSeconds
    }

    val gpsElevation = if (location.hasAltitude()) location.altitude else null
    val verticalAccuracy = if (Build.VERSION.SDK_INT >= 26 && location.hasVerticalAccuracy()) {
      location.verticalAccuracyMeters.takeIf { it.isFinite() && it > 0 }
    } else null
    val altitude = altitudeFusion.reading(gpsElevation, verticalAccuracy?.toDouble(), location.time)
    if (nextPointStartsSegment) gradeEstimator.reset()
    val gradeSource = when {
      altitude.relativeElevationMeters != null -> "barometer:${altitude.barometerEpoch}"
      altitude.elevationSource == "gps" -> "gps"
      else -> null
    }
    val liveGrade = gradeEstimator.update(accumulatedDistanceMeters,
      altitude.relativeElevationMeters ?: altitude.elevationMeters, location.time, gradeSource,
      motionCoordinator.state == RideAutoPausePolicy.MotionState.moving, verticalAccuracy?.toDouble())
    displayedSpeed = speedSmoother.update(acceptedSpeed, location.time,
      motionCoordinator.state == RideAutoPausePolicy.MotionState.stationary)
    val stationary = motionCoordinator.state == RideAutoPausePolicy.MotionState.stationary
    val speedSource = when {
      stationary && displayedSpeed != null -> "stationary"
      acceptedSpeed == null && displayedSpeed != null -> "held"
      acceptedSpeed == null -> null
      measuredGpsSpeed != null -> "gps"
      else -> "position"
    }
    sensorTrace.append("speed", JSONObject().put("speed", JSONObject().apply {
      put("timestamp", location.time / 1000.0)
      put("measuredSpeedMetersPerSecond", acceptedSpeed ?: JSONObject.NULL)
      put("stationary", stationary)
      put("filteredSpeedMetersPerSecond", displayedSpeed ?: JSONObject.NULL)
      put("speedSource", speedSource ?: JSONObject.NULL)
    }))
    val motionSummary = phoneSensors?.motionSummary(location.time)
    sensorTrace.append("location", JSONObject().put("location", JSONObject().apply {
      put("timestamp", location.time / 1000.0)
      put("latitude", location.latitude)
      put("longitude", location.longitude)
      put("horizontalAccuracyMeters", location.accuracy.toDouble())
      put("verticalAccuracyMeters", verticalAccuracy?.toDouble() ?: -1.0)
      put("gpsElevationMeters", gpsElevation?.takeIf { it.isFinite() } ?: 0.0)
      put("speedMetersPerSecond", gpsSpeed?.takeIf { it.isFinite() }?.toDouble() ?: -1.0)
      put("speedAccuracyMetersPerSecond", if (Build.VERSION.SDK_INT >= 26 && location.hasSpeedAccuracy() && location.speedAccuracyMetersPerSecond.isFinite()) location.speedAccuracyMetersPerSecond.toDouble() else -1.0)
      put("barometerStatus", phoneSensors?.barometerStatus ?: "unavailable")
      put("motionActivityStatus", activityRecognition?.status ?: "unavailable")
      put("motionActivityIsStationary", activityRecognition?.isStationary(location.time) == true)
      put("motionActivityConfidence", activityRecognition?.takeIf { it.status == "active" }?.confidence?.let {
        when { it >= 75 -> "high"; it >= 50 -> "medium"; else -> "low" }
      } ?: JSONObject.NULL)
      put("motionActivityObservedAt", activityRecognition?.observedAtMillis?.div(1000.0) ?: JSONObject.NULL)
      put("accelerationRmsG", motionSummary?.get("motionAccelerationRmsG") ?: JSONObject.NULL)
      put("rotationRmsRadiansPerSecond", motionSummary?.get("motionRotationRmsRadiansPerSecond") ?: JSONObject.NULL)
    }))
    val ridePoint = RidePoint(
      timestampMillis = location.time,
      latitude = location.latitude,
      longitude = location.longitude,
      accuracyMeters = location.accuracy,
      verticalAccuracyMeters = verticalAccuracy,
      elevationMeters = altitude.elevationMeters,
      elevationSource = altitude.elevationSource,
      elevationAnchorQuality = altitude.anchorQuality,
      relativeElevationMeters = altitude.relativeElevationMeters,
      barometerEpoch = altitude.barometerEpoch,
      liveGradePercent = liveGrade,
      liveGradeSource = if (liveGrade == null) null else if (gradeSource == "gps") "gps" else "barometer",
      liveGradeWindowMeters = if (liveGrade == null) null else gradeEstimator.measurementWindowMeters,
      liveGradeSampleCount = if (liveGrade == null) null else gradeEstimator.measurementSampleCount,
      speedMetersPerSecond = rawGpsSpeed,
      filteredSpeedMetersPerSecond = displayedSpeed,
      speedSource = speedSource,
      speedAccuracyMetersPerSecond = validSpeedAccuracy,
      courseDegrees = if (location.hasBearing()) location.bearing.takeIf { it.isFinite() && it >= 0f } else null,
      barometricPressureKilopascals = altitude.pressureKilopascals,
      motionState = motionCoordinator.state.name,
      cumulativeDistanceMeters = accumulatedDistanceMeters,
      heartRateBpm = watchHeartRate?.lastSampleAt?.takeIf { location.time - it in 0L..15_000L }
        ?.let { watchHeartRate?.currentHeartRate },
      heartRateRecordedAtMillis = watchHeartRate?.lastSampleAt?.takeIf {
        location.time - it in 0L..15_000L && watchHeartRate?.currentHeartRate != null
      },
      segmentStart = nextPointStartsSegment || previousPoint == null,
    )
    try {
      appendRidePoint(context, activeRide.id, ridePoint)
    } catch (error: Exception) {
      accumulatedDistanceMeters = distanceBeforeLocation
      accumulatedMovingSeconds = movingSecondsBeforeLocation
      pause(context)
      throw error
    }
    ridePoints.add(ridePoint)
    if (ridePoint.elevationMeters != null) elevationDataAvailable = true
    nextPointStartsSegment = false
    updateElevationTotals(ridePoint)
    if (System.currentTimeMillis() - lastCheckpointAt > 10_000) saveRide(context)
    return snapshot(context, includeTrack = false) + mapOf(
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
    "sensorDiagnosticsEnabled" to preferences(context).getBoolean("sensor_diagnostics", false),
    "sensorTraceStatus" to sensorTrace.status,
    "barometerStatus" to (phoneSensors?.barometerStatus ?: "unavailable"),
    "motionSensorStatus" to (phoneSensors?.motionSensorStatus ?: "unavailable"),
    "motionActivityStatus" to (activityRecognition?.status ?: "unavailable"),
    "motionActivityStationary" to (activityRecognition?.isStationary(System.currentTimeMillis()) == true),
    "terrainMatchStatus" to "noPack",
    "forwardPathQuality" to "unavailable",
    "profileQuality" to "unavailable",
    "terrainClimbStatus" to "unavailable",
    "watchHeartRateEnabled" to preferences(context).getBoolean("watch_heart_rate", false),
    "watchHeartRateStatus" to (watchHeartRate?.status ?: "off"),
    "watchHeartRateMessage" to watchHeartRate?.message,
    "heartRateBpm" to watchHeartRate?.currentHeartRate,
    "heartRateRecordedAt" to watchHeartRate?.lastSampleAt?.let(::isoTimestamp),
  ) + (phoneSensors?.motionSummary() ?: emptyMap())

  @Synchronized
  fun setAutoPause(context: Context, enabled: Boolean): Map<String, Any?> {
    preferences(context).edit().putBoolean("auto_pause", enabled).apply()
    return snapshot(context)
  }

  @Synchronized
  fun setDiagnostics(context: Context, enabled: Boolean): Map<String, Any?> {
    check(ride == null) { "Ubah diagnostik sensor sebelum memulai perjalanan." }
    preferences(context).edit().putBoolean("sensor_diagnostics", enabled).apply()
    return snapshot(context)
  }

  @Synchronized
  fun setHeartRateEnabled(context: Context, enabled: Boolean): Map<String, Any?> {
    check(ride == null && recoveryError == null && watchHeartRate?.status != "stopping") {
      "Ubah koneksi jam sebelum memulai perjalanan."
    }
    val watch = watchHeartRate ?: createWatch(context)
    preferences(context).edit().putBoolean("watch_heart_rate", enabled).apply()
    watch.setEnabled(enabled)
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
    File(file.parentFile, "${file.nameWithoutExtension}-hr.jsonl").delete()
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

  fun savedSensorTraceFile(context: Context, fileUrl: String): File {
    val requestedFile = File(Uri.parse(fileUrl).path ?: error("File diagnostik tidak valid."))
    val traceFile = if (requestedFile.extension.equals("gpx", ignoreCase = true)) {
      val rideFile = savedRideFile(context, fileUrl)
      File(rideFile.parentFile, "${rideFile.nameWithoutExtension}-sensor.jsonl")
    } else requestedFile
    return RideSensorTrace.savedTraceFile(ridesDirectory(context), traceFile)
  }

  private fun requireActiveRide(expectedStatus: String): Ride =
    ride?.takeIf { it.status == expectedStatus } ?: error("Tidak ada perjalanan aktif untuk dijeda.")

  private fun appendSessionEvent(kind: String, effectiveAtMillis: Long) {
    if (hasMotionTimingEvents) sessionEvents.add(RideSessionEvent(kind, effectiveAtMillis, System.currentTimeMillis()))
  }

  private fun endMotionEvidence(endMillis: Long, events: MutableList<RideSessionEvent>) {
    if (!hasMotionTimingEvents) return
    val lastLocationAt = lastMotionLocation?.time ?: ridePoints.lastOrNull()?.timestampMillis
    val ending = RideMotionTiming.endingEvent(motionCoordinator.state, lastLocationAt, endMillis) ?: return
    events.add(RideSessionEvent(ending.first, ending.second, endMillis))
  }

  private fun movingSeconds(activeRide: Ride, endMillis: Long, events: List<RideSessionEvent> = sessionEvents): Double {
    if (!hasMotionTimingEvents || events.isEmpty()) return accumulatedMovingSeconds
    return RideMotionTiming.movingSeconds(events, ridePoints.lastOrNull()?.timestampMillis, endMillis)
      .coerceAtMost(((endMillis - activeRide.startedAtMillis) / 1000.0).coerceAtLeast(0.0))
  }

  private fun unknownMotionSeconds(
    activeRide: Ride,
    endMillis: Long,
    events: List<RideSessionEvent> = sessionEvents,
    pausedSeconds: Double = totalPausedSeconds,
  ): Double {
    if (!hasMotionTimingEvents) return 0.0
    return RideMotionTiming.unknownSeconds(events, activeRide.startedAtMillis, ridePoints.lastOrNull()?.timestampMillis, endMillis)
      .coerceAtMost(rideClock(activeRide, endMillis, pausedSeconds))
  }

  private fun rideClock(activeRide: Ride, atMillis: Long, savedPausedSeconds: Double = totalPausedSeconds): Double {
    val pauseStartedAt = activeRide.pausedAtMillis
    val currentPauseSeconds = if (pauseStartedAt != null) (atMillis - pauseStartedAt) / 1000.0 else 0.0
    return ((atMillis - activeRide.startedAtMillis) / 1000.0 - savedPausedSeconds - currentPauseSeconds)
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
    elevationDataAvailable = false
    val activeRide = ride ?: return
    val file = sampleFile(context, activeRide.id)
    check(file.isFile) { "File sampel perjalanan tidak ditemukan." }
    file.forEachLine { line ->
        val point = JSONObject(line)
        ridePoints.add(RidePoint(
          timestampMillis = point.getLong("timestampMillis"),
          latitude = point.getDouble("latitude"),
          longitude = point.getDouble("longitude"),
          accuracyMeters = point.optDouble("accuracyMeters", 0.0).toFloat(),
          verticalAccuracyMeters = point.optDouble("verticalAccuracyMeters")
            .takeIf { !point.isNull("verticalAccuracyMeters") }?.toFloat(),
          elevationMeters = point.optDouble("elevationMeters").takeIf { !point.isNull("elevationMeters") },
          elevationSource = point.optString("elevationSource").takeIf { it.isNotEmpty() && it != "null" }
            ?: if (!point.isNull("elevationMeters")) "gps" else null,
          elevationAnchorQuality = point.optString("elevationAnchorQuality").takeIf { it.isNotEmpty() && it != "null" }
            ?: if (!point.isNull("elevationMeters")) "gps" else null,
          relativeElevationMeters = point.optDouble("relativeElevationMeters").takeIf { !point.isNull("relativeElevationMeters") },
          barometerEpoch = point.optInt("barometerEpoch").takeIf { !point.isNull("barometerEpoch") },
          liveGradePercent = point.optDouble("liveGradePercent").takeIf { !point.isNull("liveGradePercent") },
          liveGradeSource = point.optString("liveGradeSource").takeIf { it.isNotEmpty() && it != "null" },
          liveGradeWindowMeters = point.optDouble("liveGradeWindowMeters").takeIf { !point.isNull("liveGradeWindowMeters") },
          liveGradeSampleCount = point.optInt("liveGradeSampleCount").takeIf { !point.isNull("liveGradeSampleCount") },
          speedMetersPerSecond = point.optDouble("speedMetersPerSecond").takeIf { !point.isNull("speedMetersPerSecond") }?.toFloat(),
          filteredSpeedMetersPerSecond = point.optDouble("filteredSpeedMetersPerSecond").takeIf { !point.isNull("filteredSpeedMetersPerSecond") },
          speedSource = point.optString("speedSource").takeIf { it.isNotEmpty() && it != "null" },
          speedAccuracyMetersPerSecond = point.optDouble("speedAccuracyMetersPerSecond").takeIf { !point.isNull("speedAccuracyMetersPerSecond") }?.toFloat(),
          courseDegrees = point.optDouble("courseDegrees").takeIf { !point.isNull("courseDegrees") }?.toFloat(),
          barometricPressureKilopascals = point.optDouble("barometricPressureKilopascals").takeIf { !point.isNull("barometricPressureKilopascals") },
          motionState = point.optString("motionState").takeIf { it.isNotEmpty() && it != "null" },
          cumulativeDistanceMeters = point.optDouble("cumulativeDistanceMeters").takeIf { !point.isNull("cumulativeDistanceMeters") },
          heartRateBpm = point.optInt("heartRateBpm").takeIf { !point.isNull("heartRateBpm") && it > 0 },
          heartRateRecordedAtMillis = point.optLong("heartRateRecordedAtMillis").takeIf { !point.isNull("heartRateRecordedAtMillis") && it > 0 },
          segmentStart = point.optBoolean("segmentStart"),
        ))
        if (ridePoints.last().elevationMeters != null) elevationDataAvailable = true
    }
  }

  private fun recalculateRideStatistics() {
    accumulatedDistanceMeters = 0.0
    accumulatedMovingSeconds = 0.0
    accumulatedAscentMeters = 0.0
    accumulatedDescentMeters = 0.0
    lastCreditedElevationMeters = null
    lastCreditedElevationSource = null
    lastCreditedElevationDistance = 0.0
    ridePoints.forEachIndexed { index, point ->
      if (index == 0) {
        updateElevationTotals(point)
        return@forEachIndexed
      }
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
        (point.speedMetersPerSecond ?: 0f) >= minimumDistanceCreditSpeedMetersPerSecond &&
        (point.motionState == "moving" || (point.motionState == null && (point.speedMetersPerSecond ?: 0f) >= minimumMovingSpeedMetersPerSecond))) {
        accumulatedDistanceMeters += distanceMeters
      }
      if (!point.segmentStart && elapsedSeconds in 0.0..movingIntervalLimitSeconds &&
        (previousPoint.speedMetersPerSecond ?: 0f) >= minimumMovingSpeedMetersPerSecond) {
        accumulatedMovingSeconds += elapsedSeconds
      }
      updateElevationTotals(point)
    }
    ridePoints.lastOrNull()?.cumulativeDistanceMeters?.takeIf { it.isFinite() && it >= 0 }?.let {
      accumulatedDistanceMeters = it
    }
  }

  private fun backfillConfirmedDistance(movementStartedAtMillis: Long) {
    if (!hasMotionTimingEvents) return
    for (index in ridePoints.lastIndex downTo 1) {
      val previousPoint = ridePoints[index - 1]
      val point = ridePoints[index]
      if (point.timestampMillis < movementStartedAtMillis) break
      val intervalSeconds = (point.timestampMillis - previousPoint.timestampMillis) / 1000.0
      if (previousPoint.timestampMillis < movementStartedAtMillis || point.segmentStart ||
        intervalSeconds <= 0 || intervalSeconds > 3 || previousPoint.accuracyMeters > 20 || point.accuracyMeters > 20) continue
      val previousLocation = Location("CycleComp").apply { latitude = previousPoint.latitude; longitude = previousPoint.longitude }
      val currentLocation = Location("CycleComp").apply { latitude = point.latitude; longitude = point.longitude }
      val distance = currentLocation.distanceTo(previousLocation).toDouble()
      if (distance / intervalSeconds in minimumDistanceCreditSpeedMetersPerSecond..maximumPlausibleSpeedMetersPerSecond) {
        accumulatedDistanceMeters += distance
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
      put("elevationSource", point.elevationSource ?: JSONObject.NULL)
      put("elevationAnchorQuality", point.elevationAnchorQuality ?: JSONObject.NULL)
      put("relativeElevationMeters", point.relativeElevationMeters ?: JSONObject.NULL)
      put("barometerEpoch", point.barometerEpoch ?: JSONObject.NULL)
      put("liveGradePercent", point.liveGradePercent ?: JSONObject.NULL)
      put("liveGradeSource", point.liveGradeSource ?: JSONObject.NULL)
      put("liveGradeWindowMeters", point.liveGradeWindowMeters ?: JSONObject.NULL)
      put("liveGradeSampleCount", point.liveGradeSampleCount ?: JSONObject.NULL)
      put("speedMetersPerSecond", point.speedMetersPerSecond?.toDouble() ?: JSONObject.NULL)
      put("filteredSpeedMetersPerSecond", point.filteredSpeedMetersPerSecond ?: JSONObject.NULL)
      put("speedSource", point.speedSource ?: JSONObject.NULL)
      put("speedAccuracyMetersPerSecond", point.speedAccuracyMetersPerSecond?.toDouble() ?: JSONObject.NULL)
      put("courseDegrees", point.courseDegrees?.toDouble() ?: JSONObject.NULL)
      put("barometricPressureKilopascals", point.barometricPressureKilopascals ?: JSONObject.NULL)
      put("motionState", point.motionState ?: JSONObject.NULL)
      put("cumulativeDistanceMeters", point.cumulativeDistanceMeters ?: JSONObject.NULL)
      put("heartRateBpm", point.heartRateBpm ?: JSONObject.NULL)
      put("heartRateRecordedAtMillis", point.heartRateRecordedAtMillis ?: JSONObject.NULL)
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
      if (hasMotionTimingEvents) put("events", JSONArray().apply {
        sessionEvents.forEach { event -> put(JSONObject().apply {
          put("kind", event.kind)
          put("effectiveAtMillis", event.effectiveAtMillis)
          put("detectedAtMillis", event.detectedAtMillis)
        }) }
      })
    }
    preferences(context).edit().putString(activeRideKey, snapshot.toString()).apply()
    lastCheckpointAt = System.currentTimeMillis()
  }

  private fun exportGpx(context: Context, activeRide: Ride, finishedAt: Long, pausedSeconds: Double, autoPausedSeconds: Double, events: List<RideSessionEvent>): File {
    val output = File(ridesDirectory(context), "CycleComp-${activeRide.id}.gpx")
    output.parentFile?.mkdirs()
    val timerSeconds = rideClock(activeRide, finishedAt, pausedSeconds)
    val elapsedSeconds = (finishedAt - activeRide.startedAtMillis) / 1000.0
    val measuredPoints = ridePoints.filter { it.elevationMeters != null || it.relativeElevationMeters != null }
    val elevationQuality = when {
      measuredPoints.isEmpty() -> "unavailable"
      ridePoints.all { it.elevationSource == "barometer_gps" && it.elevationAnchorQuality == "calibrated" } -> "barometer_calibrated"
      measuredPoints.all { it.elevationSource == "gps" && it.relativeElevationMeters == null } -> "gps"
      measuredPoints.all { it.elevationMeters == null && it.relativeElevationMeters != null } -> "barometer_relative"
      else -> "mixed"
    }
    val elevationGainAttributes = if (measuredPoints.isNotEmpty()) {
      "ascentMeters=\"$accumulatedAscentMeters\" descentMeters=\"$accumulatedDescentMeters\" "
    } else ""
    val trackTimeSpanSeconds = if (ridePoints.size > 1) {
      (ridePoints.last().timestampMillis - ridePoints.first().timestampMillis) / 1000.0
    } else 0.0
    val pendingOutput = File(output.parentFile, ".${output.name}.${UUID.randomUUID()}.tmp")
    try {
      FileOutputStream(pendingOutput).use { stream ->
      val writer = stream.bufferedWriter()
      writer.appendLine("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")
      writer.appendLine("<gpx version=\"1.1\" creator=\"CycleComp\" xmlns=\"http://www.topografix.com/GPX/1/1\" xmlns:cyclecomp=\"https://mangwahyu.tech/cyclecomp/gpx/1\" xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\">")
      writer.appendLine("<metadata><time>${isoTimestamp(activeRide.startedAtMillis)}</time><extensions>")
      writer.appendLine(
        "<cyclecomp:activitySummary algorithmVersion=\"${if (hasMotionTimingEvents) RideMotionTiming.algorithmVersion else "android-gps-v1"}\" " +
          "distanceMeters=\"$accumulatedDistanceMeters\" elapsedSeconds=\"$elapsedSeconds\" " +
          "timerSeconds=\"$timerSeconds\" movingSeconds=\"${movingSeconds(activeRide, finishedAt, events)}\" " +
          "manualPausedSeconds=\"${pausedSeconds - autoPausedSeconds}\" " +
          "autoPausedSeconds=\"$autoPausedSeconds\" unknownMotionSeconds=\"${unknownMotionSeconds(activeRide, finishedAt, events, pausedSeconds)}\" trackTimeSpanSeconds=\"$trackTimeSpanSeconds\" " +
          elevationGainAttributes +
          "elevationQuality=\"$elevationQuality\" />",
      )
      writer.appendLine("<cyclecomp:finishedAt>${isoTimestamp(finishedAt)}</cyclecomp:finishedAt>")
      events.sortedWith(compareBy<RideSessionEvent> { it.effectiveAtMillis }.thenBy { it.detectedAtMillis }).forEach { event ->
        writer.appendLine("<cyclecomp:sessionEvent kind=\"${event.kind}\" effectiveAt=\"${isoTimestamp(event.effectiveAtMillis)}\" detectedAt=\"${isoTimestamp(event.detectedAtMillis)}\" />")
      }
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
        writer.append("<time>").append(isoTimestamp(point.timestampMillis)).append("</time>")
        writer.append("<extensions>")
          writer.append("<cyclecomp:horizontalAccuracyMeters>${point.accuracyMeters}</cyclecomp:horizontalAccuracyMeters>")
          point.verticalAccuracyMeters?.let { writer.append("<cyclecomp:verticalAccuracyMeters>$it</cyclecomp:verticalAccuracyMeters>") }
          point.speedMetersPerSecond?.let { writer.append("<cyclecomp:speedMetersPerSecond>$it</cyclecomp:speedMetersPerSecond>") }
          point.filteredSpeedMetersPerSecond?.let { writer.append("<cyclecomp:filteredSpeedMetersPerSecond>$it</cyclecomp:filteredSpeedMetersPerSecond>") }
          point.speedSource?.let { writer.append("<cyclecomp:speedSource>$it</cyclecomp:speedSource>") }
          point.speedAccuracyMetersPerSecond?.let { writer.append("<cyclecomp:speedAccuracyMetersPerSecond>$it</cyclecomp:speedAccuracyMetersPerSecond>") }
          if (point.speedMetersPerSecond != null && point.speedAccuracyMetersPerSecond != null) {
            writer.append("<cyclecomp:speedLowerBoundMetersPerSecond>${(point.speedMetersPerSecond - point.speedAccuracyMetersPerSecond).coerceAtLeast(0f)}</cyclecomp:speedLowerBoundMetersPerSecond>")
            writer.append("<cyclecomp:speedUpperBoundMetersPerSecond>${point.speedMetersPerSecond + point.speedAccuracyMetersPerSecond}</cyclecomp:speedUpperBoundMetersPerSecond>")
          }
          point.courseDegrees?.let { writer.append("<cyclecomp:courseDegrees>$it</cyclecomp:courseDegrees>") }
          point.elevationSource?.let { writer.append("<cyclecomp:elevationSource>$it</cyclecomp:elevationSource>") }
          point.elevationAnchorQuality?.let { writer.append("<cyclecomp:elevationQuality>$it</cyclecomp:elevationQuality>") }
          point.relativeElevationMeters?.let { writer.append("<cyclecomp:relativeBarometerElevationMeters>$it</cyclecomp:relativeBarometerElevationMeters>") }
          point.barometerEpoch?.let { writer.append("<cyclecomp:barometerEpoch>$it</cyclecomp:barometerEpoch>") }
          point.barometricPressureKilopascals?.let { writer.append("<cyclecomp:barometricPressureKilopascals>$it</cyclecomp:barometricPressureKilopascals>") }
          point.liveGradePercent?.let { writer.append("<cyclecomp:liveGradePercent>$it</cyclecomp:liveGradePercent>") }
          point.liveGradeSource?.let { writer.append("<cyclecomp:liveGradeSource>$it</cyclecomp:liveGradeSource>") }
          point.liveGradeSource?.let { writer.append("<cyclecomp:liveGradeQuality>${if (it == "gps") "gps_vertical" else "barometer_relative"}</cyclecomp:liveGradeQuality>") }
          point.liveGradeWindowMeters?.let { writer.append("<cyclecomp:liveGradeWindowMeters>$it</cyclecomp:liveGradeWindowMeters>") }
          point.liveGradeSampleCount?.let { writer.append("<cyclecomp:liveGradeSampleCount>$it</cyclecomp:liveGradeSampleCount>") }
          point.motionState?.let { writer.append("<cyclecomp:motionState>$it</cyclecomp:motionState>") }
          point.heartRateBpm?.let { writer.append("<gpxtpx:TrackPointExtension><gpxtpx:hr>$it</gpxtpx:hr></gpxtpx:TrackPointExtension>") }
        writer.append("</extensions>")
        writer.append("</trkpt>\n")
      }
      if (segmentOpen) writer.appendLine("</trkseg>")
      writer.appendLine("</trk></gpx>")
      writer.flush()
      stream.fd.sync()
      }
      Os.rename(pendingOutput.absolutePath, output.absolutePath)
    } catch (error: Exception) {
      pendingOutput.delete()
      throw error
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

  private fun updateElevationTotals(point: RidePoint) {
    if (point.motionState != null && point.motionState != "moving") return
    val elevationMeters = point.relativeElevationMeters ?: point.elevationMeters ?: return
    val source = when {
      point.relativeElevationMeters != null -> "barometer-relative:${point.barometerEpoch ?: 0}"
      point.barometerEpoch != null -> return
      point.elevationSource == "barometer_gps" -> "barometer-absolute"
      point.elevationSource != null -> "absolute:${point.elevationSource}"
      else -> return
    }
    if (point.segmentStart || source != lastCreditedElevationSource) {
      lastCreditedElevationMeters = elevationMeters
      lastCreditedElevationDistance = accumulatedDistanceMeters
      lastCreditedElevationSource = source
      return
    }
    if (point.motionState == null && (point.speedMetersPerSecond ?: 0f) < minimumMovingSpeedMetersPerSecond) return
    val previousElevationMeters = lastCreditedElevationMeters ?: run {
      lastCreditedElevationMeters = elevationMeters
      lastCreditedElevationDistance = accumulatedDistanceMeters
      return
    }
    val barometer = source.startsWith("barometer")
    if (accumulatedDistanceMeters - lastCreditedElevationDistance < if (barometer) 20.0 else 50.0) return
    val elevationChangeMeters = elevationMeters - previousElevationMeters
    val deadband = if (barometer) 2.5 else maxOf(5.0, (point.verticalAccuracyMeters ?: 0f) * 0.25)
    if (elevationChangeMeters >= deadband) {
      accumulatedAscentMeters += elevationChangeMeters
      lastCreditedElevationMeters = elevationMeters
      lastCreditedElevationDistance = accumulatedDistanceMeters
    } else if (elevationChangeMeters <= -deadband) {
      accumulatedDescentMeters -= elevationChangeMeters
      lastCreditedElevationMeters = elevationMeters
      lastCreditedElevationDistance = accumulatedDistanceMeters
    }
  }

  private fun resetMotionMeasurements() {
    motionCoordinator.reset()
    speedSmoother.reset()
    sensorTrace.append("policyReset", JSONObject().put("reason", "recording_reset"))
    sensorTrace.append("speedReset", JSONObject().put("reason", "recording_reset"))
    gradeEstimator.reset()
    lastMotionLocation = null
    displayedSpeed = null
  }

  private fun appendMotionTrace(observation: RideMotionCoordinator.Observation) {
    val sample = observation.sample
    val transitionName = when (observation.transition?.state) {
      RideAutoPausePolicy.MotionState.moving -> "startedMoving"
      RideAutoPausePolicy.MotionState.stationary -> "stoppedMoving"
      RideAutoPausePolicy.MotionState.unknown -> "becameUnknown"
      null -> null
    }
    sensorTrace.append("policy", JSONObject().put("policy", JSONObject().apply {
      put("timestamp", sample.timestampMillis / 1000.0)
      put("speedMetersPerSecond", observation.measuredSpeedMetersPerSecond ?: JSONObject.NULL)
      put("horizontalAccuracyMeters", sample.accuracyMeters)
      put("speedAccuracyMetersPerSecond", sample.speedAccuracyMetersPerSecond?.takeIf { it.isFinite() } ?: -1.0)
      put("displacementSincePreviousMeters", observation.displacementMeters)
      put("positionSpeedMetersPerSecond", observation.positionSpeedMetersPerSecond ?: JSONObject.NULL)
      put("positionSpeedWindowStartedAt", observation.positionSpeedWindowStartedAtMillis?.div(1000.0) ?: JSONObject.NULL)
      put("latitude", sample.latitude)
      put("longitude", sample.longitude)
      put("motionActivityIsStationary", sample.motionActivityIsStationary)
      put("stateBefore", observation.stateBefore.name)
      put("stateAfter", observation.stateAfter.name)
      put("transition", transitionName ?: JSONObject.NULL)
      put("transitionEffectiveAt", observation.transition?.effectiveAtMillis?.div(1000.0) ?: JSONObject.NULL)
    }))
  }

  private const val maximumHorizontalAccuracyMeters = 50f
  private const val maximumDistanceCreditIntervalSeconds = 30.0
  private const val maximumPlausibleSpeedMetersPerSecond = 40.0
  private const val minimumDistanceCreditSpeedMetersPerSecond = 0.25
  private const val movingIntervalLimitSeconds = 3.0
  private const val minimumMovingSpeedMetersPerSecond = 1f
  private const val highAccuracyThresholdMeters = 10f
  private const val mediumAccuracyThresholdMeters = 30f
}
