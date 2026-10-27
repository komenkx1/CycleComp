package com.cyclecomp

import java.util.Calendar

internal object RealmeWatchProtocol {
  private const val cyclingType = 50

  fun encode(bytes: ByteArray): ByteArray = bytes.map { (it.toInt() xor 0x57).toByte() }.toByteArray()

  fun sessionClock(): ByteArray = Calendar.getInstance().let { clock ->
    byteArrayOf(clock.get(Calendar.DAY_OF_MONTH).toByte(), clock.get(Calendar.HOUR_OF_DAY).toByte(),
      clock.get(Calendar.MINUTE).toByte(), clock.get(Calendar.SECOND).toByte())
  }

  fun start(time: ByteArray): ByteArray = byteArrayOf(0x10, 0x01) + time + byteArrayOf(cyclingType.toByte(), 0, 0, 0, 0, 0, 0)

  fun update(time: ByteArray, duration: Int, distanceMeters: Int): ByteArray =
    byteArrayOf(0x10, 0x02) + time + byteArrayOf(0) + metrics(duration, distanceMeters)

  fun end(time: ByteArray, duration: Int, distanceMeters: Int): ByteArray =
    byteArrayOf(0x10, 0x03) + time + metrics(duration, distanceMeters) + byteArrayOf(cyclingType.toByte(), 0)

  fun heartRate(packet: ByteArray): Int? {
    if (packet.size < 19 || packet[0] != 0x10.toByte() || packet[1] != 0x02.toByte() ||
      packet[2] != 1.toByte()) return null
    return (packet[10].toInt() and 0xff).takeIf { it > 0 }
  }

  private fun metrics(duration: Int, distanceMeters: Int): ByteArray {
    val seconds = duration.coerceIn(0, 0xfffff)
    val meters = distanceMeters.coerceAtLeast(0)
    return byteArrayOf(seconds.toByte(), (seconds shr 8).toByte(), ((seconds shr 16) and 15).toByte(),
      meters.toByte(), (meters shr 8).toByte(), (meters shr 16).toByte(), (meters shr 24).toByte())
  }
}
