package com.cyclecomp

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.view.WindowManager
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class RideTrackingModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  private var listenerCount = 0
  private val uploadExecutor = Executors.newSingleThreadExecutor()
  private val rideReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      when (intent?.action) {
        RideTrackingService.actionSnapshot -> intent.getStringExtra("snapshot")?.let { json ->
          emitEvent("RideTrackingSnapshot", jsonToWritableMap(JSONObject(json)))
        }
        RideTrackingService.actionError -> emitEvent("RideTrackingError", Arguments.createMap().apply {
          putString("message", intent.getStringExtra("message") ?: "Perekaman perjalanan gagal.")
        })
      }
    }
  }

  override fun getName() = "RideTracking"

  override fun initialize() {
    super.initialize()
    RideTrackingEngine.initialize(reactContext)
    val intentFilter = IntentFilter().apply {
      addAction(RideTrackingService.actionSnapshot)
      addAction(RideTrackingService.actionError)
    }
    if (Build.VERSION.SDK_INT >= 33) {
      reactContext.registerReceiver(rideReceiver, intentFilter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION")
      reactContext.registerReceiver(rideReceiver, intentFilter)
    }
    RideTrackingEngine.initializeWatch(reactContext)
  }

  override fun invalidate() {
    runCatching { reactContext.unregisterReceiver(rideReceiver) }
    uploadExecutor.shutdownNow()
    super.invalidate()
  }

  @ReactMethod
  fun addListener(eventName: String) {
    listenerCount += 1
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    listenerCount = (listenerCount - count).coerceAtLeast(0)
  }

  @ReactMethod
  fun getRideState(promise: Promise) = resolve(promise) {
    jsonToWritableMap(JSONObject(RideTrackingEngine.snapshot(reactContext)))
  }

  @ReactMethod
  fun getRideElevationTrack(promise: Promise) = resolve(promise) {
    Arguments.makeNativeArray(RideTrackingEngine.elevationTrack())
  }

  @ReactMethod
  fun setAutoPauseEnabled(enabled: Boolean, promise: Promise) = resolve(promise) {
    jsonToWritableMap(JSONObject(RideTrackingEngine.setAutoPause(reactContext, enabled)))
  }

  @ReactMethod
  fun setSensorDiagnosticsEnabled(enabled: Boolean, promise: Promise) = resolve(promise) {
    jsonToWritableMap(JSONObject(RideTrackingEngine.setDiagnostics(reactContext, enabled)))
  }

  @ReactMethod
  fun setWatchHeartRateEnabled(enabled: Boolean, promise: Promise) = resolve(promise) {
    jsonToWritableMap(JSONObject(RideTrackingEngine.setHeartRateEnabled(reactContext, enabled)))
  }

  @ReactMethod
  fun startRide(promise: Promise) = resolve(promise) {
    requireLocationPermission()
    val snapshot = RideTrackingEngine.start(reactContext)
    try {
      startTrackingService(RideTrackingService.actionStart)
      jsonToWritableMap(JSONObject(snapshot))
    } catch (error: Exception) {
      runCatching { RideTrackingEngine.pause(reactContext) }
      throw error
    }
  }

  @ReactMethod
  fun pauseRide(promise: Promise) = resolve(promise) {
    val snapshot = RideTrackingEngine.pause(reactContext)
    stopTrackingService(RideTrackingService.actionPause)
    jsonToWritableMap(JSONObject(snapshot))
  }

  @ReactMethod
  fun resumeRide(promise: Promise) = resolve(promise) {
    requireLocationPermission()
    val snapshot = RideTrackingEngine.resume(reactContext)
    try {
      startTrackingService(RideTrackingService.actionResume)
      jsonToWritableMap(JSONObject(snapshot))
    } catch (error: Exception) {
      runCatching { RideTrackingEngine.pause(reactContext) }
      throw error
    }
  }

  @ReactMethod
  fun finishRide(promise: Promise) = resolve(promise) {
    val finishedSnapshot = RideTrackingEngine.finish(reactContext)
    stopTrackingService(RideTrackingService.actionStop)
    jsonToWritableMap(JSONObject(finishedSnapshot))
  }

  @ReactMethod
  fun shareGpx(fileUrl: String, promise: Promise) = resolve(promise) {
    shareFile(RideTrackingEngine.savedRideFile(reactContext, fileUrl), "application/gpx+xml")
    true
  }

  @ReactMethod
  fun shareSensorTrace(fileUrl: String, promise: Promise) = resolve(promise) {
    shareFile(RideTrackingEngine.savedSensorTraceFile(reactContext, fileUrl), "application/x-ndjson")
    true
  }

  @ReactMethod
  fun listSavedRides(promise: Promise) = resolve(promise) {
    Arguments.makeNativeArray(RideTrackingEngine.listSavedRides(reactContext))
  }

  @ReactMethod
  fun readSavedRideGpx(fileUrl: String, promise: Promise) = resolve(promise) {
    RideTrackingEngine.readSavedRide(reactContext, fileUrl)
  }

  @ReactMethod
  fun deleteSavedRide(fileUrl: String, promise: Promise) = resolve(promise) {
    RideTrackingEngine.deleteSavedRide(reactContext, fileUrl)
  }

  @ReactMethod
  fun openStravaUpload(promise: Promise) = resolve(promise) {
    val uploadPage = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.strava.com/upload/select"))
    uploadPage.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    reactContext.startActivity(uploadPage)
    true
  }

  @ReactMethod
  fun getStravaStorage(promise: Promise) = resolve(promise) {
    val json = reactContext.getSharedPreferences("cyclecomp_strava", Context.MODE_PRIVATE)
      .getString("storage", "{}") ?: "{}"
    jsonToWritableMap(JSONObject(json))
  }

  @ReactMethod
  fun setStravaStorage(storage: ReadableMap, promise: Promise) = resolve(promise) {
    reactContext.getSharedPreferences("cyclecomp_strava", Context.MODE_PRIVATE)
      .edit().putString("storage", JSONObject(storage.toHashMap()).toString()).apply()
    true
  }

  @ReactMethod
  fun uploadGpxToStrava(fileUrl: String, accessToken: String, activityName: String, promise: Promise) {
    val file = runCatching { RideTrackingEngine.savedRideFile(reactContext, fileUrl) }.getOrElse {
      promise.reject("file_missing", it.message, it)
      return
    }
    uploadExecutor.execute {
      try {
        val response = stravaRequest(
          endpoint = "https://www.strava.com/api/v3/uploads",
          accessToken = accessToken,
          method = "POST",
          file = file,
          activityName = activityName,
        )
        reactContext.runOnUiQueueThread { promise.resolve(jsonToWritableMap(response)) }
      } catch (error: Exception) {
        reactContext.runOnUiQueueThread {
          promise.reject("strava_upload_failed", "Strava menolak unggahan: ${error.message ?: "permintaan gagal"}", error)
        }
      }
    }
  }

  @ReactMethod
  fun checkStravaUploadStatus(uploadId: String, accessToken: String, promise: Promise) {
    uploadExecutor.execute {
      try {
        val response = stravaRequest(
          endpoint = "https://www.strava.com/api/v3/uploads/${Uri.encode(uploadId)}",
          accessToken = accessToken,
          method = "GET",
        )
        reactContext.runOnUiQueueThread { promise.resolve(jsonToWritableMap(response)) }
      } catch (error: Exception) {
        reactContext.runOnUiQueueThread {
          promise.reject("strava_status_failed", "Gagal memeriksa status Strava: ${error.message ?: "permintaan gagal"}", error)
        }
      }
    }
  }

  @ReactMethod
  fun setKeepScreenOn(keepOn: Boolean, promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    activity.runOnUiThread {
      if (keepOn) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun playAudioCue(cueType: String, promise: Promise) {
    try {
      val tone = when (cueType) {
        "off_route" -> ToneGenerator.TONE_PROP_NACK
        "climb" -> ToneGenerator.TONE_PROP_BEEP2
        else -> ToneGenerator.TONE_PROP_BEEP
      }
      val toneGenerator = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 70)
      toneGenerator.startTone(tone, 180)
      toneGenerator.release()
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("audio_cue_failed", error.message, error)
    }
  }

  private fun requireLocationPermission() {
    val fineLocationAllowed = reactContext.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val coarseLocationAllowed = reactContext.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    check(fineLocationAllowed || coarseLocationAllowed) { "Izinkan akses lokasi untuk merekam perjalanan." }
  }

  private fun startTrackingService(action: String) {
    val serviceIntent = Intent(reactContext, RideTrackingService::class.java).setAction(action)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) reactContext.startForegroundService(serviceIntent)
    else reactContext.startService(serviceIntent)
  }

  private fun stopTrackingService(action: String) {
    reactContext.startService(Intent(reactContext, RideTrackingService::class.java).setAction(action))
  }

  private fun shareFile(file: File, mimeType: String) {
    val fileUri = FileProvider.getUriForFile(reactContext, "${reactContext.packageName}.fileprovider", file)
    val shareIntent = Intent(Intent.ACTION_SEND).apply {
      type = mimeType
      putExtra(Intent.EXTRA_STREAM, fileUri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    reactContext.startActivity(Intent.createChooser(shareIntent, "Bagikan perjalanan").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  private fun stravaRequest(
    endpoint: String,
    accessToken: String,
    method: String,
    file: File? = null,
    activityName: String = "",
  ): JSONObject {
    val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = 20_000
      readTimeout = 30_000
      setRequestProperty("Authorization", "Bearer $accessToken")
    }
    try {
      if (file != null) {
        val boundary = "CycleComp-${System.nanoTime()}"
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        connection.outputStream.buffered().use { output ->
          fun writeField(name: String, value: String) {
            output.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray())
          }
          writeField("data_type", "gpx")
          writeField("name", activityName.replace("\"", ""))
          writeField("description", "Direkam dengan CycleComp")
          output.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"${file.name}\"\r\nContent-Type: application/gpx+xml\r\n\r\n".toByteArray())
          file.inputStream().use { it.copyTo(output) }
          output.write("\r\n--$boundary--\r\n".toByteArray())
        }
      }
      val statusCode = connection.responseCode
      val responseStream = if (statusCode in 200..299) connection.inputStream else connection.errorStream
      val responseBody = responseStream?.bufferedReader()?.use { it.readText() }.orEmpty()
      val responseJson = runCatching { JSONObject(responseBody) }.getOrElse {
        error("Respon Strava tidak valid (HTTP $statusCode).")
      }
      if (statusCode !in 200..299) {
        error(responseJson.optString("message").ifEmpty { responseJson.optString("error", "Status HTTP $statusCode") })
      }
      return responseJson
    } finally {
      connection.disconnect()
    }
  }

  private fun emitEvent(eventName: String, body: WritableMap) {
    if (listenerCount == 0 || !reactContext.hasActiveCatalystInstance()) return
    reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(eventName, body)
  }

  private fun resolve(promise: Promise, block: () -> Any?) {
    try {
      promise.resolve(block())
    } catch (error: Exception) {
      promise.reject("ride_tracking_error", error.message ?: "Operasi perjalanan gagal.", error)
    }
  }

  private fun jsonToWritableMap(json: JSONObject): WritableMap = Arguments.createMap().apply {
    val keys = json.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      putJsonValue(this, key, json.opt(key))
    }
  }

  private fun jsonToWritableArray(json: JSONArray): WritableArray = Arguments.createArray().apply {
    for (index in 0 until json.length()) pushJsonValue(this, json.opt(index))
  }

  private fun putJsonValue(map: WritableMap, key: String, value: Any?) {
    when (value) {
      null, JSONObject.NULL -> map.putNull(key)
      is JSONObject -> map.putMap(key, jsonToWritableMap(value))
      is JSONArray -> map.putArray(key, jsonToWritableArray(value))
      is Boolean -> map.putBoolean(key, value)
      is Int -> map.putInt(key, value)
      is Number -> map.putDouble(key, value.toDouble())
      else -> map.putString(key, value.toString())
    }
  }

  private fun pushJsonValue(array: WritableArray, value: Any?) {
    when (value) {
      null, JSONObject.NULL -> array.pushNull()
      is JSONObject -> array.pushMap(jsonToWritableMap(value))
      is JSONArray -> array.pushArray(jsonToWritableArray(value))
      is Boolean -> array.pushBoolean(value)
      is Int -> array.pushInt(value)
      is Number -> array.pushDouble(value.toDouble())
      else -> array.pushString(value.toString())
    }
  }
}
