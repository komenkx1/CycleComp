package com.cyclecomp

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.location.Location
import org.json.JSONObject
import java.io.File

internal object RideTrackingRegression {
  fun run(targetContext: Context) {
    val testDirectory = File(targetContext.cacheDir, "ride-regression-${System.nanoTime()}")
    check(testDirectory.mkdirs())
    val preferenceName = "ride-regression-${System.nanoTime()}"
    val testContext = object : ContextWrapper(targetContext) {
      override fun getFilesDir(): File = testDirectory
      override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
        targetContext.getSharedPreferences("$preferenceName-$name", mode)
    }
    val preferences = testContext.getSharedPreferences("cyclecomp_ride_tracking", Context.MODE_PRIVATE)
    try {
      RideTrackingEngine.initialize(testContext)
      RideTrackingEngine.start(testContext)
      Thread.sleep(30)
      val first = location(-8.0, System.currentTimeMillis())
      check(RideTrackingEngine.onLocation(testContext, first) != null)
      Thread.sleep(30)
      val second = location(-7.99999, System.currentTimeMillis())
      check(RideTrackingEngine.onLocation(testContext, second) != null)
      val beforePause = RideTrackingEngine.snapshot(testContext)
      val distanceBeforePause = beforePause["distanceMeters"] as Double
      val pointCountBeforePause = beforePause["pointCount"] as Int
      check(RideTrackingEngine.onLocation(testContext, location(-7.99990, first.time)) == null)
      check(RideTrackingEngine.onLocation(testContext, location(-7.99990, System.currentTimeMillis() - 4_000)) == null)
      check(RideTrackingEngine.snapshot(testContext)["pointCount"] == pointCountBeforePause)

      RideTrackingEngine.pause(testContext)
      Thread.sleep(30)
      check(RideTrackingEngine.onLocation(testContext, location(-7.99950, System.currentTimeMillis())) == null)
      check(RideTrackingEngine.snapshot(testContext)["distanceMeters"] == distanceBeforePause)
      val savedPausedAt = JSONObject(preferences.getString("active_ride", "{}")!!).getLong("pausedAtMillis")
      val engineClass = RideTrackingEngine::class.java
      val rideField = engineClass.getDeclaredField("ride").apply { isAccessible = true }
      rideField.set(null, null)
      RideTrackingEngine.initialize(testContext)
      val recoveredRide = rideField.get(null)
      val pausedAtField = recoveredRide.javaClass.getDeclaredField("pausedAtMillis").apply { isAccessible = true }
      check(pausedAtField.get(recoveredRide) == savedPausedAt)
      check(RideTrackingEngine.snapshot(testContext)["status"] == "paused")
      RideTrackingEngine.resume(testContext)
      Thread.sleep(30)
      val resumed = RideTrackingEngine.onLocation(testContext, location(-7.99900, System.currentTimeMillis()))!!
      check(resumed["newSegment"] == true)
      val afterResume = RideTrackingEngine.snapshot(testContext)
      check(afterResume["distanceMeters"] == distanceBeforePause)
      val segments = afterResume["trackSegments"] as List<*>
      check(segments.size == 2 && (segments.last() as List<*>).size == 1)
      Thread.sleep(30)
      val followingPoint = RideTrackingEngine.onLocation(testContext, location(-7.99899, System.currentTimeMillis()))!!
      check(followingPoint["newSegment"] == false)
      check((RideTrackingEngine.snapshot(testContext)["distanceMeters"] as Double) > distanceBeforePause)
      val blockedRidesDirectory = File(testDirectory, "Rides")
      blockedRidesDirectory.writeText("blocked")
      val stateBeforeFailure = RideTrackingEngine.snapshot(testContext)
      check(runCatching { RideTrackingEngine.finish(testContext) }.isFailure)
      val stateAfterFailure = RideTrackingEngine.snapshot(testContext)
      check(stateAfterFailure["status"] == "active" && stateAfterFailure["rideId"] == stateBeforeFailure["rideId"])
      check(stateAfterFailure["pointCount"] == stateBeforeFailure["pointCount"])
      check(blockedRidesDirectory.delete())
      RideTrackingEngine.finish(testContext)

      RideTrackingEngine.setAutoPause(testContext, true)
      RideTrackingEngine.start(testContext)
      repeat(4) {
        Thread.sleep(1_050)
        RideTrackingEngine.onLocation(testContext, location(-8.0, System.currentTimeMillis(), 0f))
      }
      check(RideTrackingEngine.snapshot(testContext)["autoPaused"] == true)
      Thread.sleep(1_050)
      RideTrackingEngine.onLocation(testContext, location(-7.99997, System.currentTimeMillis(), 2f))
      check(RideTrackingEngine.snapshot(testContext)["status"] == "paused")
      Thread.sleep(1_050)
      val resumedAutomatically = RideTrackingEngine.onLocation(testContext, location(-7.99994, System.currentTimeMillis(), 2f))!!
      check(resumedAutomatically["status"] == "active")
      val resumedSegments = resumedAutomatically["trackSegments"] as List<*>
      check(resumedSegments.size == 2 && (resumedSegments.last() as List<*>).size == 2)
      check((resumedAutomatically["distanceMeters"] as Double) > 2.0)
      RideTrackingEngine.finish(testContext)
      RideTrackingEngine.setAutoPause(testContext, false)

      preferences.edit().putBoolean("watch_heart_rate", true).commit()
      val simulatedWatch = RealmeWatchHeartRate(targetContext, { 0 }, { 0 }, {}, { _, _ -> })
      val watchField = engineClass.getDeclaredField("watchHeartRate").apply { isAccessible = true }
      watchField.set(null, simulatedWatch)
      RideTrackingEngine.start(testContext)
      val sampleTime = System.currentTimeMillis()
      simulatedWatch.javaClass.getDeclaredField("status").apply { isAccessible = true }.set(simulatedWatch, "active")
      simulatedWatch.javaClass.getDeclaredField("beatsPerMinute").apply { isAccessible = true }.set(simulatedWatch, 123)
      simulatedWatch.javaClass.getDeclaredField("lastSampleAt").apply { isAccessible = true }.set(simulatedWatch, sampleTime)
      val recordHeartRate = engineClass.getDeclaredMethod("recordHeartRate", Context::class.java, Int::class.javaPrimitiveType, Long::class.javaPrimitiveType)
        .apply { isAccessible = true }
      recordHeartRate.invoke(RideTrackingEngine, testContext, 123, sampleTime)
      Thread.sleep(30)
      RideTrackingEngine.onLocation(testContext, location(-8.0, System.currentTimeMillis()))
      val finishedWithHeartRate = RideTrackingEngine.finish(testContext)
      val gpxFile = File(android.net.Uri.parse(finishedWithHeartRate["fileUrl"] as String).path!!)
      val heartRateFile = File(android.net.Uri.parse(finishedWithHeartRate["heartRateFileUrl"] as String).path!!)
      check(gpxFile.readText().contains("<gpxtpx:hr>123</gpxtpx:hr>"))
      check(heartRateFile.readText().contains("\"beatsPerMinute\":123"))
      watchField.set(null, null)
      preferences.edit().putBoolean("watch_heart_rate", false).commit()

      preferences.edit().putString("active_ride", "corrupt-checkpoint").commit()
      check(RideTrackingEngine.snapshot(testContext)["status"] == "recoveryNeeded")
      check(preferences.getString("active_ride", null) == "corrupt-checkpoint")
      check(runCatching { RideTrackingEngine.start(testContext) }.isFailure)
    } finally {
      preferences.edit().clear().commit()
      testDirectory.deleteRecursively()
    }
  }

  private fun location(latitude: Double, timestampMillis: Long, speedMetersPerSecond: Float = 2f) = Location("ride-regression").apply {
    this.latitude = latitude
    longitude = 115.0
    accuracy = 4f
    altitude = 100.0
    verticalAccuracyMeters = 5f
    speed = speedMetersPerSecond
    speedAccuracyMetersPerSecond = 0.2f
    time = timestampMillis
  }
}
