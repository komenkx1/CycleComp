package com.cyclecomp

import android.app.Instrumentation
import android.database.sqlite.SQLiteDatabase
import android.os.Bundle
import android.util.Base64
import com.google.crypto.tink.subtle.Ed25519Sign
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

class CycleCompInstrumentationRunner : Instrumentation() {
  override fun onCreate(arguments: Bundle?) {
    super.onCreate(arguments)
    start()
  }

  override fun onStart() {
    val report = Bundle()
    try {
      checkSignedGrid()
      RideTrackingRegression.run(targetContext)
      report.putString("stream", "Terrain signature and grid checks passed. Ride pause, recovery, auto-pause and simulated HR export checks passed.\n")
      finish(android.app.Activity.RESULT_OK, report)
    } catch (error: Throwable) {
      report.putString("stream", android.util.Log.getStackTraceString(error))
      finish(android.app.Activity.RESULT_CANCELED, report)
    }
  }

  private fun checkSignedGrid() {
    val directory = File(targetContext.cacheDir, "terrain-reader-check").apply { deleteRecursively(); mkdirs() }
    try {
      val databaseFile = File(directory, "terrain.sqlite")
      SQLiteDatabase.openOrCreateDatabase(databaseFile, null).use { database ->
        database.execSQL("PRAGMA application_id=1129927500")
        database.execSQL("PRAGMA user_version=1")
        database.execSQL("CREATE TABLE pack_metadata (key TEXT PRIMARY KEY, value TEXT)")
        database.execSQL("INSERT INTO pack_metadata VALUES ('packId', '\"test-grid\"'), ('schemaVersion', '1')")
        database.execSQL("CREATE TABLE elevation_grid_metadata (grid_id TEXT PRIMARY KEY, first_cell_longitude REAL, first_cell_latitude REAL, longitude_step REAL, latitude_step REAL)")
        database.execSQL("INSERT INTO elevation_grid_metadata VALUES ('test-grid', 0.5, 1.5, 1, -1)")
        database.execSQL("CREATE TABLE elevation_grid_blocks (block_id INTEGER PRIMARY KEY, grid_id TEXT, core_start_row INTEGER, core_start_column INTEGER, core_rows INTEGER, core_columns INTEGER, first_cell_longitude REAL, first_cell_latitude REAL, rows INTEGER, columns INTEGER, elevations_f32le BLOB, validity_mask_lsb BLOB, valid_cell_count INTEGER)")
        database.execSQL("CREATE TABLE elevation_grid_block_index_node (nodeno INTEGER PRIMARY KEY, data BLOB)")
        database.execSQL("CREATE TABLE elevation_grid_block_index_rowid (rowid INTEGER PRIMARY KEY, nodeno INTEGER)")
        database.execSQL("CREATE TABLE elevation_grid_block_index_parent (nodeno INTEGER PRIMARY KEY, parentnode INTEGER)")
        val elevations = ByteBuffer.allocate(16).order(ByteOrder.LITTLE_ENDIAN).apply {
          putFloat(-5f); putFloat(5f); putFloat(15f); putFloat(25f)
        }.array()
        database.execSQL("INSERT INTO elevation_grid_blocks VALUES (1, 'test-grid', 0, 0, 2, 2, 0.5, 1.5, 2, 2, ?, ?, 4)", arrayOf(elevations, byteArrayOf(15)))
        val rootNode = ByteBuffer.allocate(28).order(ByteOrder.BIG_ENDIAN).apply {
          putShort(0); putShort(1); putLong(1); putFloat(0f); putFloat(2f); putFloat(0f); putFloat(2f)
        }.array()
        database.execSQL("INSERT INTO elevation_grid_block_index_node VALUES (1, ?)", arrayOf(rootNode))
        database.execSQL("INSERT INTO elevation_grid_block_index_rowid VALUES (1, 1)")
      }
      val signingKey = Ed25519Sign.KeyPair.newKeyPair()
      val trustedKeys = mapOf("fixture-key" to Base64.encodeToString(signingKey.publicKey, Base64.NO_WRAP))
      val manifest = JSONObject()
        .put("packId", "test-grid").put("schemaVersion", 1).put("minimumReaderVersion", 1)
        .put("hasElevationGrid", true).put("hasRoadGraph", false).put("hasRoadProfiles", false)
        .put("requestedBoundsWgs84", JSONArray(listOf(0.0, 0.0, 2.0, 2.0)))
        .put("source", JSONObject().put("coordinateReferenceSystem", "EPSG:4326").put("cellCoordinate", "center").put("verticalDatum", "EGM2008"))
        .put("signatureStatus", "signed").put("signatureKeyId", "fixture-key")
        .put("files", JSONArray().put(JSONObject().put("path", "terrain.sqlite").put("sizeBytes", databaseFile.length()).put("sha256", TerrainGridPackReader.sha256(databaseFile))))
      val manifestBytes = manifest.toString().toByteArray(Charsets.UTF_8)
      File(directory, "manifest.json").writeBytes(manifestBytes)
      val signatureFile = File(directory, "manifest.ed25519")
      signatureFile.writeBytes(Ed25519Sign(signingKey.privateKey).sign(manifestBytes))
      TerrainGridPackReader(directory, trustedKeys).use { reader ->
        check(reader.sample(0.5, 1.5) == -5.0)
        check(reader.sample(1.0, 1.0) == 10.0)
        check(reader.sample(3.0, 1.0) == null)
      }
      check(runCatching { TerrainGridPackReader(directory, emptyMap()).close() }.isFailure)
      val signature = signatureFile.readBytes().also { it[0] = (it[0].toInt() xor 1).toByte() }
      signatureFile.writeBytes(signature)
      check(runCatching { TerrainGridPackReader(directory, trustedKeys).close() }.isFailure)
      signatureFile.writeBytes(Ed25519Sign(signingKey.privateKey).sign(manifestBytes))
      databaseFile.appendBytes(byteArrayOf(0))
      check(runCatching { TerrainGridPackReader(directory, trustedKeys).close() }.isFailure)
    } finally { directory.deleteRecursively() }
  }
}
