import CryptoKit
import Darwin
import Foundation
import SQLite3

enum TerrainGridPackReaderError: Error, LocalizedError {
  case invalidPackage(String)
  case unsupportedSchema(Int)
  case unsignedPilot
  case unknownSigningKey(String)
  case invalidSignature
  case sqliteFailure(String)

  var errorDescription: String? {
    switch self {
    case let .invalidPackage(reason): return "Terrain pack is invalid: \(reason)"
    case let .unsupportedSchema(version): return "Terrain pack schema \(version) is not supported"
    case .unsignedPilot: return "Unsigned terrain packs are available only in an explicit Debug pilot"
    case let .unknownSigningKey(keyID): return "Terrain pack uses an unknown signing key: \(keyID)"
    case .invalidSignature: return "Terrain pack signature is invalid"
    case let .sqliteFailure(reason): return "Terrain pack database error: \(reason)"
    }
  }
}

struct TerrainGridPackSummary: Equatable {
  let packID: String
  let schemaVersion: Int
  let requestedBoundsWgs84: [Double]
  let verticalDatum: String
  let signatureStatus: String
  let signatureKeyID: String?
  let databaseSha256: String?

  init(
    packID: String,
    schemaVersion: Int,
    requestedBoundsWgs84: [Double],
    verticalDatum: String,
    signatureStatus: String,
    signatureKeyID: String?,
    databaseSha256: String? = nil
  ) {
    self.packID = packID
    self.schemaVersion = schemaVersion
    self.requestedBoundsWgs84 = requestedBoundsWgs84
    self.verticalDatum = verticalDatum
    self.signatureStatus = signatureStatus
    self.signatureKeyID = signatureKeyID
    self.databaseSha256 = databaseSha256
  }

  var requestedAreaSquareDegrees: Double {
    (requestedBoundsWgs84[2] - requestedBoundsWgs84[0]) *
      (requestedBoundsWgs84[3] - requestedBoundsWgs84[1])
  }
}

struct TerrainGridPackSample {
  let elevationMeters: Double?
  let packID: String?
  let verticalDatum: String?
}

final class TerrainGridPackReader {
  private struct Manifest: Decodable {
    struct Source: Decodable {
      let coordinateReferenceSystem: String
      let cellCoordinate: String
      let verticalDatum: String
    }

    struct FileRecord: Decodable {
      let path: String
      let sizeBytes: Int64
      let sha256: String
    }

    struct RoadGraph: Decodable {
      let bicycleAccessPolicyVersion: String?
    }

    let packId: String
    let schemaVersion: Int
    let minimumReaderVersion: Int
    let requestedBoundsWgs84: [Double]
    let hasElevationGrid: Bool
    let hasRoadGraph: Bool?
    let hasRoadProfiles: Bool?
    let roadGraph: RoadGraph?
    let source: Source
    let signatureStatus: String
    let signatureKeyId: String?
    let files: [FileRecord]
  }

  private struct GridReference {
    let firstCellLongitude: Double
    let firstCellLatitude: Double
    let longitudeStep: Double
    let latitudeStep: Double
  }

  private struct GridBlock {
    let firstCellLongitude: Double
    let firstCellLatitude: Double
    let rows: Int
    let columns: Int
    let elevationBytes: Data
    let validityMask: Data
  }

  private static let maximumManifestBytes = 1_048_576
  private static let maximumDatabaseBytes: Int64 = 256 * 1_024 * 1_024
  private static let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  private let lock = NSLock()
  private let database: OpaquePointer
  private let sampleStatement: OpaquePointer
  private let packID: String
  let summary: TerrainGridPackSummary
  private let requestedBounds: (west: Double, south: Double, east: Double, north: Double)
  private let gridReference: GridReference
  private let hasRoadGraph: Bool
  private let hasRoadProfiles: Bool

  var supportsRoadGraph: Bool { hasRoadGraph }
  var supportsRoadProfiles: Bool { hasRoadProfiles }

  func roadGraphCovers(longitude: Double, latitude: Double) -> Bool {
    longitude.isFinite && latitude.isFinite &&
      requestedBounds.west <= longitude && longitude <= requestedBounds.east &&
      requestedBounds.south <= latitude && latitude <= requestedBounds.north
  }

  init(
    packDirectory: URL,
    trustedSigningKeys: [String: Data] = [:],
    allowUnsignedPilot: Bool = false
  ) throws {
    try Self.requireDirectory(packDirectory)
    let manifestURL = packDirectory.appendingPathComponent("manifest.json", isDirectory: false)
    try Self.requireRegularFile(manifestURL)
    let manifestAttributes = try FileManager.default.attributesOfItem(atPath: manifestURL.path)
    guard let manifestSize = manifestAttributes[.size] as? NSNumber,
          manifestSize.intValue <= Self.maximumManifestBytes else {
      throw TerrainGridPackReaderError.invalidPackage("manifest exceeds the size limit")
    }

    let manifestBytes = try Data(contentsOf: manifestURL, options: .mappedIfSafe)
    let manifest = try JSONDecoder().decode(Manifest.self, from: manifestBytes)
    try Self.validate(manifest)
    try Self.verifySignature(
      manifest: manifest,
      manifestBytes: manifestBytes,
      packageDirectory: packDirectory,
      trustedSigningKeys: trustedSigningKeys,
      allowUnsignedPilot: allowUnsignedPilot
    )

    guard let databaseFile = manifest.files.first,
          databaseFile.path == "terrain.sqlite",
          databaseFile.sizeBytes > 0,
          databaseFile.sizeBytes <= Self.maximumDatabaseBytes,
          databaseFile.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
      throw TerrainGridPackReaderError.invalidPackage("database record is missing or unsafe")
    }

    let databaseURL = packDirectory.appendingPathComponent(databaseFile.path, isDirectory: false)
    try Self.requireRegularFile(databaseURL)
    let databaseAttributes = try FileManager.default.attributesOfItem(atPath: databaseURL.path)
    guard let databaseSize = databaseAttributes[.size] as? NSNumber,
          databaseSize.int64Value == databaseFile.sizeBytes else {
      throw TerrainGridPackReaderError.invalidPackage("database size does not match the manifest")
    }
    guard try Self.sha256(of: databaseURL) == databaseFile.sha256 else {
      throw TerrainGridPackReaderError.invalidPackage("database SHA-256 does not match the manifest")
    }

