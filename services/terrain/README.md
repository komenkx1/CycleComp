# Terrain elevation lookup

This service is a bounded lookup prototype for route preparation. It reads only raster files listed in a local, versioned manifest. It does not download data, accept arbitrary file paths, or receive ride updates.

The reader uses bilinear interpolation over the raster's pixel centers. It keeps zero and negative elevations, returns `null` for nodata or missing coverage, and can read the four neighboring pixels across a tile seam when both tiles are installed. Tile hashes are checked before first use, only four raster files stay open by default, and GDAL's raster-block cache is capped at 64 MiB during each lookup batch. A bounded LRU holds at most 128 masked 64×64 windows so nearby samples reuse raster reads; closing the store clears it.

## Run locally

Use Python 3.12–3.14; the latest real-data pilot was checked with Python 3.13.14. `requirements.lock` pins runtime dependencies; `requirements-dev.lock` also pins the test client and pytest:

```sh
python3.14 -m venv /tmp/cyclecomp-terrain-env
/tmp/cyclecomp-terrain-env/bin/pip install -r requirements.lock -r requirements-dev.lock
PYTHONPATH=src /tmp/cyclecomp-terrain-env/bin/pytest
PYTHONPATH=src CYCLECOMP_TERRAIN_DATASET_DIR=/path/to/terrain/release \
  /tmp/cyclecomp-terrain-env/bin/uvicorn cyclecomp_terrain.main:app --host 127.0.0.1 --port 8787
```

Install the runtime with `/tmp/cyclecomp-terrain-env/bin/pip install -r requirements.lock` when tests are not needed.

The default dataset directory is `/var/lib/cyclecomp/terrain/current`. The API process should run as a non-root user with read-only access to that directory. Dataset builds and downloads are separate jobs.

## Offline elevation-grid pilot

`cyclecomp_terrain.grid_pack.build_elevation_grid_pack` writes a regional SQLite pilot from the installed raster manifest. Bounds are `[west, south, east, north]`; only source pixel centers inside those bounds are core cells. Blocks store signed Float32 little-endian elevations and a least-significant-bit-first validity mask. Each block has up to 62×62 core cells plus a one-cell halo, with an SQLite R-tree for candidate lookup.

The pilot manifest records the source, vertical datum, effective cell coverage, SQLite size, SHA-256 and `signatureStatus: "unsigned_pilot"`. The CLI can either leave an explicitly requested unsigned pilot or sign it with a detached raw Ed25519 signature at `manifest.ed25519` over the exact manifest bytes. Signed output identifies its key with `signatureKeyId`, validates the SQLite database and file hash before signing, and is promoted to the output path only after signing succeeds. Its JSON summary includes `trustedPublicKeyBase64` for provisioning the matching public key in app configuration. Keep the private key out of the app and repository. For routine releases, use a trusted release environment. On-demand builds described below are the exception: their key must be readable only by the isolated builder service account, never by the API process. Grid-only builds advertise no road graph. A signed pack still requires its public key to be added to the app's trusted-key configuration before iOS will install it.

To split only the DEM coverage listed in a dataset manifest into smaller grid-only areas, generate a regional config first. The default chunk size is 0.25 degrees (roughly 28 km north-to-south); this is a geographic partition, not a promise that each SQLite file has a fixed size. Pass `--dataset-directory` to read each source raster window, omit chunks with no finite unmasked cells, and record the valid-cell fraction for chunks that remain. The config generator does not download or infer missing tiles:

```sh
PYTHONPATH=src /tmp/cyclecomp-terrain-env/bin/python -m cyclecomp_terrain.grid_region_cli \
  --dataset-manifest /path/to/terrain/release/manifest.json \
  --release-id indonesia-grid-2026-10 \
  --signature-key-id terrain-release-2026 \
  --dataset-directory /path/to/terrain/release \
  --output /path/to/release-config.json
```

Use `--chunk-size-degrees` to change the partition. `--exclude-tile-id` can omit a source tile only when another installed package fully covers that tile; excluding a whole DEM tile to avoid a small overlap can create a much larger coverage gap. Review the generated `regions` against the source manifest and existing catalog before running `regional_pipeline.py`. The pipeline still requires a trusted signing key and checks its 20 GiB disk-headroom gate. A sparse manifest stays sparse, even if its chunks use nationwide naming.

