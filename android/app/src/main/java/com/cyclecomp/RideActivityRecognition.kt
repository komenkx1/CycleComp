package com.cyclecomp

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.DetectedActivity

internal class RideActivityEvidence {
  var observedAtMillis: Long? = null
    private set
  var confidence: Int = 0
    private set

  fun update(stillConfidence: Int, timestampMillis: Long) {
    if (observedAtMillis != null && timestampMillis <= observedAtMillis!!) return
    confidence = stillConfidence.coerceIn(0, 100)
    observedAtMillis = timestampMillis
  }

  fun isStationary(atMillis: Long): Boolean = confidence >= 75 && observedAtMillis?.let {
    atMillis - it in -1_000L..5_000L
  } == true

  fun clear() { observedAtMillis = null; confidence = 0 }
}

@SuppressLint("MissingPermission")
internal class RideActivityRecognition(private val context: Context) {
  private val evidence = RideActivityEvidence()
  private val activityIntent = PendingIntent.getBroadcast(
    context, 7315, Intent(context, RideActivityReceiver::class.java),
    PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0,
  )
  @Volatile var status = "unavailable"
    private set
  @Volatile private var generation = 0

  @Synchronized
  fun start() {
    generation += 1
    val requestGeneration = generation
    evidence.clear()
    if (Build.VERSION.SDK_INT >= 29 && context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) {
      status = "denied"
      return
    }
    status = "starting"
    try {
      ActivityRecognition.getClient(context).requestActivityUpdates(5_000, activityIntent)
        .addOnFailureListener { if (generation == requestGeneration) status = "unavailable" }
    } catch (_: Exception) {
      status = "unavailable"
    }
  }

  @Synchronized
  fun stop() {
    generation += 1
    runCatching { ActivityRecognition.getClient(context).removeActivityUpdates(activityIntent) }
    evidence.clear()
    status = "paused"
  }

  @Synchronized
  fun update(stillConfidence: Int, timestampMillis: Long) {
    if (status != "starting" && status != "active") return
    evidence.update(stillConfidence, timestampMillis)
    status = "active"
  }

  @Synchronized
  fun isStationary(atMillis: Long): Boolean = status == "active" && evidence.isStationary(atMillis)

  val observedAtMillis: Long? get() = synchronized(this) { evidence.observedAtMillis }
  val confidence: Int get() = synchronized(this) { evidence.confidence }
}

class RideActivityReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val recognition = ActivityRecognitionResult.extractResult(intent) ?: return
    RideTrackingEngine.onActivityRecognition(context, recognition.getActivityConfidence(DetectedActivity.STILL), recognition.time)
  }
}
