package com.cyclecomp

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject

class RideTrackingService : Service(), LocationListener {
  private lateinit var locationManager: LocationManager

  override fun onCreate() {
    super.onCreate()
    running = true
    locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    if (action == actionPause || action == actionStop) {
      stopLocationUpdates()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf(startId)
      return START_NOT_STICKY
    }

    startRideNotification()
    if (action == null && RideTrackingEngine.snapshot(this)["status"] == "recoveryNeeded") {
      runCatching { RideTrackingEngine.resume(this) }
    }
    startLocationUpdates()
    return START_STICKY
  }

  private fun startRideNotification() {
    val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, notificationChannelId)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }.setSmallIcon(applicationInfo.icon)
      .setContentTitle(getString(R.string.app_name))
      .setContentText("Perjalanan sedang direkam")
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
    } else {
      startForeground(notificationId, notification)
    }
  }

  private fun startLocationUpdates() {
    val hasFineLocation = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    if (!hasFineLocation) {
      publishError("Pilih akses lokasi presisi untuk merekam perjalanan.")
      stopSelf()
      return
    }

    try {
      if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
        locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1_000L, 0f, this, Looper.getMainLooper())
      } else if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
        locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1_000L, 0f, this, Looper.getMainLooper())
      } else {
        publishError("Layanan lokasi perangkat sedang mati.")
      }
      val provider = if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
        LocationManager.GPS_PROVIDER
      } else {
        LocationManager.NETWORK_PROVIDER
      }
      locationManager.getLastKnownLocation(provider)?.let(::onLocationChanged)
    } catch (_: SecurityException) {
      publishError("Izinkan akses lokasi untuk merekam perjalanan.")
      stopSelf()
    }
  }

  private fun stopLocationUpdates() {
    if (::locationManager.isInitialized) locationManager.removeUpdates(this)
  }

  override fun onLocationChanged(location: Location) {
    RideTrackingEngine.onLocation(this, location)?.let(::publishSnapshot)
  }

  override fun onProviderDisabled(provider: String) {
    publishError("Layanan lokasi perangkat sedang mati.")
  }

  override fun onDestroy() {
    stopLocationUpdates()
    running = false
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      notificationChannelId,
      "Rekaman perjalanan",
      NotificationManager.IMPORTANCE_LOW,
    ).apply { description = "Menjaga perekaman lokasi selama perjalanan." }
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
  }

  private fun publishSnapshot(snapshot: Map<String, Any?>) {
    sendBroadcast(Intent(actionSnapshot).setPackage(packageName).putExtra("snapshot", JSONObject(snapshot).toString()))
  }

  private fun publishError(message: String) {
    sendBroadcast(Intent(actionError).setPackage(packageName).putExtra("message", message))
  }

  companion object {
    internal const val actionSnapshot = "com.cyclecomp.RIDE_SNAPSHOT"
    internal const val actionError = "com.cyclecomp.RIDE_ERROR"
    internal const val actionStart = "com.cyclecomp.RIDE_START"
    internal const val actionPause = "com.cyclecomp.RIDE_PAUSE"
    internal const val actionResume = "com.cyclecomp.RIDE_RESUME"
    internal const val actionStop = "com.cyclecomp.RIDE_STOP"
    private const val notificationChannelId = "cyclecomp_ride_tracking"
    private const val notificationId = 7314

    @Volatile
    var running = false
      private set
  }
}
