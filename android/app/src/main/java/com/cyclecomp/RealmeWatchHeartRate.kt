package com.cyclecomp

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import java.util.UUID

@SuppressLint("MissingPermission")
internal class RealmeWatchHeartRate(
  private val context: Context,
  private val rideDurationSeconds: () -> Int,
  private val rideDistanceMeters: () -> Int,
  private val onChange: () -> Unit,
  private val onSample: (Int, Long) -> Unit,
) {
  @Volatile var enabled = false
    private set
  @Volatile var status = "off"
    private set
  @Volatile var message: String? = null
    private set
  @Volatile var beatsPerMinute: Int? = null
    private set
  @Volatile var lastSampleAt: Long? = null
    private set

  val currentHeartRate: Int?
    get() = if (status == "active" && lastSampleAt?.let { System.currentTimeMillis() - it in 0L..15_000L } == true) beatsPerMinute else null

  private val main = Handler(Looper.getMainLooper())
  private val adapter: BluetoothAdapter? get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
  private var gatt: BluetoothGatt? = null
  private var commandChannel: BluetoothGattCharacteristic? = null
  private var notificationsReady = false
  private var desiredRideState = "idle"
  private var sessionTime: ByteArray? = null
  private var isExternalSession = false
  private var pendingWrite = false
  private val writeQueue = ArrayDeque<ByteArray>()
  private val descriptors = ArrayDeque<BluetoothGattDescriptor>()
  private var scanTimeout: Runnable? = null
  private var responseTimeout: Runnable? = null
  private var writeTimeout: Runnable? = null
  private var poll: Runnable? = null

  fun setEnabled(useWatch: Boolean) = runOnMain {
    enabled = useWatch
    if (useWatch) findWatch() else {
      desiredRideState = "idle"
      cancelTimers()
      stopScan()
      closeGatt()
      sessionTime = null
      isExternalSession = false
      beatsPerMinute = null
      lastSampleAt = null
      changeStatus("off")
    }
  }

  fun startRide() = runOnMain { startRideOnMain() }
  fun pauseRide() = runOnMain { pauseRideOnMain() }
  fun resumeRide() = runOnMain { resumeRideOnMain() }
  fun finishRide() = runOnMain { finishRideOnMain() }

  private fun runOnMain(action: () -> Unit) {
    val guardedAction = {
      try {
        action()
      } catch (_: SecurityException) {
        cancelTimers()
        closeGatt()
        changeStatus("disconnected", "Izinkan Bluetooth untuk CycleComp agar jam dapat terhubung.")
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) guardedAction() else main.post { guardedAction() }
  }

  private fun startRideOnMain() {
    if (!enabled) return
    desiredRideState = "active"
    beatsPerMinute = null
    lastSampleAt = null
    if (sessionTime != null && !isExternalSession) {
      changeStatus("error", "Akhiri sesi sebelumnya di jam sebelum memulai HR lagi.")
    } else if (notificationsReady) requestSessionStart() else findWatch()
  }

  private fun pauseRideOnMain() {
    if (!enabled) return
    desiredRideState = "paused"
    cancelPoll()
    when {
      isExternalSession -> changeStatus("paused", "HR dijeda (sesi jam tetap berjalan)")
      sessionTime != null && status == "active" -> {
        changeStatus("pausing")
        send(byteArrayOf(0x10, 0x04) + sessionTime!!)
        awaitResponse("pausing")
      }
      sessionTime == null -> {
        cancelResponseTimeout()
        changeStatus("paused")
      }
    }
  }

  private fun resumeRideOnMain() {
    if (!enabled) return
    desiredRideState = "active"
    when {
      status == "pausing" -> return
      isExternalSession -> beginPolling()
      sessionTime != null && status == "paused" -> {
        beatsPerMinute = null
        lastSampleAt = null
        changeStatus("resuming")
        send(byteArrayOf(0x10, 0x05) + sessionTime!!)
        awaitResponse("resuming")
      }
      sessionTime == null -> startRideOnMain()
      else -> changeStatus("error", "Cek sesi jam; HR belum bisa dilanjutkan otomatis.")
    }
  }

  private fun finishRideOnMain() {
    desiredRideState = "idle"
    cancelPoll()
    if (status in setOf("starting", "pausing", "resuming")) return
    cancelResponseTimeout()
    if (isExternalSession) {
      clearSession()
      if (enabled) changeStatus(if (notificationsReady) "ready" else "disconnected", "Sesi CycleComp selesai. Sesi jam dapat diakhiri di jam.")
      return
    }
    val time = sessionTime
    if (time == null) {
      if (enabled) changeStatus(if (notificationsReady) "ready" else "disconnected")
      return
    }
    changeStatus("stopping")
    send(RealmeWatchProtocol.end(time, sessionDuration(), rideDistanceMeters().coerceAtLeast(0)))
    awaitResponse("stopping")
  }

  private fun clearSession() {
    sessionTime = null
    beatsPerMinute = null
    lastSampleAt = null
    isExternalSession = false
  }

  private fun hasPermissions(): Boolean {
    val permissions = if (Build.VERSION.SDK_INT >= 31) listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    else listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    return permissions.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
  }

  private fun findWatch() {
    if (!enabled) return
    if (!hasPermissions() || adapter?.isEnabled != true) {
      changeStatus("disconnected", "Aktifkan Bluetooth dan izinkan akses untuk CycleComp.")
      return
    }
    if (notificationsReady) {
      if (desiredRideState == "active") requestSessionStart()
      return
    }
    stopScan()
    closeGatt()
    val scanner = adapter?.bluetoothLeScanner
    if (scanner == null) {
      changeStatus("disconnected", "Bluetooth tidak tersedia di perangkat ini.")
      return
    }
    changeStatus("connecting")
    val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(serviceUuid)).build()
    scanner.startScan(listOf(filter), ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback)
    scanTimeout = Runnable {
      stopScan()
      closeGatt()
      changeStatus("disconnected", "Watch 5 belum terhubung. Dekatkan jam dan sambungkan lewat Realme Link.")
    }.also { main.postDelayed(it, 15_000) }
  }

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) = runOnMain {
      val watchName = result.scanRecord?.deviceName ?: result.device.name ?: ""
      if (enabled && status == "connecting" && watchName.contains("watch 5", ignoreCase = true) && gatt == null) {
        stopScan()
        gatt = result.device.connectGatt(context, false, gattCallback, BluetoothDeviceTransport.LE)
      }
    }
    override fun onScanFailed(errorCode: Int) = runOnMain {
      stopScan()
      changeStatus("error", "Pencarian Bluetooth gagal. Coba aktifkan ulang Bluetooth.")
    }
  }

  private val gattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(connection: BluetoothGatt, gattStatus: Int, newState: Int) = runOnMain {
      if (connection != gatt) return@runOnMain
      if (gattStatus == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
        if (!connection.discoverServices()) changeStatus("error", "Layanan Watch 5 belum bisa dibaca.")
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED || gattStatus != BluetoothGatt.GATT_SUCCESS) {
        closeGatt()
        cancelTimers()
        if (enabled) changeStatus("disconnected", "Watch 5 terputus. Cek sesi jam; rekaman GPS tetap berjalan.")
      }
    }

    override fun onServicesDiscovered(connection: BluetoothGatt, gattStatus: Int) = runOnMain {
      if (connection != gatt) return@runOnMain
      val service = connection.getService(serviceUuid)
      commandChannel = service?.getCharacteristic(commandUuid)
      val notification = service?.getCharacteristic(notificationUuid)
      if (gattStatus != BluetoothGatt.GATT_SUCCESS || commandChannel == null || notification == null ||
        notification.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0) {
        changeStatus("error", "Kanal Watch 5 belum siap.")
        return@runOnMain
      }
      val notifyChannels = listOfNotNull(notification, service?.getCharacteristic(extraNotificationUuid))
      for (channel in notifyChannels) {
        if (channel.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0) continue
        val descriptor = channel.getDescriptor(clientConfigurationUuid) ?: continue
        if (connection.setCharacteristicNotification(channel, true)) descriptors.addLast(descriptor)
      }
      if (descriptors.none { it.characteristic.uuid == notificationUuid }) {
        changeStatus("error", "Notifikasi Watch 5 belum dapat diaktifkan.")
      } else enableNextNotification(connection)
    }

    override fun onDescriptorWrite(connection: BluetoothGatt, descriptor: BluetoothGattDescriptor, gattStatus: Int) = runOnMain {
      if (connection != gatt) return@runOnMain
      if (descriptor.characteristic.uuid == notificationUuid) {
        if (gattStatus != BluetoothGatt.GATT_SUCCESS) {
          changeStatus("error", "Notifikasi Watch 5 belum dapat diaktifkan.")
          return@runOnMain
        }
        notificationsReady = true
      }
      enableNextNotification(connection)
    }

    override fun onCharacteristicWrite(connection: BluetoothGatt, characteristic: BluetoothGattCharacteristic, gattStatus: Int) = runOnMain {
      if (connection != gatt) return@runOnMain
      pendingWrite = false
      writeTimeout?.let(main::removeCallbacks)
      writeTimeout = null
      if (gattStatus != BluetoothGatt.GATT_SUCCESS) {
        writeQueue.clear()
        cancelResponseTimeout()
        changeStatus("error", "Perintah ke Watch 5 gagal. Cek sesi di jam.")
      } else writeNext()
    }

    @Deprecated("Deprecated in Android 13")
    override fun onCharacteristicChanged(connection: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      val bytes = characteristic.value?.copyOf() ?: return
      runOnMain { if (connection == gatt) receive(bytes) }
    }

    override fun onCharacteristicChanged(connection: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      val bytes = value.copyOf()
      runOnMain { if (connection == gatt) receive(bytes) }
    }
  }

  private fun enableNextNotification(connection: BluetoothGatt) {
    val next = descriptors.removeFirstOrNull()
    if (next == null) {
      if (notificationsReady) {
        scanTimeout?.let(main::removeCallbacks)
        scanTimeout = null
        changeStatus("ready")
        if (desiredRideState == "active") requestSessionStart()
      }
      return
    }
    @Suppress("DEPRECATION")
    next.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
    @Suppress("DEPRECATION")
    if (!connection.writeDescriptor(next)) {
      if (next.characteristic.uuid == notificationUuid) changeStatus("error", "Notifikasi Watch 5 belum dapat diaktifkan.")
      else enableNextNotification(connection)
    }
  }

  private fun requestSessionStart() {
    if (sessionTime != null || status == "readingInfo" || status == "starting" || desiredRideState != "active") return
    changeStatus("readingInfo")
    send(byteArrayOf(0x02, 0x01))
    awaitResponse("readingInfo")
  }

  private fun beginSession() {
    if (desiredRideState != "active") return
    val time = RealmeWatchProtocol.sessionClock()
    sessionTime = time
    changeStatus("starting")
    send(RealmeWatchProtocol.start(time))
    awaitResponse("starting")
  }

  private fun sessionDuration(): Int = rideDurationSeconds().coerceAtLeast(0)

  private fun send(bytes: ByteArray) {
    if (gatt == null || commandChannel == null || !notificationsReady) {
      changeStatus("disconnected", "Watch 5 terputus. Cek dan akhiri sesi di jam bila masih aktif.")
      return
    }
    writeQueue.addLast(RealmeWatchProtocol.encode(bytes))
    writeNext()
  }

  private fun writeNext() {
    if (pendingWrite || writeQueue.isEmpty()) return
    val connection = gatt ?: return
    val channel = commandChannel ?: return
    @Suppress("DEPRECATION")
    channel.value = writeQueue.removeFirst()
    channel.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
    @Suppress("DEPRECATION")
    if (connection.writeCharacteristic(channel)) {
      pendingWrite = true
      writeTimeout = Runnable {
        pendingWrite = false
        writeQueue.clear()
        closeGatt()
        cancelResponseTimeout()
        changeStatus("error", "Perintah ke Watch 5 belum selesai. Cek sesi di jam.")
      }.also { main.postDelayed(it, 10_000) }
    } else {
      writeQueue.clear()
      changeStatus("error", "Perintah ke Watch 5 gagal. Cek sesi di jam.")
    }
  }

  private fun receive(encoded: ByteArray) {
    val packet = RealmeWatchProtocol.encode(encoded)
    if (packet.size >= 2 && packet[0] == 0x02.toByte() && packet[1] == 0x01.toByte() && status == "readingInfo") {
      cancelResponseTimeout()
      beginSession()
      return
    }
    if (packet.size < 3 || packet[0] != 0x10.toByte()) return
    val code = packet[2].toInt() and 0xff
    when (packet[1].toInt() and 0xff) {
      1 -> if (sessionTime != null && (status == "starting" || status == "error")) {
        cancelResponseTimeout()
        if (code == 0 || code == 1) {
          isExternalSession = code == 1
          beginPolling()
          if (desiredRideState == "paused") pauseRideOnMain() else if (desiredRideState == "idle") finishRideOnMain()
        } else {
          clearSession()
          changeStatus("error", "Watch 5 menolak start olahraga.")
        }
      }
      2 -> if (status == "active" && desiredRideState == "active") {
        RealmeWatchProtocol.heartRate(packet)?.let { bpm ->
          val now = System.currentTimeMillis()
          beatsPerMinute = bpm
          lastSampleAt = now
          onSample(bpm, now)
          onChange()
        }
      }
      3 -> if (status == "stopping" || status == "error") {
        cancelResponseTimeout()
        if (code == 0) {
          clearSession()
          changeStatus(if (enabled) "ready" else "off")
        } else changeStatus("error", "Stop belum diterima. Akhiri sesi di jam.")
      }
      4 -> if (status == "pausing") {
        cancelResponseTimeout()
        if (code == 0) {
          changeStatus("paused")
          if (desiredRideState == "active") resumeRideOnMain() else if (desiredRideState == "idle") finishRideOnMain()
        } else changeStatus("error", "Jeda jam belum dikonfirmasi.")
      }
      5 -> if (status == "resuming") {
        cancelResponseTimeout()
        if (code == 0) {
          beginPolling()
          if (desiredRideState == "paused") pauseRideOnMain() else if (desiredRideState == "idle") finishRideOnMain()
        } else changeStatus("error", "Jam menolak melanjutkan sesi HR.")
      }
    }
  }

  private fun beginPolling() {
    cancelPoll()
    changeStatus("active", if (isExternalSession) "HR aktif (sesi jam)" else null)
    poll = object : Runnable {
      override fun run() {
        val time = sessionTime ?: return
        if (desiredRideState != "active" || status != "active") return
        if (!pendingWrite) send(RealmeWatchProtocol.update(time, sessionDuration(), rideDistanceMeters().coerceAtLeast(0)))
        if (lastSampleAt?.let { System.currentTimeMillis() - it > 15_000 } == true) onChange()
        main.postDelayed(this, 3_000)
      }
    }.also { main.postDelayed(it, 3_000) }
  }

  private fun awaitResponse(expectedStatus: String) {
    cancelResponseTimeout()
    responseTimeout = Runnable {
      if (status == expectedStatus) changeStatus("error", "Jam belum mengonfirmasi perintah. Cek sesi olahraga di jam.")
    }.also { main.postDelayed(it, 10_000) }
  }

  private fun changeStatus(nextStatus: String, explanation: String? = null) {
    status = nextStatus
    message = explanation
    onChange()
  }

  private fun cancelPoll() { poll?.let(main::removeCallbacks); poll = null }
  private fun cancelResponseTimeout() { responseTimeout?.let(main::removeCallbacks); responseTimeout = null }
  private fun cancelTimers() {
    cancelPoll()
    cancelResponseTimeout()
    scanTimeout?.let(main::removeCallbacks)
    scanTimeout = null
  }
  private fun stopScan() { if (hasPermissions()) runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } }
  private fun closeGatt() {
    runCatching { gatt?.close() }
    writeTimeout?.let(main::removeCallbacks)
    writeTimeout = null
    gatt = null
    notificationsReady = false
    commandChannel = null
    descriptors.clear()
    writeQueue.clear()
    pendingWrite = false
  }

  private object BluetoothDeviceTransport { const val LE = 2 }
  private companion object {
    fun uuid(short: String): UUID = UUID.fromString("0000${short}-0000-1000-8000-00805f9b34fb")
    val serviceUuid = uuid("0af0")
    val commandUuid = uuid("0af6")
    val notificationUuid = uuid("0af7")
    val extraNotificationUuid = uuid("0af2")
    val clientConfigurationUuid = uuid("2902")
  }
}
