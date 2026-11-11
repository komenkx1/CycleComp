package com.cyclecomp

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import kotlin.math.sqrt

internal class RidePhoneSensors(context: Context, private val altitudeFusion: RideAltitudeFusion) : SensorEventListener {
  private data class MotionSample(val timestampMillis: Long, val squaredMagnitude: Double)

  private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
  private val pressureSensor = sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE)
  private val accelerationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
  private val rotationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
  private val accelerationSamples = ArrayDeque<MotionSample>()
  private val rotationSamples = ArrayDeque<MotionSample>()
  private var referencePressureHectopascals: Float? = null
  private var pressureRegistered = false
  private var accelerationRegistered = false
  private var rotationRegistered = false
  @Volatile var barometerStatus = "unavailable"
    private set
  @Volatile var motionSensorStatus = "unavailable"
    private set

  @Synchronized
  fun start(retainingElevationMeters: Double? = null, isCalibrated: Boolean = false, reducedRate: Boolean = false) {
    stop()
    altitudeFusion.startNewEpoch(retainingElevationMeters, isCalibrated)
    referencePressureHectopascals = null
    pressureRegistered = pressureSensor?.let { sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) } ?: false
    val motionDelay = if (reducedRate) SensorManager.SENSOR_DELAY_NORMAL else SensorManager.SENSOR_DELAY_GAME
    accelerationRegistered = accelerationSensor?.let { sensorManager.registerListener(this, it, motionDelay) } ?: false
    rotationRegistered = rotationSensor?.let { sensorManager.registerListener(this, it, motionDelay) } ?: false
    barometerStatus = if (pressureRegistered) "starting" else "unavailable"
    motionSensorStatus = if (accelerationRegistered || rotationRegistered) "starting" else "unavailable"
  }

  @Synchronized
  fun stop() {
    sensorManager.unregisterListener(this)
    if (pressureRegistered) barometerStatus = "paused"
    if (accelerationRegistered || rotationRegistered) motionSensorStatus = "paused"
    pressureRegistered = false
    accelerationRegistered = false
    rotationRegistered = false
    accelerationSamples.clear()
    rotationSamples.clear()
    referencePressureHectopascals = null
  }

  @Synchronized
  override fun onSensorChanged(event: SensorEvent) {
    val observedAtMillis = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - event.timestamp) / 1_000_000
    when (event.sensor.type) {
      Sensor.TYPE_PRESSURE -> {
        if (!pressureRegistered) return
        val pressure = event.values.firstOrNull() ?: return
        if (!pressure.isFinite() || pressure <= 0) return
        val reference = referencePressureHectopascals ?: pressure.also { referencePressureHectopascals = it }
        val relativeAltitude = SensorManager.getAltitude(reference, pressure).toDouble()
        altitudeFusion.recordPressure(relativeAltitude, pressure.toDouble() / 10, observedAtMillis)
        barometerStatus = "active"
      }
      Sensor.TYPE_LINEAR_ACCELERATION, Sensor.TYPE_GYROSCOPE -> {
        if (event.sensor.type == Sensor.TYPE_LINEAR_ACCELERATION && !accelerationRegistered) return
        if (event.sensor.type == Sensor.TYPE_GYROSCOPE && !rotationRegistered) return
        if (event.values.size < 3 || event.values.take(3).any { !it.isFinite() }) return
        val scale = if (event.sensor.type == Sensor.TYPE_LINEAR_ACCELERATION) SensorManager.GRAVITY_EARTH.toDouble() else 1.0
        val magnitudeSquared = event.values.take(3).sumOf { (it / scale) * (it / scale) }
        val samples = if (event.sensor.type == Sensor.TYPE_LINEAR_ACCELERATION) accelerationSamples else rotationSamples
        samples.addLast(MotionSample(observedAtMillis, magnitudeSquared))
        while (samples.isNotEmpty() && observedAtMillis - samples.first().timestampMillis > 2_000) samples.removeFirst()
        motionSensorStatus = "active"
      }
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  @Synchronized
  fun motionSummary(nowMillis: Long = System.currentTimeMillis()): Map<String, Double?> = mapOf(
    "motionAccelerationRmsG" to recentRms(accelerationSamples, nowMillis),
    "motionRotationRmsRadiansPerSecond" to recentRms(rotationSamples, nowMillis),
  )

  private fun recentRms(samples: ArrayDeque<MotionSample>, nowMillis: Long): Double? {
    val freshSamples = samples.filter { nowMillis - it.timestampMillis in 0..2_000 }
    if (freshSamples.size < 10) return null
    return sqrt(freshSamples.sumOf { it.squaredMagnitude } / freshSamples.size)
  }
}
