package com.cyclecomp

import java.io.File
import java.nio.file.Files

fun main() {
  val root = Files.createTempDirectory("cyclecomp-hr-test").toFile()
  try {
    val recordingDirectory = File(root, "recording")
    val ridesDirectory = File(root, "rides")
    val rideId = "1234-5678"
    val source = File(recordingDirectory, "$rideId-hr.jsonl")
    val firstRecorder = RideHeartRateRecorder()
    firstRecorder.open(recordingDirectory, rideId)
    firstRecorder.append(88, 978_307_201_500)
    firstRecorder.close()
    check(source.readText() == "{\"timestamp\":1.5,\"beatsPerMinute\":88}\n")

    val resumedRecorder = RideHeartRateRecorder()
    resumedRecorder.open(recordingDirectory, rideId)
    resumedRecorder.append(92, 978_307_203_000)
    check(source.readLines().size == 2)
    val invalidDestination = File(root, "not-a-directory").apply { writeText("keep") }
    check(runCatching { resumedRecorder.exportTo(invalidDestination) }.isFailure)
    check(source.readLines().size == 2 && invalidDestination.readText() == "keep")

    val exported = checkNotNull(resumedRecorder.exportTo(ridesDirectory))
    check(exported.name == "CycleComp-$rideId-hr.jsonl")
    check(exported.readText() == source.readText())
    check(source.exists())
    check(ridesDirectory.listFiles()!!.none { it.name.endsWith(".tmp") })

    resumedRecorder.open(recordingDirectory, rideId)
    resumedRecorder.append(100, 978_307_204_000)
    check(resumedRecorder.exportTo(ridesDirectory)!!.readLines().size == 3)
    check(source.readLines().size == 3)
    val blockedRides = File(root, "blocked-rides").apply { mkdirs() }
    val blockedDestination = File(blockedRides, "CycleComp-$rideId-hr.jsonl").apply { mkdirs() }
    check(runCatching { resumedRecorder.exportTo(blockedRides) }.isFailure)
    check(source.readLines().size == 3 && blockedDestination.isDirectory)
    check(blockedRides.listFiles()!!.none { it.name.endsWith(".tmp") })
    check(runCatching { resumedRecorder.open(recordingDirectory, "../outside") }.isFailure)
    check(runCatching { resumedRecorder.append(0, 0) }.isFailure)
    println("HR recording, resume, export and failed-export recovery checks passed")
  } finally {
    root.deleteRecursively()
  }
}
