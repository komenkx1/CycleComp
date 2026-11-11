package com.cyclecomp

import android.database.sqlite.SQLiteDatabase
import android.util.Base64
import com.google.crypto.tink.subtle.Ed25519Verify
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.round

internal class TerrainGridPackReader(private val directory: File, trustedKeys: Map<String, String> = signingKeys) : AutoCloseable {
  private data class SpatialEntry(val id: Long, val west: Double, val east: Double, val south: Double, val north: Double)
  companion object {
    const val MAX_MANIFEST_BYTES = 1024 * 1024L
    const val MAX_DATABASE_BYTES = 256 * 1024 * 1024L
    private val signingKeys = mapOf(
      "terrain-test-2026" to "HAr3X/jepUfM3G4uKa4p9FkI62yzbiw6yRtbx5S2h30=",
      "terrain-release-2026" to "JRRCNfZSr9FT4f7sHG+YFEiE6722krgIdv6Pi5+h7XE=",
    )
    val signingKeyCount: Int get() = signingKeys.size
    private val identifierPattern = Regex("^[a-z0-9][a-z0-9._-]{0,95}$")
    private val hashPattern = Regex("^[0-9a-f]{64}$")

    fun validateManifest(directory: File, expectedHash: String? = null, trustedKeys: Map<String, String> = signingKeys): JSONObject {
      val manifestFile = File(directory, "manifest.json")
      require(manifestFile.isFile && manifestFile.length() in 1..MAX_MANIFEST_BYTES) { "Manifest medan tidak valid." }
      val manifestBytes = manifestFile.readBytes()
      val manifest = JSONObject(String(manifestBytes, Charsets.UTF_8))
      val packID = manifest.getString("packId")
      require(identifierPattern.matches(packID) && manifest.getInt("schemaVersion") == 1 &&
        manifest.getInt("minimumReaderVersion") in 1..2 && manifest.getBoolean("hasElevationGrid")) {
        "Versi atau identitas paket medan tidak didukung."
      }
      val source = manifest.getJSONObject("source")
      require(source.getString("coordinateReferenceSystem") == "EPSG:4326" &&
        source.getString("cellCoordinate") == "center" && source.getString("verticalDatum").isNotBlank()) {
        "Sistem koordinat paket medan tidak didukung."
      }
      val bounds = manifest.getJSONArray("requestedBoundsWgs84")
      require(bounds.length() == 4) { "Batas paket medan tidak valid." }
      val coordinates = DoubleArray(4) { bounds.getDouble(it) }
      require(coordinates.all { it.isFinite() } && coordinates[0] >= -180 && coordinates[2] <= 180 &&
        coordinates[1] >= -90 && coordinates[3] <= 90 && coordinates[0] < coordinates[2] && coordinates[1] < coordinates[3]) {
        "Batas paket medan tidak valid."
      }
      require(!manifest.optBoolean("hasRoadProfiles") || manifest.optBoolean("hasRoadGraph")) { "Profil jalan tidak memiliki grafik." }
      val graph = manifest.optJSONObject("roadGraph")
      if (graph != null && !graph.isNull("bicycleAccessPolicyVersion")) {
        require(graph.getString("bicycleAccessPolicyVersion") == "cyclecomp-bicycle-access-v1" &&
          manifest.getInt("minimumReaderVersion") >= 2) { "Kebijakan akses jalan tidak didukung." }
      }
      require(manifest.getString("signatureStatus") == "signed") { "Paket medan harus ditandatangani." }
      val keyID = manifest.getString("signatureKeyId")
      val encodedKey = trustedKeys[keyID] ?: error("Kunci tanda tangan paket medan tidak dikenal.")
      val signatureFile = File(directory, "manifest.ed25519")
      require(signatureFile.isFile && signatureFile.length() == 64L) { "Tanda tangan paket medan tidak valid." }
      Ed25519Verify(Base64.decode(encodedKey, Base64.DEFAULT)).verify(signatureFile.readBytes(), manifestBytes)
      val files = manifest.getJSONArray("files")
      require(files.length() == 1) { "Isi paket medan tidak didukung." }
      val database = files.getJSONObject(0)
      val hash = database.getString("sha256")
      require(database.getString("path") == "terrain.sqlite" && hashPattern.matches(hash) &&
        database.getLong("sizeBytes") in 1..MAX_DATABASE_BYTES && (expectedHash == null || hash == expectedHash)) {
        "Identitas database medan tidak valid."
      }
      return manifest
    }

    fun sha256(file: File): String {
      val digest = MessageDigest.getInstance("SHA-256")
      file.inputStream().buffered().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          digest.update(buffer, 0, count)
        }
      }
      return digest.digest().joinToString("") { "%02x".format(it) }
    }
  }

  val manifest: JSONObject = validateManifest(directory, trustedKeys = trustedKeys)
  val packID: String = manifest.getString("packId")
  val verticalDatum: String = manifest.getJSONObject("source").getString("verticalDatum")
  val databaseHash: String = manifest.getJSONArray("files").getJSONObject(0).getString("sha256")
  val bounds: DoubleArray = DoubleArray(4) { manifest.getJSONArray("requestedBoundsWgs84").getDouble(it) }
  val area: Double get() = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])
  private val database: SQLiteDatabase
  private val firstLongitude: Double
  private val firstLatitude: Double
  private val longitudeStep: Double
  private val latitudeStep: Double
  private val elevationIndex: Map<Long, SpatialEntry>

  init {
    val databaseFile = File(directory, "terrain.sqlite")
    val databaseRecord = manifest.getJSONArray("files").getJSONObject(0)
    require(databaseFile.isFile && databaseFile.length() == databaseRecord.getLong("sizeBytes") &&
      sha256(databaseFile) == databaseHash) { "Ukuran atau hash database medan tidak cocok." }
    val openedDatabase = SQLiteDatabase.openDatabase(databaseFile.path, null, SQLiteDatabase.OPEN_READONLY)
    try {
      fun scalar(query: String): String = openedDatabase.rawQuery(query, null).use { cursor ->
        require(cursor.moveToFirst()) { "Database medan tidak lengkap." }
        cursor.getString(0)
      }
      require(scalar("PRAGMA user_version") == "1" && scalar("PRAGMA application_id") == "1129927500" &&
        scalar("PRAGMA integrity_check") == "ok") {
        "Integritas database medan gagal."
      }
      if (manifest.optBoolean("hasRoadGraph")) {
        require(scalar("SELECT COUNT(*) FROM road_edges").toInt() == readSpatialIndex(openedDatabase, "road_edge_index").size &&
          scalar("SELECT COUNT(*) FROM road_edges WHERE matchable NOT IN (0, 1) OR predictable NOT IN (0, 1)") == "0" &&
          scalar("SELECT COUNT(*) FROM road_edges WHERE predictable = 1 AND (matchable != 1 OR direction_state != 'allowed' OR bicycle_access NOT IN ('allowed', 'road_class_inferred'))") == "0") {
          "Indeks atau aturan akses grafik jalan tidak valid."
        }
        val accessPolicy = manifest.optJSONObject("roadGraph")?.optString("bicycleAccessPolicyVersion")?.takeIf { it.isNotEmpty() }
        if (accessPolicy != null) {
          val storedPolicy = scalar("SELECT value FROM road_graph_metadata WHERE key = 'bicycleAccessPolicyVersion'")
          require(JSONObject("{\"value\":$storedPolicy}").getString("value") == accessPolicy) { "Kebijakan akses jalan tidak cocok." }
        } else {
          require(scalar("SELECT COUNT(*) FROM road_edges WHERE bicycle_access = 'road_class_inferred'") == "0") { "Kebijakan akses jalan tidak tersedia." }
        }
        if (manifest.optBoolean("hasRoadProfiles")) {
          val predictable = scalar("SELECT COUNT(*) FROM road_edges WHERE predictable = 1")
          val assigned = scalar("SELECT COUNT(*) FROM road_corridor_edges AS c JOIN road_edges AS e ON e.edge_id = c.edge_id WHERE e.predictable = 1")
          val unassigned = scalar("SELECT COUNT(*) FROM road_edges AS e WHERE e.predictable = 1 AND NOT EXISTS (SELECT 1 FROM road_corridor_edges AS c WHERE c.edge_id = e.edge_id)")
          require(predictable == assigned && unassigned == "0" && scalar("SELECT COUNT(*) FROM road_corridors").toLong() > 0) {
            "Profil koridor jalan tidak lengkap."
          }
        }
      }
      val storedPack = scalar("SELECT value FROM pack_metadata WHERE key = 'packId'")
      require(JSONObject("{\"value\":$storedPack}").getString("value") == packID &&
        scalar("SELECT value FROM pack_metadata WHERE key = 'schemaVersion'") == "1") { "Identitas database medan tidak cocok." }
      val metadata = openedDatabase.rawQuery(
        "SELECT first_cell_longitude, first_cell_latitude, longitude_step, latitude_step FROM elevation_grid_metadata WHERE grid_id = ?",
        arrayOf(packID),
      ).use { cursor ->
        require(cursor.moveToFirst()) { "Metadata grid medan tidak tersedia." }
        DoubleArray(4) { cursor.getDouble(it) }
      }
      require(metadata.all { it.isFinite() } && metadata[2] > 0 && metadata[3] < 0) { "Transformasi grid medan tidak valid." }
      firstLongitude = metadata[0]
      firstLatitude = metadata[1]
      longitudeStep = metadata[2]
      latitudeStep = metadata[3]
      database = openedDatabase
      elevationIndex = readSpatialIndex(database, "elevation_grid_block_index")
      validateBlocks()
    } catch (error: Throwable) {
      openedDatabase.close()
      throw error
    }
  }

  private fun readSpatialIndex(database: SQLiteDatabase, indexName: String): Map<Long, SpatialEntry> {
    require(indexName == "elevation_grid_block_index" || indexName == "road_edge_index")
    val entries = mutableMapOf<Long, SpatialEntry>()
    val visitedNodes = mutableSetOf<Long>()
    val entryNodes = mutableMapOf<Long, Long>()
    val nodeParents = mutableMapOf<Long, Long>()
    val nodeCount = database.rawQuery("SELECT COUNT(*) FROM ${indexName}_node", null).use {
      require(it.moveToFirst()); it.getLong(0)
    }
    require(nodeCount in 1..1_000_000) { "Ukuran indeks spasial tidak valid." }
    fun readNode(nodeID: Long, depth: Int?, parent: SpatialEntry?) {
      require(visitedNodes.add(nodeID) && visitedNodes.size <= nodeCount) { "Indeks spasial memiliki siklus." }
      val bytes = database.rawQuery("SELECT data FROM ${indexName}_node WHERE nodeno = ?", arrayOf(nodeID.toString())).use {
        require(it.moveToFirst()) { "Node indeks spasial tidak tersedia." }; it.getBlob(0)
      }
      require(bytes.size >= 4) { "Node indeks spasial tidak valid." }
      val node = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
      val nodeDepth = depth ?: (node.getShort(0).toInt() and 0xffff)
      val childCount = node.getShort(2).toInt() and 0xffff
      require(nodeDepth in 0..40 && childCount <= (bytes.size - 4) / 24 && (childCount > 0 || nodeID == 1L)) {
        "Isi node indeks spasial tidak valid."
      }
      repeat(childCount) { child ->
        val offset = 4 + child * 24
        val entry = SpatialEntry(node.getLong(offset), node.getFloat(offset + 8).toDouble(), node.getFloat(offset + 12).toDouble(),
          node.getFloat(offset + 16).toDouble(), node.getFloat(offset + 20).toDouble())
        require(listOf(entry.west, entry.east, entry.south, entry.north).all { it.isFinite() } &&
          entry.west <= entry.east && entry.south <= entry.north &&
          (parent == null || (entry.west >= parent.west && entry.east <= parent.east &&
            entry.south >= parent.south && entry.north <= parent.north))) { "Batas indeks spasial tidak valid." }
        if (nodeDepth == 0) {
          require(entries.put(entry.id, entry) == null) { "Indeks spasial memiliki entri ganda." }
          entryNodes[entry.id] = nodeID
        } else {
          nodeParents[entry.id] = nodeID
          readNode(entry.id, nodeDepth - 1, entry)
        }
      }
    }
    readNode(1, null, null)
    require(visitedNodes.size.toLong() == nodeCount) { "Node indeks spasial tidak terhubung." }
    var rowCount = 0
    database.rawQuery("SELECT rowid, nodeno FROM ${indexName}_rowid", null).use { cursor ->
      while (cursor.moveToNext()) {
        require(entryNodes[cursor.getLong(0)] == cursor.getLong(1)) { "Pemetaan indeks spasial tidak valid." }
        rowCount++
      }
    }
    require(entries.size == rowCount) { "Entri indeks spasial tidak lengkap." }
    var parentCount = 0
    database.rawQuery("SELECT nodeno, parentnode FROM ${indexName}_parent", null).use { cursor ->
      while (cursor.moveToNext()) {
        require(nodeParents[cursor.getLong(0)] == cursor.getLong(1)) { "Hubungan node indeks spasial tidak valid." }
        parentCount++
      }
    }
    require(parentCount == nodeParents.size) { "Induk indeks spasial tidak lengkap." }
    return entries
  }

  private fun validateBlocks() {
    val gridOffsets = doubleArrayOf((firstLatitude - bounds[3]) / abs(latitudeStep) - 1e-9,
      (firstLatitude - bounds[1]) / abs(latitudeStep) - 1e-9,
      (bounds[0] - firstLongitude) / longitudeStep - 1e-9,
      (bounds[2] - firstLongitude) / longitudeStep - 1e-9)
    require(gridOffsets.all { it.isFinite() && abs(it) < 20_000_000 }) { "Koordinat grid medan tidak valid." }
    val firstRow = ceil(gridOffsets[0]).toInt()
    val stopRow = ceil(gridOffsets[1]).toInt()
    val firstColumn = ceil(gridOffsets[2]).toInt()
    val stopColumn = ceil(gridOffsets[3]).toInt()
    require(firstRow < stopRow && firstColumn < stopColumn &&
      (stopRow.toLong() - firstRow) * (stopColumn.toLong() - firstColumn) <= 20_000_000L) { "Ukuran grid medan tidak valid." }
    var count = 0
    val coreOrigins = mutableSetOf<Pair<Int, Int>>()
    val query = """SELECT b.core_start_row, b.core_start_column, b.core_rows, b.core_columns,
      b.first_cell_longitude, b.first_cell_latitude, b.rows, b.columns, b.elevations_f32le,
      b.validity_mask_lsb, b.valid_cell_count, b.block_id FROM elevation_grid_blocks b WHERE b.grid_id = ?"""
    database.rawQuery(query, arrayOf(packID)).use { cursor ->
      while (cursor.moveToNext()) {
        val coreRow = cursor.getInt(0); val coreColumn = cursor.getInt(1)
        require(coreOrigins.add(coreRow to coreColumn)) { "Blok grid bertumpuk." }
        val coreRows = cursor.getInt(2); val coreColumns = cursor.getInt(3)
        val firstBlockLongitude = cursor.getDouble(4); val firstBlockLatitude = cursor.getDouble(5)
        val rows = cursor.getInt(6); val columns = cursor.getInt(7)
        val elevations = cursor.getBlob(8); val mask = cursor.getBlob(9)
        require(rows in 1..64 && columns in 1..64 && coreRows in 1..62 && coreColumns in 1..62 &&
          firstBlockLongitude.isFinite() && firstBlockLatitude.isFinite() &&
          elevations.size == rows * columns * 4 && mask.size == (rows * columns + 7) / 8) { "Ukuran blok grid tidak valid." }
        val blockColumn = (firstBlockLongitude - firstLongitude) / longitudeStep
        val blockRow = (firstBlockLatitude - firstLatitude) / latitudeStep
        require(abs(blockColumn - round(blockColumn)) < 1e-6 && abs(blockRow - round(blockRow)) < 1e-6 &&
          coreColumn - round(blockColumn).toInt() in 0..1 && coreRow - round(blockRow).toInt() in 0..1 &&
          coreColumn - round(blockColumn).toInt() + coreColumns <= columns &&
          coreRow - round(blockRow).toInt() + coreRows <= rows &&
          coreColumn >= firstColumn && coreRow >= firstRow && coreColumn < stopColumn && coreRow < stopRow &&
          (coreColumn - firstColumn) % 62 == 0 && (coreRow - firstRow) % 62 == 0 &&
          coreColumns == min(62, stopColumn - coreColumn) && coreRows == min(62, stopRow - coreRow)) { "Blok grid tidak sesuai batas paket." }
        val spatial = elevationIndex[cursor.getLong(11)] ?: error("Indeks spasial grid tidak lengkap.")
        require(spatial.west <= firstBlockLongitude - longitudeStep / 2 + 1e-7 &&
          spatial.east >= firstBlockLongitude + (columns - 0.5) * longitudeStep - 1e-7 &&
          spatial.south <= firstBlockLatitude + (rows - 0.5) * latitudeStep + 1e-7 &&
          spatial.north >= firstBlockLatitude - latitudeStep / 2 - 1e-7) { "Indeks spasial grid tidak valid." }
        val cellCount = rows * columns
        if (cellCount % 8 != 0) require((mask.last().toInt() and 0xff) shr (cellCount % 8) == 0) { "Mask grid tidak valid." }
        val floatBytes = ByteBuffer.wrap(elevations).order(ByteOrder.LITTLE_ENDIAN)
        var validCount = 0
        for (index in 0 until cellCount) {
          if ((mask[index / 8].toInt() and (1 shl (index % 8))) != 0) {
            require(floatBytes.getFloat(index * 4).isFinite()) { "Elevasi grid tidak valid." }
            validCount++
          }
        }
        require(validCount > 0 && validCount == cursor.getInt(10)) { "Jumlah sel grid tidak cocok." }
        count++
      }
    }
    val expectedCount = ((stopRow - firstRow + 61) / 62).toLong() * ((stopColumn - firstColumn + 61) / 62)
    val totalBlocks = database.rawQuery("SELECT COUNT(*) FROM elevation_grid_blocks", null).use { it.moveToFirst(); it.getLong(0) }
    val indexedBlocks = elevationIndex.size.toLong()
    require(count.toLong() == expectedCount && count.toLong() == totalBlocks && totalBlocks == indexedBlocks) { "Blok grid tidak lengkap." }
  }

  fun sample(longitude: Double, latitude: Double): Double? {
    if (!longitude.isFinite() || !latitude.isFinite() || longitude < bounds[0] || longitude > bounds[2] ||
      latitude < bounds[1] || latitude > bounds[3]) return null
    val matchingIDs = elevationIndex.values.filter { longitude >= it.west && longitude <= it.east && latitude >= it.south && latitude <= it.north }
      .map { it.id }.sorted()
    val query = """SELECT first_cell_longitude, first_cell_latitude, rows, columns,
      elevations_f32le, validity_mask_lsb FROM elevation_grid_blocks WHERE block_id = ? AND grid_id = ?"""
    for (blockID in matchingIDs) {
      val sampledElevation = database.rawQuery(query, arrayOf(blockID.toString(), packID)).use { cursor ->
      while (cursor.moveToNext()) {
        val rows = cursor.getInt(2); val columns = cursor.getInt(3)
        val rawColumn = (longitude - cursor.getDouble(0)) / longitudeStep
        val rawRow = (latitude - cursor.getDouble(1)) / latitudeStep
        val column = if (abs(rawColumn - round(rawColumn)) < 1e-8) round(rawColumn) else rawColumn
        val row = if (abs(rawRow - round(rawRow)) < 1e-8) round(rawRow) else rawRow
        if (column < 0 || column > columns - 1 || row < 0 || row > rows - 1) continue
        val left = floor(column).toInt(); val top = floor(row).toInt()
        val right = min(left + 1, columns - 1); val bottom = min(top + 1, rows - 1)
        val dx = column - left; val dy = row - top
        val corners = arrayOf(Triple(top, left, (1 - dx) * (1 - dy)), Triple(top, right, dx * (1 - dy)),
          Triple(bottom, left, (1 - dx) * dy), Triple(bottom, right, dx * dy))
        val elevationBytes = ByteBuffer.wrap(cursor.getBlob(4)).order(ByteOrder.LITTLE_ENDIAN)
        val mask = cursor.getBlob(5)
        var elevation = 0.0; var valid = true
        for ((cornerRow, cornerColumn, weight) in corners) {
          if (weight == 0.0) continue
          val index = cornerRow * columns + cornerColumn
          if ((mask[index / 8].toInt() and (1 shl (index % 8))) == 0) { valid = false; break }
          elevation += elevationBytes.getFloat(index * 4) * weight
        }
        if (valid && elevation.isFinite()) return@use elevation
      }
        null
      }
      if (sampledElevation != null) return sampledElevation
    }
    return null
  }

  override fun close() = database.close()
}
