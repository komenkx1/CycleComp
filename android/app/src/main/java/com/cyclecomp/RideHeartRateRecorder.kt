package com.cyclecomp

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

internal class RideHeartRateRecorder {
  private var output: FileOutputStream? = null
  private var recordingFile: File? = null
  private var rideId: String? = null

  @Synchronized
  fun open(recordingDirectory: File, rideId: String) {
    require(rideId.matches(Regex("[A-Za-z0-9-]+"))) { "ID perjalanan tidak valid." }
    close()
    recordingFile = null
    this.rideId = null
    check(recordingDirectory.isDirectory || recordingDirectory.mkdirs()) { "Direktori rekaman HR tidak tersedia." }
    val file = File(recordingDirectory, "$rideId-hr.jsonl").canonicalFile
    check(file.parentFile == recordingDirectory.canonicalFile) { "Lokasi rekaman HR tidak valid." }
    output = FileOutputStream(file, true)
    recordingFile = file
    this.rideId = rideId
  }

  @Synchronized
  fun append(beatsPerMinute: Int, timestampMillis: Long) {
    require(beatsPerMinute in 1..255) { "Sampel HR tidak valid." }
    val stream = checkNotNull(output) { "Rekaman HR belum dibuka." }
    // Swift JSONEncoder represents Date as seconds since 2001-01-01 UTC.
    val timestamp = timestampMillis / 1000.0 - appleReferenceDateSeconds
    val sample = "{\"timestamp\":$timestamp,\"beatsPerMinute\":$beatsPerMinute}\n"
    stream.write(sample.toByteArray(Charsets.UTF_8))
    stream.fd.sync()
  }

  @Synchronized
  fun close() {
    val stream = output ?: return
    output = null
    try {
      stream.fd.sync()
    } finally {
      stream.close()
    }
  }

  @Synchronized
  fun clear() {
    close()
    recordingFile = null
    rideId = null
  }

  @Synchronized
  fun exportTo(ridesDirectory: File): File? {
    close()
    val source = recordingFile?.takeIf { it.isFile } ?: return null
    val activeRideId = checkNotNull(rideId)
    check(ridesDirectory.isDirectory || ridesDirectory.mkdirs()) { "Direktori hasil ride tidak tersedia." }
    val destination = File(ridesDirectory, "CycleComp-$activeRideId-hr.jsonl").canonicalFile
    check(destination.parentFile == ridesDirectory.canonicalFile) { "Lokasi hasil HR tidak valid." }
    val pendingCopy = File.createTempFile(".hr-export-", ".tmp", ridesDirectory)
    try {
      FileInputStream(source).use { input ->
        FileOutputStream(pendingCopy).use { copy ->
          input.copyTo(copy)
          copy.fd.sync()
        }
      }
      check(pendingCopy.renameTo(destination)) { "File HR belum tersimpan." }
      return destination
    } finally {
      if (pendingCopy.exists()) pendingCopy.delete()
    }
  }

  private companion object {
    const val appleReferenceDateSeconds = 978_307_200.0
  }
}