### OSM road-graph pilot

An optional OSM PBF can add directed road segments to `terrain.sqlite`. The builder streams the PBF with Pyosmium and a temporary disk-backed node-location index, splits ways at shared OSM nodes and tagged road nodes, and preserves full way/node tags plus turn-restriction members. A geometric crossing without shared OSM node IDs remains disconnected. Each physical segment has two matchable directed observations; access and one-way policy are recorded separately so prohibited directions can still match a rider's observed position without becoming predictive candidates. Conditional or unsupported access stays unknown/conditional. Segment length uses WGS84 geodesics; geometry stores WGS84 coordinate pairs as little-endian Float64.

The pilot records PBF URL, snapshot timestamp and SHA-256, ODbL attribution/license, selected bounds and buffer. Bicycle access uses the versioned consumer policy `cyclecomp-bicycle-access-v1`. Explicit bicycle, vehicle and access tags, including directional and conditional tags, take priority. Untagged cycleways and ordinary road classes (living street, residential, unclassified, tertiary, secondary, primary and trunk, including their links) can be predictive with `road_class_inferred` provenance. Motorways, motorroads, service roads, paths, tracks and footways get no road-class fallback. This is a data-consumer estimate, not verified legal access; see the [OSM access caveats](https://wiki.openstreetmap.org/wiki/Default_access_restrictions). Unknown or conditional alternatives, barriers without explicit permission and turn restrictions stop a corridor.

A graph pack samples every directed edge from the local DEM, then stitches deterministic corridors only through a single predictable continuation. Ambiguous branches, merges, turn-restriction boundaries, dead-ends, cycles and the 128-edge limit are recorded. The shared TypeScript elevation kernel computes corridor profiles and climb candidates; unknown DEM intervals and bridge/tunnel surfaces stay null and cannot be crossed by a climb. Profile algorithm `cyclecomp-route-elevation-v2` preserves measurable submeter edges and unrounded sample distances; short profiles retain endpoints without inventing grade. The signer validates edge coverage, access provenance, corridor order/connectivity, sample provenance, gaps and climb ranges.

The iOS reader verifies the grid and reads local road corridors for its bounded matcher. A native ride runtime can surface offline climb guidance when the road match is stable and the stored profile is usable. Any inferred access in the corridor remains `inferred_to_boundary`, and the dashboard labels it as an estimated path. Guidance expires after three seconds without a fresh fix; results queued before a pause or new ride cannot restore an older session's guidance. New graph packs require reader version 2; this reader also accepts legacy version-1 packs. A synthetic-pack simulator replay passed. The first signed real-data Bedugul pilot exposed an explicit-access-only coverage failure; its sparse GPX replay also had many gaps above the matcher's 12-second continuity limit. These baseline findings and the corrected one-second replay are recorded separately in the [production plan](../../docs/OFFLINE_TERRAIN_PRODUCTION_PLAN.md). The release build has no trusted production signing key; real-data coverage, checkpoint recovery, Release lockscreen behavior, regional coverage and ODbL publication review remain open. `pilot_partial` is not a complete coverage claim.

Build with a separately obtained PBF extract, after installing the pinned dependencies:

```sh
PYTHONPATH=src /tmp/cyclecomp-terrain-env/bin/python -m cyclecomp_terrain.pack_cli \
  --dataset-dir /path/to/terrain/release \
  --output-dir /path/to/output/jatiluwih-pilot \
  --pack-id jatiluwih-pilot-1 \
  --bounds 115.129 -8.361 115.131 -8.359 \
  --osm-pbf /path/to/indonesia.osm.pbf \
  --osm-source-url https://download.geofabrik.de/asia/indonesia/nusa-tenggara-261014.osm.pbf \
  --osm-snapshot-at 2026-10-14T20:21:12Z \
  --road-graph-buffer-meters 1000 \
  --unsigned-pilot
```

The source URL and timestamp are required together with the PBF. The PBF is not downloaded automatically and is not embedded in the pack. Keep the exact extract URL, snapshot timestamp and SHA-256 with each build. Graph builds require the repository's Node.js 22.23.2; run `nvm use` first. The CLI writes build stages and edge/corridor counts to stderr while keeping its final JSON summary on stdout. Segments no longer than 1 cm are excluded and counted in `skippedDegenerateSegmentCount`; measurable short edges retain their final profile endpoint. Before publishing predictive climbs, validate real-area coverage and profiles, configure the production trust root, test Release behavior, and complete ODbL review for the derived database.

Run it from `services/terrain` after installing the pinned development dependencies:

```sh
PYTHONPATH=src /tmp/cyclecomp-terrain-env/bin/python -m cyclecomp_terrain.pack_cli \
  --dataset-dir /path/to/terrain/release \
  --output-dir /path/to/output/bali-pilot \
  --pack-id bali-pilot-1 \
  --bounds 115.129 -8.361 115.131 -8.359 \
  --unsigned-pilot
```

For a signed build, replace the final `--unsigned-pilot` argument with `--signing-key /secure/build/secrets/terrain-ed25519.pem --signature-key-id terrain-release-2026`.

The signer does not provision the corresponding trusted public key in `Info.plist` or turn a pilot pack into a production dataset. Those remain separate release gates.

### Signed catalog and package distribution

The local API can serve a signed catalog and immutable SQLite packages when `CYCLECOMP_TERRAIN_DISTRIBUTION_DIR` and `CYCLECOMP_TERRAIN_TRUSTED_SIGNING_KEYS` are configured. The distribution directory contains `releases/{releaseId}/{chunkId}/` package folders. The publisher verifies every package with the same release key, writes the catalog and detached signature to a content-addressed immutable directory, then atomically replaces `current.json`.

Run the publisher from `services/terrain` after staging signed packages under the release directory:

```sh
PYTHONPATH=src /tmp/cyclecomp-terrain-env/bin/python -m cyclecomp_terrain.catalog_cli \
  --distribution-dir /srv/cyclecomp/terrain/distribution \
  --release-id bali-pilot-2026-10 \
  --signing-key /secure/build/secrets/terrain-ed25519.pem \
  --signature-key-id terrain-release-2026
```

Configure the API with a JSON object mapping trusted key IDs to base64-encoded 32-byte public keys. Catalog selection and package contents are verified before an API response; SQLite downloads support HTTP `Range` and are capped at 256 MiB. This is a raw SQLite transfer to match the native installer. Keep the distribution read-only to the API process.

### On-demand packs for saved offline map areas

The national DEM manifest can be converted into a versioned region config with `grid_region_cli.py`. Build it once from the staged dataset using `--dataset-directory` so regions without valid raster cells are excluded. The current config uses 0.25-degree chunks. When the rider taps **Siapkan elevasi untuk area peta**, the app sends only the saved offline-map bounds to `POST /v1/terrain/areas`; the server selects intersecting DEM chunks, queues a persistent job, and the app polls `GET /v1/terrain/areas/{jobId}`. It does not prebuild all of Indonesia. A map area is rounded up to the fixed chunks it intersects, so a pack can include terrain outside the exact map bounds. Requests are limited to 16 saved-map bounds and 64 chunks; a larger selection must be divided into smaller saved map areas.

Run `cyclecomp_terrain.area_worker` as a separate, unprivileged systemd service. The API process needs the region config, trusted public keys, distribution read access, and write access only to the job-state directory. It does not load the raster dataset or private signing key. The builder account reads the staged DEM and key, writes immutable package/cache/catalog files, and updates persistent job states. Keep the signing key mode `0400` or `0600` under a directory inaccessible to the API account. Keep one area-job worker initially; each job builds at most two independent chunks at a time, with CPU/RAM limits and the existing 20 GiB disk-headroom gate. If an existing systemd drop-in later clears `Environment=`, load `deploy/cyclecomp-terrain-area-api-env.conf.example` after it (for example, as `zz-area-preparation.conf`) so the area settings remain effective. The reverse proxy should rate-limit `POST /v1/terrain/areas`; the app binary has no shared secret that can protect a public endpoint.

Area builds use content-addressed chunk caches and hard links to avoid rebuilding or duplicating package bytes. Keep the worker's writable distribution path on one mount so the cache, release, and catalog promotion can use atomic filesystem operations. The distribution root itself must remain owned by the deployment account with mode `0755`; the builder account can write inside its provisioned subdirectories but cannot replace `current.json`. Each completed area gets a signed, immutable catalog with release-specific package URLs. It does **not** replace `current.json`, so an area request cannot overwrite the published global catalog. The app then uses its normal signed manifest/database download and atomic native installation flow. Packs already installed on the phone remain usable offline; preparing a new area requires a network connection once. Elevation lookup outside the downloaded terrain chunks remains unknown.

The grid builder is also available for scripted, unsigned pilot builds:

```python
from pathlib import Path

from cyclecomp_terrain.grid_pack import build_elevation_grid_pack
from cyclecomp_terrain.raster_elevation import RasterElevationStore

store = RasterElevationStore(Path("/path/to/terrain/release"))
try:
    pack = build_elevation_grid_pack(
        store,
        Path("/path/to/output/bali-pilot"),
        "bali-pilot-1",
        (115.129, -8.361, 115.131, -8.359),
    )
finally:
    store.close()
```

## Dataset manifest schema 1

Put `manifest.json` at the dataset root. Tile paths are relative to that directory and must end in `.tif` or `.tiff`.

```json
{
  "schemaVersion": 1,
  "datasetVersion": "copernicus-glo30-2021-pilot-1",
  "source": {
    "name": "Copernicus GLO-30 DSM",
    "release": "2021 per distributor README",
    "verticalDatum": "EGM2008",
    "resolutionMeters": 30,
    "attribution": "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved."
  },
  "tiles": [
    {
      "id": "S09_00_E115_00",
      "file": "tiles/S09_00_E115_00.tif",
      "sha256": "<64 lowercase hexadecimal characters>",
      "bounds": [114.9998611111, -8.9998611111, 115.9998611111, -7.9998611111]
    }
  ]
}
```

Bounds use `[west, south, east, north]` in EPSG:4326 and must match the raster. Only listed tiles count as coverage; a sparse sample manifest does not imply national coverage. The source is a digital surface model, so it can include vegetation and buildings and does not resolve bridge decks or tunnel floors.

## Staging a Copernicus DEM inventory

`cyclecomp_terrain.copernicus_staging_cli` downloads an existing S3 inventory into a separate staging directory. It resumes partial files with `Range` and `If-Match`, validates response ETag and size, calculates SHA-256, checks each raster's EPSG:4326 bounds, and writes the dataset manifest atomically only after every tile succeeds. It requires at least 20 GiB of free-space headroom by default. It does not activate a dataset, restart the API, create terrain packages, or publish a catalog.

```sh
PYTHONPATH=src /tmp/cyclecomp-terrain-env/bin/python -m cyclecomp_terrain.copernicus_staging_cli \
  --inventory /path/to/manifest.json.crawler.bak \
  --output-directory /srv/cyclecomp/terrain/staging/indonesia-dem-2026-10 \
  --dataset-version copernicus-glo30-indonesia-2026-10 \
  --workers 4
```

Use an isolated path under `staging/`, never the dataset directory the API currently reads. Review the generated manifest and full raster validation before pointing a release build at it. Preserve the inventory manifest and boundary hash with the staged dataset so a future release can reproduce its tile selection.

## Endpoints

- `GET /healthz` reports that the process responds.
- `GET /readyz` reports whether the manifest loaded and its listed tile paths exist. Each tile's SHA-256 is checked on first use, so `ready` does not certify every tile's contents; a corrupt tile returns 503 for its lookup. Signed releases and a publication-time full integrity gate are still required before deployment.
- `POST /v1/elevation/batch` accepts 1–2,000 `{longitude, latitude}` coordinates, limits the body to 256 KiB and admits at most two batches at once. It preserves request order and reports per-point coverage/nodata reasons.

Request bodies and coordinates are not logged by this service. Keep reverse-proxy access logging free of request bodies. A deployment must still add rate limits, resource limits, monitoring, backup and restore checks; local endpoint tests do not make this a production deployment. Configure deployment URLs, catalogs, signing keys, and dataset paths for your own environment. Never commit private signing keys or production credentials. The app filters the catalog against saved offline-map bounds. In iOS Simulator, the downloader uses a foreground `URLSession` because the simulator runtime does not provide `nsurlsessiond`; physical iOS builds keep the background download session.
