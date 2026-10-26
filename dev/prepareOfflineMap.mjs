import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const mapDirectory = path.join(projectRoot, 'dev', 'maps');
const toolDirectory = path.join(projectRoot, 'dev', '.tools');
const pmtilesBinary = path.join(toolDirectory, 'pmtiles');
const archivePath = path.join(mapDirectory, 'jatiluwih.pmtiles');
const stylePath = path.join(mapDirectory, 'style.json');
const assetDirectory = path.join(mapDirectory, 'assets');
const sourceArchiveUrl = 'https://build.protomaps.com/20261010.pmtiles';
const routeArea = '115.1091,-8.69713,115.24081,-8.339159';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('Persiapan peta uji ini memerlukan macOS arm64 atau x64.');
}

await mkdir(mapDirectory, { recursive: true });
await mkdir(toolDirectory, { recursive: true });

if (!existsSync(pmtilesBinary)) {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const zipPath = path.join(toolDirectory, 'pmtiles.zip');
  const toolUrl = `https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles-1.31.2_Darwin_${architecture}.zip`;
  await downloadFile(toolUrl, zipPath);
  execFileSync('unzip', ['-o', zipPath, '-d', toolDirectory], { stdio: 'inherit' });
  await chmod(pmtilesBinary, 0o755);
}

if (!existsSync(archivePath)) {
  execFileSync(
    pmtilesBinary,
    ['extract', sourceArchiveUrl, archivePath, `--bbox=${routeArea}`, '--maxzoom=15', '--download-threads=4'],
    { stdio: 'inherit' },
  );
}

if (!existsSync(path.join(assetDirectory, 'fonts', 'OFL.txt'))) {
  throw new Error('Aset font dan sprite lokal belum tersedia di dev/maps/assets.');
}

const styleUrl = new URL('https://npm-style.protomaps.dev/style.json');
styleUrl.searchParams.set('version', '5.7.2');
styleUrl.searchParams.set('theme', 'light');
styleUrl.searchParams.set('tiles', sourceArchiveUrl);
styleUrl.searchParams.set('lang', 'en');

const styleResponse = await fetch(styleUrl);
if (!styleResponse.ok) {
  throw new Error(`Style Protomaps gagal diambil: HTTP ${styleResponse.status}`);
}

const mapStyle = await styleResponse.json();
if (mapStyle.version !== 8 || !Array.isArray(mapStyle.layers)) {
  throw new Error('Style Protomaps tidak sesuai format MapLibre.');
}

mapStyle.sources.protomaps = {
  type: 'vector',
  tiles: ['http://127.0.0.1:8788/tiles-v2/{z}/{x}/{y}.mvt'],
  minzoom: 0,
  maxzoom: 15,
  attribution: 'Protomaps © OpenStreetMap contributors',
};
mapStyle.glyphs = 'http://127.0.0.1:8788/fonts/{fontstack}/{range}.pbf';
mapStyle.sprite = 'http://127.0.0.1:8788/sprites/v4/light';

await writeFile(stylePath, `${JSON.stringify(mapStyle, null, 2)}\n`);
console.log(`Peta uji siap: ${archivePath}`);

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Alat PMTiles gagal diunduh: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}