    var openedDatabase: OpaquePointer?
    let openStatus = sqlite3_open_v2(
      databaseURL.path,
      &openedDatabase,
      SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX,
      nil
    )
    guard openStatus == SQLITE_OK, let openedDatabase else {
      let message = openedDatabase.map { String(cString: sqlite3_errmsg($0)) } ?? "could not open file"
      if let openedDatabase { sqlite3_close(openedDatabase) }
      throw TerrainGridPackReaderError.sqliteFailure(message)
    }

    do {
      let loadedGridReference = try Self.validateDatabase(openedDatabase, packID: manifest.packId)
      let loadedRoadGraph = manifest.hasRoadGraph == true
      let loadedRoadProfiles = manifest.hasRoadProfiles == true
      guard !loadedRoadProfiles || loadedRoadGraph else {
        throw TerrainGridPackReaderError.invalidPackage("road profiles are declared without a road graph")
      }
      if loadedRoadGraph {
        try Self.validateRoadDatabase(
          openedDatabase,
          hasProfiles: loadedRoadProfiles,
          accessPolicyVersion: manifest.roadGraph?.bicycleAccessPolicyVersion
        )
      }
      let query = """
        SELECT block.first_cell_longitude,
               block.first_cell_latitude,
               block.rows,
               block.columns,
               block.elevations_f32le,
               block.validity_mask_lsb
        FROM elevation_grid_block_index AS spatial
        JOIN elevation_grid_blocks AS block ON block.block_id = spatial.block_id
        WHERE spatial.minimum_longitude <= ?
          AND spatial.maximum_longitude >= ?
          AND spatial.minimum_latitude <= ?
          AND spatial.maximum_latitude >= ?
          AND block.grid_id = ?
        ORDER BY block.block_id
        """
      var preparedSampleStatement: OpaquePointer?
      let prepareStatus = sqlite3_prepare_v2(openedDatabase, query, -1, &preparedSampleStatement, nil)
      guard prepareStatus == SQLITE_OK, let preparedSampleStatement else {
        throw Self.sqliteError(openedDatabase)
      }

      database = openedDatabase
      sampleStatement = preparedSampleStatement
      packID = manifest.packId
      let dbSha256 = manifest.files.first(where: { $0.path == "terrain.sqlite" })?.sha256
      summary = TerrainGridPackSummary(
        packID: manifest.packId,
        schemaVersion: manifest.schemaVersion,
        requestedBoundsWgs84: manifest.requestedBoundsWgs84,
        verticalDatum: manifest.source.verticalDatum,
        signatureStatus: manifest.signatureStatus,
        signatureKeyID: manifest.signatureKeyId,
        databaseSha256: dbSha256
      )
      requestedBounds = (
        manifest.requestedBoundsWgs84[0],
        manifest.requestedBoundsWgs84[1],
        manifest.requestedBoundsWgs84[2],
        manifest.requestedBoundsWgs84[3]
      )
      gridReference = loadedGridReference
      hasRoadGraph = loadedRoadGraph
      hasRoadProfiles = loadedRoadProfiles
    } catch {
      sqlite3_close(openedDatabase)
      throw error
    }
  }

  deinit {
    sqlite3_finalize(sampleStatement)
    sqlite3_close(database)
  }

  func sample(longitude: Double, latitude: Double) throws -> Double? {
    lock.lock()
    defer { lock.unlock() }
    return try sampleLocked(longitude: longitude, latitude: latitude)
  }

  func sampleBatch(_ coordinates: [(longitude: Double, latitude: Double)]) throws -> [Double?] {
    lock.lock()
    defer { lock.unlock() }
    return try coordinates.map {
      try sampleLocked(longitude: $0.longitude, latitude: $0.latitude)
    }
  }

  func roadCandidateRecords(
    longitude: Double,
    latitude: Double,
    horizontalAccuracyMeters: Double
  ) throws -> [[String: Any]] {
    guard hasRoadGraph else { return [] }
    guard longitude.isFinite, (-180...180).contains(longitude),
          latitude.isFinite, (-90...90).contains(latitude),
          horizontalAccuracyMeters.isFinite, horizontalAccuracyMeters >= 0 else {
      throw TerrainGridPackReaderError.invalidPackage("road match observation is invalid")
    }

    lock.lock()
    defer { lock.unlock() }

    let searchRadiusMeters = min(75.0, max(20.0, horizontalAccuracyMeters * 2 + 10))
    let latitudeRadiusDegrees = searchRadiusMeters / 111_320
    let longitudeScaleMeters = max(1_113.2, 111_320 * abs(cos(latitude * .pi / 180)))
    let longitudeRadiusDegrees = min(180, searchRadiusMeters / longitudeScaleMeters)
    let corridorSelection = hasRoadProfiles
      ? """
        corridor_edge.corridor_id, corridor_edge.start_distance_meters,
        corridor.length_meters, corridor.profile_quality,
        EXISTS (
          SELECT 1 FROM road_corridor_edges AS forward_edge
          JOIN road_edges AS access_edge ON access_edge.edge_id = forward_edge.edge_id
          WHERE forward_edge.corridor_id = corridor.corridor_id
            AND access_edge.bicycle_access = 'road_class_inferred'
        )
        """
      : "NULL, NULL, NULL, NULL, 0"
    let corridorJoins = hasRoadProfiles
      ? """
        LEFT JOIN road_corridor_edges AS corridor_edge ON corridor_edge.edge_id = edge.edge_id
        LEFT JOIN road_corridors AS corridor ON corridor.corridor_id = corridor_edge.corridor_id
        """
      : ""
    let query = """
      SELECT edge.edge_id,
             edge.segment_id,
             edge.from_node_id,
             edge.to_node_id,
             edge.direction,
             edge.predictable,
             segment.length_meters,
             segment.geometry_wgs84_f64le,
             \(corridorSelection)
      FROM road_edge_index AS spatial
      JOIN road_edges AS edge ON edge.edge_id = spatial.edge_id
      JOIN road_segments AS segment ON segment.segment_id = edge.segment_id
      \(corridorJoins)
      WHERE edge.matchable = 1
        AND spatial.minimum_longitude <= ?
        AND spatial.maximum_longitude >= ?
        AND spatial.minimum_latitude <= ?
        AND spatial.maximum_latitude >= ?
      ORDER BY edge.predictable DESC, edge.edge_id
      LIMIT 49
      """

    return try Self.withStatement(database, query: query) { statement in
      try Self.bindDouble(longitude + longitudeRadiusDegrees, to: statement, at: 1, database: database)
      try Self.bindDouble(longitude - longitudeRadiusDegrees, to: statement, at: 2, database: database)
      try Self.bindDouble(latitude + latitudeRadiusDegrees, to: statement, at: 3, database: database)
      try Self.bindDouble(latitude - latitudeRadiusDegrees, to: statement, at: 4, database: database)

      var candidates: [[String: Any]] = []
      var stepStatus = sqlite3_step(statement)
      while stepStatus == SQLITE_ROW {
        let geometryData = Self.columnData(statement, index: 7)
        guard geometryData.count >= 32,
              geometryData.count <= 131_072,
              geometryData.count.isMultiple(of: 16) else {
          stepStatus = sqlite3_step(statement)
          continue
        }

        let corridorID = sqlite3_column_type(statement, 8) == SQLITE_NULL
          ? nil : Int64(sqlite3_column_int64(statement, 8))
        let corridorStartDistanceMeters = sqlite3_column_type(statement, 9) == SQLITE_NULL
          ? 0 : sqlite3_column_double(statement, 9)
        let corridorLengthMeters = sqlite3_column_type(statement, 10) == SQLITE_NULL
          ? 0 : sqlite3_column_double(statement, 10)
        let profileQuality = sqlite3_column_type(statement, 11) == SQLITE_NULL
          ? "unavailable" : Self.columnText(statement, index: 11)
        let forwardPathQuality = corridorID == nil ? "unavailable"
          : sqlite3_column_int(statement, 12) == 1 ? "inferred_to_boundary" : "known_to_boundary"
        let candidate: [String: Any] = [
          "edgeID": sqlite3_column_int64(statement, 0),
          "segmentID": sqlite3_column_int64(statement, 1),
          "fromNodeID": sqlite3_column_int64(statement, 2),
          "toNodeID": sqlite3_column_int64(statement, 3),
          "direction": sqlite3_column_int(statement, 4),
          "predictable": sqlite3_column_int(statement, 5) == 1,
          "lengthMeters": sqlite3_column_double(statement, 6),
          "geometryData": geometryData,
          "corridorID": corridorID.map { $0 as Any } ?? NSNull(),
          "corridorStartDistanceMeters": corridorStartDistanceMeters,
          "corridorLengthMeters": corridorLengthMeters,
          "profileQuality": profileQuality,
          "forwardPathQuality": forwardPathQuality,
        ]
        candidates.append(candidate)
        stepStatus = sqlite3_step(statement)
      }
      guard stepStatus == SQLITE_DONE else { throw Self.sqliteError(database) }
      return candidates
    }
  }

  func roadClimbGuidance(
    corridorID: Int64,
    positionAlongCorridorMeters: Double,
    warningDistanceMeters: Double = 1_500
  ) throws -> [String: Any] {
    guard hasRoadProfiles else {
      return Self.unavailableClimbGuidance(reason: "road_profiles_unavailable")
    }
    guard corridorID >= 0,
          positionAlongCorridorMeters.isFinite,
          positionAlongCorridorMeters >= 0,
          warningDistanceMeters.isFinite,
          warningDistanceMeters > 0 else {
      throw TerrainGridPackReaderError.invalidPackage("road climb guidance position is invalid")
    }

    lock.lock()
    defer { lock.unlock() }

    let corridor = try Self.withStatement(
      database,
      query: "SELECT length_meters, profile_quality FROM road_corridors WHERE corridor_id = ?"
    ) { statement -> (lengthMeters: Double, profileQuality: String)? in
      try Self.bindInt64(corridorID, to: statement, at: 1, database: database)
      guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
      return (
        sqlite3_column_double(statement, 0),
        Self.columnText(statement, index: 1)
      )
    }
    guard let corridor,
          corridor.lengthMeters.isFinite,
          corridor.lengthMeters > 0,
          positionAlongCorridorMeters <= corridor.lengthMeters else {
      return Self.unavailableClimbGuidance(reason: "corridor_position_unavailable")
    }

    let unknownElevationDistance = try Self.withStatement(
      database,
      query: """
        SELECT MIN(distance_meters)
        FROM road_corridor_elevation_samples
        WHERE corridor_id = ?
          AND distance_meters >= ?
          AND profile_elevation_meters IS NULL
        """
    ) { statement -> Double? in
      try Self.bindInt64(corridorID, to: statement, at: 1, database: database)
      try Self.bindDouble(positionAlongCorridorMeters, to: statement, at: 2, database: database)
      guard sqlite3_step(statement) == SQLITE_ROW,
            sqlite3_column_type(statement, 0) != SQLITE_NULL else { return nil }
      let distanceMeters = sqlite3_column_double(statement, 0)
      return distanceMeters.isFinite ? distanceMeters : nil
    }
    let knownProfileEndMeters = min(corridor.lengthMeters, unknownElevationDistance ?? corridor.lengthMeters)
    let includesUnknownBoundary = unknownElevationDistance.map {
      $0 <= corridor.lengthMeters
    } ?? false
    let endBoundaryOperator = includesUnknownBoundary ? "<" : "<="
    let climbQuery = """
      SELECT climb_index,
             start_distance_meters,
             end_distance_meters,
             distance_meters,
             net_rise_meters,
             ascent_meters,
             average_grade_percent,
             max_grade_percent
      FROM road_corridor_climbs
      WHERE corridor_id = ?
        AND end_distance_meters >= ?
        AND start_distance_meters <= ?
        AND end_distance_meters \(endBoundaryOperator) ?
      ORDER BY CASE WHEN start_distance_meters <= ? THEN 0 ELSE 1 END,
               start_distance_meters,
               climb_index
      LIMIT 1
      """
    let climb = try Self.withStatement(database, query: climbQuery) {
      statement -> [String: Any]? in
      try Self.bindInt64(corridorID, to: statement, at: 1, database: database)
      try Self.bindDouble(positionAlongCorridorMeters, to: statement, at: 2, database: database)
      try Self.bindDouble(
        positionAlongCorridorMeters + warningDistanceMeters,
        to: statement,
        at: 3,
        database: database
      )
      try Self.bindDouble(knownProfileEndMeters, to: statement, at: 4, database: database)
      try Self.bindDouble(positionAlongCorridorMeters, to: statement, at: 5, database: database)
      guard sqlite3_step(statement) == SQLITE_ROW else { return nil }

      let startDistanceMeters = sqlite3_column_double(statement, 1)
      let endDistanceMeters = sqlite3_column_double(statement, 2)
      let climbDistanceMeters = sqlite3_column_double(statement, 3)
      let netRiseMeters = sqlite3_column_double(statement, 4)
      let ascentMeters = sqlite3_column_double(statement, 5)
      let averageGradePercent = sqlite3_column_double(statement, 6)
      let maxGradePercent = sqlite3_column_double(statement, 7)
      let measuredValues = [
        startDistanceMeters,
        endDistanceMeters,
        climbDistanceMeters,
        netRiseMeters,
        ascentMeters,
        averageGradePercent,
        maxGradePercent,
      ]
      guard measuredValues.allSatisfy(\.isFinite),
            climbDistanceMeters > 0,
            ascentMeters >= 0 else { return nil }

      let isActive = startDistanceMeters <= positionAlongCorridorMeters &&
        endDistanceMeters >= positionAlongCorridorMeters
      let distanceToStartMeters = max(0, startDistanceMeters - positionAlongCorridorMeters)
      guard isActive || distanceToStartMeters <= warningDistanceMeters else { return nil }

      return [
        "terrainClimbStatus": isActive ? "active" : "upcoming",
        "terrainClimbIndex": sqlite3_column_int(statement, 0),
        "terrainClimbDistanceToStartMeters": distanceToStartMeters,
        "terrainClimbDistanceRemainingMeters": max(0, endDistanceMeters - positionAlongCorridorMeters),
        "terrainClimbDistanceMeters": climbDistanceMeters,
        "terrainClimbNetRiseMeters": netRiseMeters,
        "terrainClimbElevationGainMeters": ascentMeters,
        "terrainClimbAverageGradePercent": averageGradePercent,
        "terrainClimbMaxGradePercent": maxGradePercent,
        "terrainClimbProgressPercent": isActive
          ? min(100, max(0, (positionAlongCorridorMeters - startDistanceMeters) / climbDistanceMeters * 100))
          : 0,
      ]
    }

    let knownForwardDistanceMeters = max(0, knownProfileEndMeters - positionAlongCorridorMeters)
    guard let climb else {
      return [
        "terrainClimbStatus": "none",
        "terrainClimbReason": unknownElevationDistance == nil
          ? "no_nearby_climb"
          : "profile_gap_ahead",
        "terrainClimbProfileQuality": corridor.profileQuality,
        "terrainClimbKnownForwardDistanceMeters": knownForwardDistanceMeters,
      ]
    }
    return climb.merging([
      "terrainClimbReason": "profile_climb_candidate",
      "terrainClimbProfileQuality": corridor.profileQuality,
      "terrainClimbKnownForwardDistanceMeters": knownForwardDistanceMeters,
    ]) { _, guidanceValue in guidanceValue }
  }

  func validateAllBlocks() throws {
    lock.lock()
    defer { lock.unlock() }

    let spatialIndexCheck = try Self.textValue(
      database,
      query: "SELECT rtreecheck('elevation_grid_block_index')"
    )
    guard spatialIndexCheck == "ok" else {
      throw TerrainGridPackReaderError.invalidPackage("R-tree integrity check failed")
    }

    let query = """
      SELECT core_start_row,
             core_start_column,
             core_rows,
             core_columns,
             first_cell_longitude,
             first_cell_latitude,
             rows,
             columns,
             elevations_f32le,
             validity_mask_lsb,
             valid_cell_count,
             spatial.minimum_longitude,
             spatial.maximum_longitude,
             spatial.minimum_latitude,
             spatial.maximum_latitude
      FROM elevation_grid_blocks AS block
      JOIN elevation_grid_block_index AS spatial ON spatial.block_id = block.block_id
      WHERE block.grid_id = ?
      ORDER BY block.core_start_row, block.core_start_column
      """
    try Self.withStatement(database, query: query) { statement in
      try Self.bindText(packID, to: statement, at: 1, database: database)
      var checkedBlockCount = 0
      var stepStatus = sqlite3_step(statement)
      while stepStatus == SQLITE_ROW {
        try validateBlock(statement)
        checkedBlockCount += 1
        stepStatus = sqlite3_step(statement)
      }
      guard stepStatus == SQLITE_DONE else { throw Self.sqliteError(database) }
      guard checkedBlockCount > 0 else {
        throw TerrainGridPackReaderError.invalidPackage("grid contains no elevation blocks")
      }
    }
  }

  private func sampleLocked(longitude: Double, latitude: Double) throws -> Double? {
    guard longitude.isFinite, latitude.isFinite,
          (-180...180).contains(longitude), (-90...90).contains(latitude),
          longitude >= requestedBounds.west, longitude <= requestedBounds.east,
          latitude >= requestedBounds.south, latitude <= requestedBounds.north else {
      return nil
    }

    sqlite3_reset(sampleStatement)
    sqlite3_clear_bindings(sampleStatement)
    defer {
      sqlite3_reset(sampleStatement)
      sqlite3_clear_bindings(sampleStatement)
    }
    try Self.bindDouble(longitude, to: sampleStatement, at: 1, database: database)
    try Self.bindDouble(longitude, to: sampleStatement, at: 2, database: database)
    try Self.bindDouble(latitude, to: sampleStatement, at: 3, database: database)
    try Self.bindDouble(latitude, to: sampleStatement, at: 4, database: database)
    try Self.bindText(packID, to: sampleStatement, at: 5, database: database)

    var stepStatus = sqlite3_step(sampleStatement)
    while stepStatus == SQLITE_ROW {
      if let elevationMeters = sampleElevation(in: sampleStatement, longitude: longitude, latitude: latitude) {
        return elevationMeters
      }
      stepStatus = sqlite3_step(sampleStatement)
    }
    guard stepStatus == SQLITE_DONE else { throw Self.sqliteError(database) }
    return nil
  }

  private func sampleElevation(
    in statement: OpaquePointer,
    longitude: Double,
    latitude: Double
  ) -> Double? {
    let block = GridBlock(
      firstCellLongitude: sqlite3_column_double(statement, 0),
      firstCellLatitude: sqlite3_column_double(statement, 1),
      rows: Int(sqlite3_column_int(statement, 2)),
      columns: Int(sqlite3_column_int(statement, 3)),
      elevationBytes: Self.columnData(statement, index: 4),
      validityMask: Self.columnData(statement, index: 5)
    )
    guard Self.hasValidDimensions(block) else { return nil }

    let gridColumn = Self.snapToCell((longitude - block.firstCellLongitude) / gridReference.longitudeStep)
    let gridRow = Self.snapToCell((latitude - block.firstCellLatitude) / gridReference.latitudeStep)
    guard gridColumn >= 0, gridColumn <= Double(block.columns - 1),
          gridRow >= 0, gridRow <= Double(block.rows - 1) else {
      return nil
    }

    let leftColumn = Int(floor(gridColumn))
    let topRow = Int(floor(gridRow))
    let rightColumn = min(leftColumn + 1, block.columns - 1)
    let bottomRow = min(topRow + 1, block.rows - 1)
    let columnFraction = gridColumn - Double(leftColumn)
    let rowFraction = gridRow - Double(topRow)
    let corners = [
      (row: topRow, column: leftColumn, weight: (1 - columnFraction) * (1 - rowFraction)),
      (row: topRow, column: rightColumn, weight: columnFraction * (1 - rowFraction)),
      (row: bottomRow, column: leftColumn, weight: (1 - columnFraction) * rowFraction),
      (row: bottomRow, column: rightColumn, weight: columnFraction * rowFraction),
    ]

    var interpolatedElevation = 0.0
    for corner in corners where corner.weight > 0 {
      guard let cellElevation = Self.elevation(
        in: block,
        row: corner.row,
        column: corner.column
      ) else {
        return nil
      }
      interpolatedElevation += cellElevation * corner.weight
    }
    return interpolatedElevation.isFinite ? interpolatedElevation : nil
  }

  private func expectedGridRange() throws -> (
    firstRow: Int,
    stopRow: Int,
    firstColumn: Int,
    stopColumn: Int
  ) {
    let longitudeStep = gridReference.longitudeStep
    let latitudeStep = abs(gridReference.latitudeStep)
    let rowStarts = [
      (gridReference.firstCellLatitude - requestedBounds.north) / latitudeStep - 1e-9,
      (gridReference.firstCellLatitude - requestedBounds.south) / latitudeStep - 1e-9,
    ]
    let columnStarts = [
      (requestedBounds.west - gridReference.firstCellLongitude) / longitudeStep - 1e-9,
      (requestedBounds.east - gridReference.firstCellLongitude) / longitudeStep - 1e-9,
    ]
    let gridOffsets = rowStarts + columnStarts
    guard gridOffsets.allSatisfy({ $0.isFinite && abs($0) < 20_000_000 }) else {
      throw TerrainGridPackReaderError.invalidPackage("requested bounds exceed the supported grid size")
    }

    let range = (
      firstRow: Int(ceil(rowStarts[0])),
      stopRow: Int(ceil(rowStarts[1])),
      firstColumn: Int(ceil(columnStarts[0])),
      stopColumn: Int(ceil(columnStarts[1]))
    )
    guard range.firstRow < range.stopRow,
          range.firstColumn < range.stopColumn,
          (range.stopRow - range.firstRow) * (range.stopColumn - range.firstColumn) <= 20_000_000 else {
      throw TerrainGridPackReaderError.invalidPackage("requested bounds contain no supported grid cells")
    }
    return range
  }

  private func validateBlock(_ statement: OpaquePointer) throws {
    let coreStartRow = Int(sqlite3_column_int(statement, 0))
    let coreStartColumn = Int(sqlite3_column_int(statement, 1))
    let coreRows = Int(sqlite3_column_int(statement, 2))
    let coreColumns = Int(sqlite3_column_int(statement, 3))
    let firstCellLongitude = sqlite3_column_double(statement, 4)
    let firstCellLatitude = sqlite3_column_double(statement, 5)
    let block = GridBlock(
      firstCellLongitude: firstCellLongitude,
      firstCellLatitude: firstCellLatitude,
      rows: Int(sqlite3_column_int(statement, 6)),
      columns: Int(sqlite3_column_int(statement, 7)),
      elevationBytes: Self.columnData(statement, index: 8),
      validityMask: Self.columnData(statement, index: 9)
    )
    let declaredValidCells = Int(sqlite3_column_int(statement, 10))
    let spatialBounds = (
      minimumLongitude: sqlite3_column_double(statement, 11),
      maximumLongitude: sqlite3_column_double(statement, 12),
      minimumLatitude: sqlite3_column_double(statement, 13),
      maximumLatitude: sqlite3_column_double(statement, 14)
    )
    guard Self.hasValidDimensions(block),
          (1...62).contains(coreRows), (1...62).contains(coreColumns),
          firstCellLongitude.isFinite, firstCellLatitude.isFinite else {
      throw TerrainGridPackReaderError.invalidPackage("grid block dimensions are invalid")
    }

    let blockStartColumn = Int(((firstCellLongitude - gridReference.firstCellLongitude) /
      gridReference.longitudeStep).rounded())
    let blockStartRow = Int(((firstCellLatitude - gridReference.firstCellLatitude) /
      gridReference.latitudeStep).rounded())
    let localCoreStartRow = coreStartRow - blockStartRow
    let localCoreStartColumn = coreStartColumn - blockStartColumn
    guard abs((firstCellLongitude - gridReference.firstCellLongitude) /
      gridReference.longitudeStep - Double(blockStartColumn)) < 1e-6,
          abs((firstCellLatitude - gridReference.firstCellLatitude) /
            gridReference.latitudeStep - Double(blockStartRow)) < 1e-6,
          (0...1).contains(localCoreStartRow),
          (0...1).contains(localCoreStartColumn),
          localCoreStartRow + coreRows <= block.rows,
          localCoreStartColumn + coreColumns <= block.columns else {
      throw TerrainGridPackReaderError.invalidPackage("grid block core and halo do not align")
    }

    let expectedRange = try expectedGridRange()
    let coreRowOffset = coreStartRow - expectedRange.firstRow
    let coreColumnOffset = coreStartColumn - expectedRange.firstColumn
    guard coreRowOffset >= 0, coreColumnOffset >= 0,
          coreRowOffset % 62 == 0, coreColumnOffset % 62 == 0,
          coreStartRow < expectedRange.stopRow,
          coreStartColumn < expectedRange.stopColumn,
          coreRows == min(62, expectedRange.stopRow - coreStartRow),
          coreColumns == min(62, expectedRange.stopColumn - coreStartColumn) else {
      throw TerrainGridPackReaderError.invalidPackage("grid block core does not match requested bounds")
    }

    let expectedSpatialBounds = (
      minimumLongitude: firstCellLongitude - gridReference.longitudeStep / 2,
      maximumLongitude: firstCellLongitude + (Double(block.columns) - 0.5) * gridReference.longitudeStep,
      minimumLatitude: firstCellLatitude + (Double(block.rows) - 0.5) * gridReference.latitudeStep,
      maximumLatitude: firstCellLatitude - gridReference.latitudeStep / 2
    )
    guard spatialBounds.minimumLongitude.isFinite,
          spatialBounds.maximumLongitude.isFinite,
          spatialBounds.minimumLatitude.isFinite,
          spatialBounds.maximumLatitude.isFinite,
          spatialBounds.minimumLongitude <= expectedSpatialBounds.minimumLongitude + 1e-7,
          spatialBounds.maximumLongitude >= expectedSpatialBounds.maximumLongitude - 1e-7,
          spatialBounds.minimumLatitude <= expectedSpatialBounds.minimumLatitude + 1e-7,
          spatialBounds.maximumLatitude >= expectedSpatialBounds.maximumLatitude - 1e-7 else {
      throw TerrainGridPackReaderError.invalidPackage("spatial index bounds do not cover the grid block")
    }

    let cellCount = block.rows * block.columns
    let finalByte = block.validityMask[cellCount / 8 - (cellCount % 8 == 0 ? 1 : 0)]
    let usedBitsInFinalByte = cellCount % 8
    if usedBitsInFinalByte != 0 {
      let allowedBits = UInt8((1 << usedBitsInFinalByte) - 1)
      guard finalByte & ~allowedBits == 0 else {
        throw TerrainGridPackReaderError.invalidPackage("validity mask padding bits are set")
      }
    }

    var validCellCount = 0
    for cellIndex in 0..<cellCount {
      let maskByte = block.validityMask[cellIndex / 8]
      let isValidCell = maskByte & (1 << (cellIndex % 8)) != 0
      guard isValidCell else { continue }
      validCellCount += 1
      guard Self.float32(in: block.elevationBytes, at: cellIndex).isFinite else {
        throw TerrainGridPackReaderError.invalidPackage("valid elevation cell is not finite")
      }
    }
    guard validCellCount == declaredValidCells, validCellCount > 0 else {
      throw TerrainGridPackReaderError.invalidPackage("valid cell count does not match its mask")
    }
  }

  private static func validate(_ manifest: Manifest) throws {
    guard manifest.schemaVersion == 1 else {
      throw TerrainGridPackReaderError.unsupportedSchema(manifest.schemaVersion)
    }
    guard manifest.minimumReaderVersion <= 2 else {
      throw TerrainGridPackReaderError.unsupportedSchema(manifest.minimumReaderVersion)
    }
    if let accessPolicyVersion = manifest.roadGraph?.bicycleAccessPolicyVersion {
      guard accessPolicyVersion == "cyclecomp-bicycle-access-v1",
            manifest.minimumReaderVersion >= 2 else {
        throw TerrainGridPackReaderError.invalidPackage("bicycle access policy is not supported")
      }
    }
    guard manifest.minimumReaderVersion >= 1,
          !manifest.packId.isEmpty, manifest.hasElevationGrid,
          manifest.packId.range(of: "^[a-z0-9][a-z0-9._-]{0,95}$", options: .regularExpression) != nil,
          manifest.source.coordinateReferenceSystem == "EPSG:4326",
          manifest.source.cellCoordinate == "center",
          !manifest.source.verticalDatum.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          manifest.requestedBoundsWgs84.count == 4,
          manifest.files.count == 1 else {
      throw TerrainGridPackReaderError.invalidPackage("required manifest fields are missing")
    }
    let bounds = manifest.requestedBoundsWgs84
    guard bounds.allSatisfy(\.isFinite),
          (-180...180).contains(bounds[0]), (-180...180).contains(bounds[2]),
          (-90...90).contains(bounds[1]), (-90...90).contains(bounds[3]),
          bounds[0] < bounds[2], bounds[1] < bounds[3] else {
      throw TerrainGridPackReaderError.invalidPackage("requested WGS84 bounds are invalid")
    }
  }

  private static func verifySignature(
    manifest: Manifest,
    manifestBytes: Data,
    packageDirectory: URL,
    trustedSigningKeys: [String: Data],
    allowUnsignedPilot: Bool
  ) throws {
    if manifest.signatureStatus == "unsigned_pilot" {
#if DEBUG
      if allowUnsignedPilot { return }
#endif
      throw TerrainGridPackReaderError.unsignedPilot
    }

    guard manifest.signatureStatus == "signed",
          let keyID = manifest.signatureKeyId,
          let publicKeyBytes = trustedSigningKeys[keyID] else {
      throw TerrainGridPackReaderError.unknownSigningKey(manifest.signatureKeyId ?? "missing")
    }
    let signatureURL = packageDirectory.appendingPathComponent("manifest.ed25519", isDirectory: false)
    try requireRegularFile(signatureURL)
    let signatureAttributes = try FileManager.default.attributesOfItem(atPath: signatureURL.path)
    guard let signatureSize = signatureAttributes[.size] as? NSNumber,
          signatureSize.intValue == 64 else {
      throw TerrainGridPackReaderError.invalidSignature
    }
    let signature = try Data(contentsOf: signatureURL, options: .mappedIfSafe)
    guard signature.count == 64 else { throw TerrainGridPackReaderError.invalidSignature }
    do {
      let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyBytes)
      guard publicKey.isValidSignature(signature, for: manifestBytes) else {
        throw TerrainGridPackReaderError.invalidSignature
      }
    } catch let error as TerrainGridPackReaderError {
      throw error
    } catch {
      throw TerrainGridPackReaderError.invalidSignature
    }
  }

  private static func validateDatabase(
    _ database: OpaquePointer,
    packID: String
  ) throws -> GridReference {
    let schemaVersion = try integerValue(database, query: "PRAGMA user_version")
    guard schemaVersion == 1 else { throw TerrainGridPackReaderError.unsupportedSchema(schemaVersion) }
    guard try integerValue(database, query: "PRAGMA application_id") == 1_129_927_500 else {
      throw TerrainGridPackReaderError.invalidPackage("SQLite application ID is invalid")
    }
    let integrity = try textValue(database, query: "PRAGMA integrity_check")
    guard integrity == "ok" else {
      throw TerrainGridPackReaderError.invalidPackage("SQLite integrity check failed")
    }

    let storedPackID = try textValue(
      database,
      query: "SELECT value FROM pack_metadata WHERE key = 'packId'"
    )
    guard try JSONDecoder().decode(String.self, from: Data(storedPackID.utf8)) == packID else {
      throw TerrainGridPackReaderError.invalidPackage("pack ID does not match the manifest")
    }
    let storedSchemaVersion = try textValue(
      database,
      query: "SELECT value FROM pack_metadata WHERE key = 'schemaVersion'"
    )
    guard try JSONDecoder().decode(Int.self, from: Data(storedSchemaVersion.utf8)) == 1 else {
      throw TerrainGridPackReaderError.unsupportedSchema(schemaVersion)
    }

    let gridMetadataQuery = """
      SELECT first_cell_longitude, first_cell_latitude, longitude_step, latitude_step
      FROM elevation_grid_metadata
      WHERE grid_id = ?
      """
    let gridReference: GridReference = try withStatement(database, query: gridMetadataQuery) { statement in
      try bindText(packID, to: statement, at: 1, database: database)
      guard sqlite3_step(statement) == SQLITE_ROW else {
        throw TerrainGridPackReaderError.invalidPackage("grid metadata is missing")
      }
      let reference = GridReference(
        firstCellLongitude: sqlite3_column_double(statement, 0),
        firstCellLatitude: sqlite3_column_double(statement, 1),
        longitudeStep: sqlite3_column_double(statement, 2),
        latitudeStep: sqlite3_column_double(statement, 3)
      )
      guard reference.firstCellLongitude.isFinite,
            reference.firstCellLatitude.isFinite,
            reference.longitudeStep.isFinite, reference.longitudeStep > 0,
            reference.latitudeStep.isFinite, reference.latitudeStep < 0 else {
        throw TerrainGridPackReaderError.invalidPackage("grid transform is invalid")
      }
      return reference
    }

    let blockCount = try withStatement(
      database,
      query: "SELECT COUNT(*) FROM elevation_grid_blocks WHERE grid_id = ?"
    ) { statement in
      try bindText(packID, to: statement, at: 1, database: database)
      guard sqlite3_step(statement) == SQLITE_ROW else { throw sqliteError(database) }
      return Int(sqlite3_column_int64(statement, 0))
    }
    let indexCount = try integerValue(database, query: "SELECT COUNT(*) FROM elevation_grid_block_index")
    guard blockCount > 0, indexCount == blockCount else {
      throw TerrainGridPackReaderError.invalidPackage("grid blocks or spatial index are incomplete")
    }
    return gridReference
  }

  private static func validateRoadDatabase(
    _ database: OpaquePointer,
    hasProfiles: Bool,
    accessPolicyVersion: String?
  ) throws {
    let edgeCount = try integerValue(database, query: "SELECT COUNT(*) FROM road_edges")
    let indexedEdgeCount = try integerValue(database, query: "SELECT COUNT(*) FROM road_edge_index")
    let spatialIndexStatus = try textValue(database, query: "SELECT rtreecheck('road_edge_index')")
    guard edgeCount == indexedEdgeCount, spatialIndexStatus == "ok" else {
      throw TerrainGridPackReaderError.invalidPackage("road graph spatial index is incomplete")
    }
    guard try integerValue(
      database,
      query: "SELECT COUNT(*) FROM road_edges WHERE matchable NOT IN (0, 1) OR predictable NOT IN (0, 1)"
    ) == 0 else {
      throw TerrainGridPackReaderError.invalidPackage("road graph access flags are invalid")
    }
    if let accessPolicyVersion {
      let storedPolicyVersion = try textValue(
        database,
        query: "SELECT value FROM road_graph_metadata WHERE key = 'bicycleAccessPolicyVersion'"
      )
      guard let storedPolicyBytes = storedPolicyVersion.data(using: .utf8),
            try JSONDecoder().decode(String.self, from: storedPolicyBytes) == accessPolicyVersion else {
        throw TerrainGridPackReaderError.invalidPackage("bicycle access policy metadata does not match")
      }
    }
    let inferredEdgeCount = try integerValue(
      database,
      query: "SELECT COUNT(*) FROM road_edges WHERE bicycle_access = 'road_class_inferred'"
    )
    guard inferredEdgeCount == 0 || accessPolicyVersion != nil else {
      throw TerrainGridPackReaderError.invalidPackage("inferred access requires a versioned policy")
    }
    guard try integerValue(
      database,
      query: """
        SELECT COUNT(*) FROM road_edges WHERE predictable = 1 AND (
          matchable != 1 OR direction_state != 'allowed'
          OR bicycle_access NOT IN ('allowed', 'road_class_inferred')
        )
        """
    ) == 0 else {
      throw TerrainGridPackReaderError.invalidPackage("road graph predictive access is invalid")
    }

    guard hasProfiles else { return }
    let predictableEdgeCount = try integerValue(
      database,
      query: "SELECT COUNT(*) FROM road_edges WHERE predictable = 1"
    )
    let assignedPredictableEdgeCount = try integerValue(
      database,
      query: """
        SELECT COUNT(*)
        FROM road_corridor_edges AS corridor_edge
        JOIN road_edges AS edge ON edge.edge_id = corridor_edge.edge_id
        WHERE edge.predictable = 1
        """
    )
    let unassignedPredictableEdgeCount = try integerValue(
      database,
      query: """
        SELECT COUNT(*)
        FROM road_edges AS edge
        WHERE edge.predictable = 1
          AND NOT EXISTS (
            SELECT 1 FROM road_corridor_edges AS corridor_edge
            WHERE corridor_edge.edge_id = edge.edge_id
          )
        """
    )
    guard predictableEdgeCount == assignedPredictableEdgeCount,
          unassignedPredictableEdgeCount == 0,
          try integerValue(database, query: "SELECT COUNT(*) FROM road_corridors") > 0 else {
      throw TerrainGridPackReaderError.invalidPackage("road profile corridors do not cover the predictable graph")
    }
  }

  private static func requireRegularFile(_ url: URL) throws {
    var fileStatus = stat()
    guard lstat(url.path, &fileStatus) == 0,
          fileStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else {
      throw TerrainGridPackReaderError.invalidPackage("expected a regular file at \(url.lastPathComponent)")
    }
  }

  private static func requireDirectory(_ url: URL) throws {
    var fileStatus = stat()
    guard lstat(url.path, &fileStatus) == 0,
          fileStatus.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
      throw TerrainGridPackReaderError.invalidPackage("expected a package directory")
    }
  }

  private static func sha256(of url: URL) throws -> String {
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    var hasher = SHA256()
    while let chunk = try file.read(upToCount: 1_048_576), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private static func integerValue(_ database: OpaquePointer, query: String) throws -> Int {
    try withStatement(database, query: query) { statement in
      guard sqlite3_step(statement) == SQLITE_ROW else { throw sqliteError(database) }
      return Int(sqlite3_column_int64(statement, 0))
    }
  }

  private static func textValue(_ database: OpaquePointer, query: String) throws -> String {
    try withStatement(database, query: query) { statement in
      guard sqlite3_step(statement) == SQLITE_ROW else { throw sqliteError(database) }
      return columnText(statement, index: 0)
    }
  }

  private static func withStatement<Value>(
    _ database: OpaquePointer,
    query: String,
    operation: (OpaquePointer) throws -> Value
  ) throws -> Value {
    var statement: OpaquePointer?
    let status = sqlite3_prepare_v2(database, query, -1, &statement, nil)
    guard status == SQLITE_OK, let statement else { throw sqliteError(database) }
    defer { sqlite3_finalize(statement) }
    return try operation(statement)
  }

  private static func bindText(
    _ text: String,
    to statement: OpaquePointer,
    at index: Int32,
    database: OpaquePointer
  ) throws {
    guard sqlite3_bind_text(statement, index, text, -1, sqliteTransient) == SQLITE_OK else {
      throw sqliteError(database)
    }
  }

  private static func bindDouble(
    _ number: Double,
    to statement: OpaquePointer,
    at index: Int32,
    database: OpaquePointer
  ) throws {
    guard sqlite3_bind_double(statement, index, number) == SQLITE_OK else {
      throw sqliteError(database)
    }
  }

  private static func bindInt64(
    _ number: Int64,
    to statement: OpaquePointer,
    at index: Int32,
    database: OpaquePointer
  ) throws {
    guard sqlite3_bind_int64(statement, index, number) == SQLITE_OK else {
      throw sqliteError(database)
    }
  }

  private static func unavailableClimbGuidance(reason: String) -> [String: Any] {
    [
      "terrainClimbStatus": "unavailable",
      "terrainClimbReason": reason,
      "terrainClimbIndex": NSNull(),
      "terrainClimbDistanceToStartMeters": NSNull(),
      "terrainClimbDistanceRemainingMeters": NSNull(),
      "terrainClimbDistanceMeters": NSNull(),
      "terrainClimbNetRiseMeters": NSNull(),
      "terrainClimbElevationGainMeters": NSNull(),
      "terrainClimbAverageGradePercent": NSNull(),
      "terrainClimbMaxGradePercent": NSNull(),
      "terrainClimbProgressPercent": NSNull(),
      "terrainClimbProfileQuality": "unavailable",
      "terrainClimbKnownForwardDistanceMeters": 0,
    ]
  }

  private static func columnData(_ statement: OpaquePointer, index: Int32) -> Data {
    let byteCount = Int(sqlite3_column_bytes(statement, index))
    guard byteCount > 0, let bytes = sqlite3_column_blob(statement, index) else { return Data() }
    return Data(bytes: bytes, count: byteCount)
  }

  private static func columnText(_ statement: OpaquePointer, index: Int32) -> String {
    let byteCount = Int(sqlite3_column_bytes(statement, index))
    guard byteCount > 0, let bytes = sqlite3_column_text(statement, index) else { return "" }
    return String(decoding: UnsafeBufferPointer(start: bytes, count: byteCount), as: UTF8.self)
  }

  private static func hasValidDimensions(_ block: GridBlock) -> Bool {
    guard (1...64).contains(block.rows), (1...64).contains(block.columns) else { return false }
    let cellCount = block.rows * block.columns
    return block.elevationBytes.count == cellCount * 4 &&
      block.validityMask.count == (cellCount + 7) / 8
  }

  private static func elevation(in block: GridBlock, row: Int, column: Int) -> Double? {
    let cellIndex = row * block.columns + column
    let maskByte = block.validityMask[cellIndex / 8]
    guard maskByte & (1 << (cellIndex % 8)) != 0 else { return nil }
    let elevationMeters = Double(float32(in: block.elevationBytes, at: cellIndex))
    return elevationMeters.isFinite ? elevationMeters : nil
  }

  private static func float32(in bytes: Data, at cellIndex: Int) -> Float {
    let rawBits = bytes.withUnsafeBytes { rawBytes in
      UInt32(littleEndian: rawBytes.loadUnaligned(fromByteOffset: cellIndex * 4, as: UInt32.self))
    }
    return Float(bitPattern: rawBits)
  }

  private static func snapToCell(_ coordinate: Double) -> Double {
    let nearestCell = coordinate.rounded()
    return abs(coordinate - nearestCell) < 1e-8 ? nearestCell : coordinate
  }

  private static func sqliteError(_ database: OpaquePointer) -> TerrainGridPackReaderError {
    .sqliteFailure(String(cString: sqlite3_errmsg(database)))
  }

}
