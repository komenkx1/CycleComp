package com.cyclecomp

import android.net.Uri
import android.provider.DocumentsContract
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ConcurrentHashMap

class TerrainGridPackModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  private data class Download(
    val operationID: String,
    val releaseID: String,
    val chunkID: String,
    val databaseSha256: String,
    @Volatile var state: String = "preparing",
    @Volatile var bytesWritten: Long = 0,
    @Volatile var totalBytes: Long = 0,
    @Volatile var failure: String? = null,
    @Volatile var cancelled: Boolean = false,
    @Volatile var connection: HttpURLConnection? = null,
  )

  private val storage = File(reactContext.filesDir, "CycleComp/TerrainPacks").apply { mkdirs() }
  private val executor = Executors.newSingleThreadExecutor()
  private val downloads = ConcurrentHashMap<String, Download>()
  private val inventoryLock = Any()
  private val installedReaders = mutableMapOf<String, TerrainGridPackReader>()
  private var inventoryLoaded = false
  private var unavailablePackageCount = 0

  init {
    synchronized(inventoryLock) {
      storage.listFiles()?.filter { it.isDirectory && it.name.startsWith(".replace-") }?.forEach { backup ->
        try {
          TerrainGridPackReader(backup).use { reader ->
            val destination = packDirectory(reader.packID)
            val validDestination = try {
              TerrainGridPackReader(destination).use { it.packID == reader.packID }
            } catch (_: Exception) { false }
            if (validDestination) backup.deleteRecursively()
            else {
              if (destination.exists()) {
                val invalidDirectory = File(storage, ".invalid-${UUID.randomUUID()}")
                check(destination.renameTo(invalidDirectory)) { "Paket medan lama tidak dapat dipulihkan." }
              }
              check(backup.renameTo(destination)) { "Paket medan lama tidak dapat dipulihkan." }
            }
          }
        } catch (_: Exception) {
          // Leave an unreadable backup in place so it can be recovered manually.
        }
      }
      val staleBefore = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
      storage.listFiles()?.filter { it.isDirectory && (it.name.startsWith(".install-") || it.name.startsWith(".download-")) && it.lastModified() < staleBefore }
        ?.forEach { it.deleteRecursively() }
    }
  }

  override fun getName() = "TerrainGridPackStore"

  override fun getConstants(): Map<String, Any> {
    val areaSettings = reactContext.getSharedPreferences("terrain_area_transfer", 0)
    return mapOf("areaSettings" to mapOf(
      "CycleCompPendingTerrainArea" to (areaSettings.getString("CycleCompPendingTerrainArea", "") ?: ""),
      "CycleCompCompletedTerrainAreas" to (areaSettings.getString("CycleCompCompletedTerrainAreas", "") ?: ""),
    ))
  }

  @ReactMethod fun setAreaSetting(key: String, value: String) {
    if (key !in setOf("CycleCompPendingTerrainArea", "CycleCompCompletedTerrainAreas")) return
    reactContext.getSharedPreferences("terrain_area_transfer", 0).edit().putString(key, value).commit()
  }

  override fun invalidate() {
    executor.execute {
      synchronized(inventoryLock) {
        installedReaders.values.forEach { it.close() }
        installedReaders.clear()
      }
    }
    executor.shutdown()
    super.invalidate()
  }

  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Int) = Unit

  private fun run(promise: Promise, operation: () -> Any?) {
    executor.execute {
      try { promise.resolve(operation()) }
      catch (error: Exception) { promise.reject("terrain_pack_error", error.message ?: "Paket medan gagal diproses.", error) }
    }
  }

  @ReactMethod fun getInventory(promise: Promise) = run(promise) {
    synchronized(inventoryLock) {
      loadInstalledPacks()
      val packs = Arguments.createArray()
      installedReaders.values.sortedBy { it.packID }.forEach { packs.pushMap(summary(it)) }
      Arguments.createMap().apply {
        putArray("packs", packs)
        putInt("unavailablePackageCount", unavailablePackageCount)
        putInt("trustedSigningKeyCount", TerrainGridPackReader.signingKeyCount)
        putBoolean("allowUnsignedPilot", false)
      }
    }
  }

  @ReactMethod fun getDownloadStates(promise: Promise) = promise.resolve(downloadStates())

  @ReactMethod fun installPack(directoryURI: String, promise: Promise) = run(promise) {
    val source = Uri.parse(directoryURI)
    val staging = newStagingDirectory()
    try {
      if (source.scheme == "file") {
        val sourceDirectory = File(requireNotNull(source.path))
        require(sourceDirectory.isDirectory) { "Folder paket medan tidak dapat dibaca." }
        val entries = sourceDirectory.listFiles()?.map { it.name }?.toSet() ?: emptySet()
        require(entries == setOf("manifest.json", "manifest.ed25519", "terrain.sqlite")) { "Isi folder paket medan tidak didukung." }
        entries.forEach { name ->
          val sourceFile = File(sourceDirectory, name)
          require(android.system.OsConstants.S_ISREG(android.system.Os.lstat(sourceFile.path).st_mode)) {
            "Berkas paket medan harus berupa file biasa."
          }
          copyLimited(sourceFile.inputStream(), File(staging, name), sizeLimit(name))
        }
      } else {
        require(source.scheme == "content" && DocumentsContract.isTreeUri(source)) { "Folder paket medan tidak dapat dibaca." }
        val resolver = reactContext.contentResolver
        val treeID = DocumentsContract.getTreeDocumentId(source)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(source, treeID)
        val foundFiles = mutableSetOf<String>()
        resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { cursor ->
          while (cursor.moveToNext()) {
            val name = cursor.getString(1)
            require(name in setOf("manifest.json", "manifest.ed25519", "terrain.sqlite") &&
              cursor.getString(2) != DocumentsContract.Document.MIME_TYPE_DIR && foundFiles.add(name)) { "Isi folder paket medan tidak didukung." }
            val document = DocumentsContract.buildDocumentUriUsingTree(source, cursor.getString(0))
            copyLimited(requireNotNull(resolver.openInputStream(document)), File(staging, name), sizeLimit(name))
          }
        } ?: error("Folder paket medan tidak dapat dibaca.")
        require(foundFiles == setOf("manifest.json", "manifest.ed25519", "terrain.sqlite")) { "Isi folder paket medan tidak lengkap." }
      }
      installStaging(staging)
    } finally { staging.deleteRecursively() }
  }

  @ReactMethod fun downloadAndInstallPack(baseURL: String, releaseID: String, chunkID: String, databaseSha256: String, promise: Promise) {
    val url = try {
      val parsed = URL(baseURL)
      require(parsed.protocol in setOf("http", "https") && parsed.host.isNotEmpty() && parsed.userInfo == null &&
        parsed.query == null && parsed.ref == null &&
        Regex("^[a-z0-9][a-z0-9._-]{0,95}$").matches(releaseID) &&
        Regex("^[a-z0-9][a-z0-9._-]{0,95}$").matches(chunkID) &&
        Regex("^[0-9a-f]{64}$").matches(databaseSha256)) { "Alamat atau identitas unduhan medan tidak valid." }
      "${baseURL.trimEnd('/')}/v1/terrain/releases/$releaseID/$chunkID"
    } catch (error: Exception) {
      promise.reject("terrain_pack_error", error.message, error); return
    }
    val download = Download(UUID.randomUUID().toString(), releaseID, chunkID, databaseSha256)
    if (downloads.putIfAbsent(chunkID, download) != null) {
      promise.reject("terrain_pack_error", "Unduhan area ini masih berjalan."); return
    }
    publishStates()
    executor.execute {
      var staging: File? = null
      var downloadComplete = false
      try {
        staging = File(storage, ".download-$chunkID-$databaseSha256").apply {
          require(isDirectory || mkdirs()) { "Folder sementara medan tidak dapat dibuat." }
          setLastModified(System.currentTimeMillis())
        }
        fetchFile(download, "$url/manifest.json", File(staging, "manifest.json"), TerrainGridPackReader.MAX_MANIFEST_BYTES)
        fetchFile(download, "$url/manifest.ed25519", File(staging, "manifest.ed25519"), 64)
        val manifest = TerrainGridPackReader.validateManifest(staging, databaseSha256)
        download.totalBytes = manifest.getJSONArray("files").getJSONObject(0).getLong("sizeBytes")
        require(storage.usableSpace > download.totalBytes * 2 + 64 * 1024 * 1024L) { "Ruang penyimpanan tidak cukup untuk paket medan." }
        download.state = "downloading"; publishStates()
        fetchFile(download, "$url/$databaseSha256.sqlite", File(staging, "terrain.sqlite"), download.totalBytes, resumable = true)
        downloadComplete = true
        checkNotCancelled(download)
        download.state = "installing"; publishStates()
        val installed = installStaging(staging)
        download.state = "completed"; publishStates()
        promise.resolve(installed)
      } catch (error: Exception) {
        download.state = "failed"
        download.failure = if (download.cancelled) "Unduhan medan dibatalkan." else error.message ?: "Unduhan medan gagal."
        publishStates()
        promise.reject(if (download.cancelled) "download_cancelled" else "terrain_pack_error", download.failure, error)
      } finally {
        download.connection?.disconnect()
        if (download.cancelled || downloadComplete) staging?.deleteRecursively()
        downloads.remove(chunkID, download)
        publishStates()
      }
    }
  }

  @ReactMethod fun cancelDownload(chunkID: String, promise: Promise) {
    downloads[chunkID]?.let { download ->
      download.cancelled = true
      download.state = "cancelling"
      download.connection?.disconnect()
      publishStates()
    }
    // Queue behind the active operation so the caller can safely start another download afterwards.
    executor.execute { promise.resolve(null) }
  }

  @ReactMethod fun removePack(packID: String, promise: Promise) = run(promise) {
    synchronized(inventoryLock) {
      loadInstalledPacks()
      val destination = packDirectory(packID)
      val reader = installedReaders.remove(packID)
      reader?.close()
      if (destination.exists() && !destination.deleteRecursively()) {
        try { installedReaders[packID] = TerrainGridPackReader(destination) } catch (_: Exception) { unavailablePackageCount++ }
        error("Paket medan tidak dapat dihapus.")
      }
    }
    null
  }

  @ReactMethod fun sampleElevations(flatCoordinates: ReadableArray, promise: Promise) = run(promise) {
    require(flatCoordinates.size() % 2 == 0 && flatCoordinates.size() <= 4000) { "Maksimal 2.000 pasangan koordinat medan." }
    val coordinateValues = DoubleArray(flatCoordinates.size()) { flatCoordinates.getDouble(it) }
    require(coordinateValues.all { it.isFinite() }) { "Koordinat medan tidak valid." }
    synchronized(inventoryLock) {
      loadInstalledPacks()
      val readers = installedReaders.values.sortedWith(compareBy<TerrainGridPackReader> { it.area }.thenBy { it.packID })
        val samples = Arguments.createArray()
        for (index in coordinateValues.indices step 2) {
          val longitude = coordinateValues[index]; val latitude = coordinateValues[index + 1]
          var elevation: Double? = null; var source: TerrainGridPackReader? = null
          if (longitude in -180.0..180.0 && latitude in -90.0..90.0) {
            for (reader in readers) {
              elevation = reader.sample(longitude, latitude)
              if (elevation != null) { source = reader; break }
            }
          }
          samples.pushMap(Arguments.createMap().apply {
            if (elevation == null) { putNull("elevationMeters"); putNull("packID"); putNull("verticalDatum") }
            else { putDouble("elevationMeters", elevation); putString("packID", source!!.packID); putString("verticalDatum", source.verticalDatum) }
          })
        }
      samples
    }
  }

  private fun installStaging(staging: File): WritableMap = synchronized(inventoryLock) {
    loadInstalledPacks()
    val reader = TerrainGridPackReader(staging)
    try {
      val destination = packDirectory(reader.packID)
      require(destination.exists() || installedReaders.size < 64) { "Batas 64 paket medan telah tercapai." }
      val backup = File(storage, ".replace-${UUID.randomUUID()}")
      val hadPrevious = destination.exists()
      if (hadPrevious) require(destination.renameTo(backup)) { "Paket medan lama tidak dapat disiapkan." }
      if (!staging.renameTo(destination)) {
        if (hadPrevious) require(backup.renameTo(destination)) { "Pemasangan gagal; paket lama tersimpan di ${backup.name}." }
        error("Paket medan tidak dapat disimpan.")
      }
      installedReaders.put(reader.packID, reader)?.close()
      backup.deleteRecursively()
      summary(reader)
    } catch (error: Exception) {
      reader.close()
      throw error
    }
  }

  private fun loadInstalledPacks() {
    if (inventoryLoaded) return
    installedDirectories().forEach { directory ->
      try {
        val reader = TerrainGridPackReader(directory)
        installedReaders.put(reader.packID, reader)?.close()
      } catch (_: Exception) { unavailablePackageCount++ }
    }
    inventoryLoaded = true
  }

  private fun newStagingDirectory(): File = File(storage, ".install-${UUID.randomUUID()}").apply {
    require(mkdirs()) { "Folder sementara medan tidak dapat dibuat." }
  }

  private fun installedDirectories(): List<File> = storage.listFiles()?.filter { it.isDirectory && it.name.startsWith("pack-") }?.sortedBy { it.name } ?: emptyList()
  private fun packDirectory(packID: String): File {
    val hash = java.security.MessageDigest.getInstance("SHA-256").digest(packID.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
    return File(storage, "pack-$hash")
  }
  private fun sizeLimit(name: String) = when (name) {
    "manifest.json" -> TerrainGridPackReader.MAX_MANIFEST_BYTES
    "manifest.ed25519" -> 64L
    else -> TerrainGridPackReader.MAX_DATABASE_BYTES
  }
  private fun copyLimited(input: java.io.InputStream, destination: File, limit: Long) {
    input.use { source -> destination.outputStream().buffered().use { target ->
      val buffer = ByteArray(64 * 1024); var total = 0L
      while (true) { val count = source.read(buffer); if (count < 0) break; total += count
        require(total <= limit) { "Ukuran berkas medan melebihi batas." }; target.write(buffer, 0, count) }
    } }
  }
  private fun checkNotCancelled(download: Download) { if (download.cancelled) error("Unduhan medan dibatalkan.") }
  private fun fetchFile(download: Download, url: String, destination: File, limit: Long, resumable: Boolean = false) {
    checkNotCancelled(download)
    var previousBytes = if (resumable && destination.isFile) destination.length() else 0L
    if (previousBytes > limit) { destination.delete(); previousBytes = 0 }
    if (resumable && previousBytes == limit) return
    val connection = URL(url).openConnection() as HttpURLConnection
    download.connection = connection
    try {
      connection.connectTimeout = 30_000; connection.readTimeout = 30_000
      if (previousBytes > 0) connection.setRequestProperty("Range", "bytes=$previousBytes-")
      val responseCode = connection.responseCode
      if (previousBytes > 0 && responseCode == 206) {
        val expectedRange = Regex("^bytes (\\d+)-(\\d+)/(\\d+)$").matchEntire(connection.getHeaderField("Content-Range") ?: "")
        require(expectedRange != null && expectedRange.groupValues[1].toLongOrNull() == previousBytes &&
          expectedRange.groupValues[2].toLongOrNull() == limit - 1 && expectedRange.groupValues[3].toLongOrNull() == limit) {
          "Rentang unduhan medan tidak sesuai."
        }
      } else {
        require(responseCode == 200) { "Server medan merespons HTTP $responseCode." }
        previousBytes = 0
      }
      connection.inputStream.use { input -> java.io.FileOutputStream(destination, previousBytes > 0).buffered().use { output ->
        val buffer = ByteArray(64 * 1024); var written = previousBytes; var lastEvent = 0L
        while (true) {
          checkNotCancelled(download)
          val count = input.read(buffer); if (count < 0) break
          written += count; require(written <= limit) { "Ukuran berkas medan melebihi batas." }
          output.write(buffer, 0, count)
          if (download.state == "downloading") {
            download.bytesWritten = written
            val now = android.os.SystemClock.elapsedRealtime()
            if (now - lastEvent >= 250) { lastEvent = now; publishProgress(download); publishStates() }
          }
        }
        if (resumable) require(written == limit) { "Unduhan medan belum lengkap." }
      } }
      checkNotCancelled(download)
    } finally { connection.disconnect(); download.connection = null }
  }
  private fun summary(reader: TerrainGridPackReader): WritableMap = Arguments.createMap().apply {
    putString("packID", reader.packID); putInt("schemaVersion", 1)
    putArray("requestedBoundsWgs84", Arguments.createArray().apply { reader.bounds.forEach { pushDouble(it) } })
    putString("verticalDatum", reader.verticalDatum); putString("signatureStatus", "signed")
    putString("signatureKeyID", reader.manifest.getString("signatureKeyId")); putString("databaseSha256", reader.databaseHash)
  }
  private fun downloadStates(): WritableArray = Arguments.createArray().apply {
    downloads.values.sortedBy { it.chunkID }.forEach { download -> pushMap(Arguments.createMap().apply {
      putString("operationID", download.operationID); putString("releaseID", download.releaseID)
      putString("chunkID", download.chunkID); putString("databaseSha256", download.databaseSha256)
      putString("state", download.state); putDouble("progress", if (download.totalBytes > 0) download.bytesWritten.toDouble() / download.totalBytes else 0.0)
      putDouble("bytesWritten", download.bytesWritten.toDouble()); putDouble("totalBytes", download.totalBytes.toDouble())
      if (download.failure == null) putNull("error") else putString("error", download.failure)
    }) }
  }
  private fun publishStates() = emit("onTerrainDownloadStateChanged", Arguments.createMap().apply { putArray("downloads", downloadStates()) })
  private fun publishProgress(download: Download) = emit("onTerrainDownloadProgress", Arguments.createMap().apply {
    putString("chunkID", download.chunkID); putDouble("progress", if (download.totalBytes > 0) download.bytesWritten.toDouble() / download.totalBytes else 0.0)
    putDouble("bytesWritten", download.bytesWritten.toDouble()); putDouble("totalBytes", download.totalBytes.toDouble())
  })
  private fun emit(name: String, event: WritableMap) {
    if (reactContext.hasActiveReactInstance()) reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, event)
  }
}
