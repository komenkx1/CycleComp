package com.cyclecomp

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

internal class RideSensorTrace {
  private var output: FileOutputStream? = null
  private var bytesWritten = 0L
  private var lastSynchronizedAt = 0L
  var file: File? = null
    private set
  var status = "off"
    private set

  @Synchronized
  fun open(rideId: String, ridesDirectory: File) {
    close()
    file = null
    bytesWritten = 0
    if (!rideId.matches(Regex("[A-Za-z0-9-]+"))) {
      status = "error"
      return
    }
    try {
      check(ridesDirectory.isDirectory || ridesDirectory.mkdirs())
      val traceFile = File(ridesDirectory, "CycleComp-$rideId-sensor.jsonl")
      check(traceFile.canonicalFile.parentFile == ridesDirectory.canonicalFile)
      bytesWritten = traceFile.length()
      file = traceFile
      if (bytesWritten >= maximumBytes) {
        status = "full"
        return
      }
      output = FileOutputStream(traceFile, true)
      status = "active"
      if (bytesWritten == 0L) {
        append("header", JSONObject().put("schemaVersion", 1).put("algorithmVersion", 0).put("platform", "android"))
      } else {
        append("policyReset", JSONObject().put("reason", "recorder_reopened"))
        append("speedReset", JSONObject().put("reason", "recorder_reopened"))
      }
    } catch (_: Exception) {
      fail()
    }
  }

  @Synchronized
  fun append(kind: String, fields: JSONObject = JSONObject()) {
    val stream = output ?: return
    if (status != "active") return
    try {
      val now = System.currentTimeMillis()
      val entry = JSONObject(fields.toString()).put("kind", kind).put("recordedAt", now / 1000.0)
      val line = (entry.toString() + "\n").toByteArray(Charsets.UTF_8)
      if (bytesWritten + line.size > maximumBytes) {
        val endLine = (JSONObject().put("kind", "traceFull").put("recordedAt", now / 1000.0).toString() + "\n")
          .toByteArray(Charsets.UTF_8)
        if (bytesWritten + endLine.size <= maximumBytes) {
          stream.write(endLine)
          bytesWritten += endLine.size
        }
        stream.fd.sync()
        stream.close()
        output = null
        status = "full"
        return
      }
      stream.write(line)
      bytesWritten += line.size
      if (kind == "header" || kind == "policyReset" || kind == "speedReset" || now - lastSynchronizedAt >= 5_000) {
        synchronize()
      }
    } catch (_: Exception) {
      fail()
    }
  }

  @Synchronized
  fun synchronize() {
    try {
      output?.fd?.sync()
      lastSynchronizedAt = System.currentTimeMillis()
    } catch (_: Exception) {
      fail()
    }
  }

  @Synchronized
  fun close() {
    if (output != null) synchronize()
    try {
      output?.close()
    } catch (_: Exception) {
      status = "error"
    }
    output = null
    if (status == "active") status = "complete"
  }

  @Synchronized
  fun clear() {
    close()
    file = null
    bytesWritten = 0
    status = "off"
  }

  private fun fail() {
    try { output?.close() } catch (_: Exception) { }
    output = null
    status = "error"
  }

  companion object {
    private const val maximumBytes = 10_000_000L

    fun savedTraceFile(ridesDirectory: File, requestedFile: File): File {
      val traceFile = requestedFile.canonicalFile
      check(traceFile.parentFile == ridesDirectory.canonicalFile && traceFile.name.startsWith("CycleComp-") &&
        traceFile.name.endsWith("-sensor.jsonl") && traceFile.isFile) {
        "File diagnostik tidak ditemukan di penyimpanan CycleComp."
      }
      return traceFile
    }
  }
}
