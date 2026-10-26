import { spawn } from 'node:child_process';
import { createReadStream, existsSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const mapDirectory = path.join(projectRoot, 'dev', 'maps');
const pmtilesBinary = path.join(projectRoot, 'dev', '.tools', 'pmtiles');
const stylePath = path.join(mapDirectory, 'style.json');
const assetDirectory = path.join(mapDirectory, 'assets');
const mapCache = 'public, max-age=31536000';

function isValidPmtiles(filepath) {
  try {
    if (!existsSync(filepath)) return false;
    const fd = openSync(filepath, 'r');
    const buffer = Buffer.alloc(7);
    readSync(fd, buffer, 0, 7, 0);
    closeSync(fd);
    return buffer.toString('utf8') === 'PMTiles';
  } catch {
    return false;
  }
}

function getPrimaryArchive() {
  if (isValidPmtiles(path.join(mapDirectory, 'indonesia.pmtiles'))) return 'indonesia';
  if (isValidPmtiles(path.join(mapDirectory, 'jatiluwih.pmtiles'))) return 'jatiluwih';
  return null;
}

const archiveName = getPrimaryArchive();
if (!archiveName || !existsSync(pmtilesBinary) || !existsSync(stylePath)) {
  throw new Error('Jalankan npm run maps:prepare sebelum menyalakan server peta.');
}

const mapStyle = readFileSync(stylePath, 'utf8');

const tileServer = spawn(
  pmtilesBinary,
  [
    'serve',
    mapDirectory,
    '--interface=127.0.0.1',
    '--port=8787',
    '--public-url=http://127.0.0.1:8787',
  ],
  { stdio: 'inherit' },
);

const styleServer = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', '*');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const rawHost = request.headers.host || '127.0.0.1:8788';
  const pathname = new URL(request.url ?? '/', `http://${rawHost}`).pathname;

  if (pathname === '/health' || pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      service: 'CycleComp Map Server (Local)',
      archive: getPrimaryArchive(),
    }));
    return;
  }

  if (pathname === '/style-v4.json' || pathname === '/style.json') {
    const isHttps = request.headers['x-forwarded-proto'] === 'https' || request.socket.encrypted;
    const scheme = isHttps ? 'https' : 'http';

    response.writeHead(200, {
      'Cache-Control': mapCache,
      'Content-Type': 'application/json',
    });
    response.end(
      mapStyle
        .replaceAll('http://127.0.0.1:8788', `${scheme}://${rawHost}`)
        .replaceAll('127.0.0.1:8788', rawHost)
        .replaceAll('/tiles-v2/', '/tiles-v4/')
        .replaceAll('/fonts/', '/fonts-v4/')
        .replaceAll('/sprites/v4/', '/sprites-v4/'),
    );
    return;
  }

  if (/^\/tiles(-v[24])?\/\d+\/\d+\/\d+\.mvt$/.test(pathname)) {
    const activeArchive = getPrimaryArchive() || 'jatiluwih';
    const tileMatch = pathname.match(/^\/tiles(?:-v[24])?(\/\d+\/\d+\/\d+\.mvt)$/);
    const tileSubpath = tileMatch ? tileMatch[1] : pathname;
    const tileUrl = `http://127.0.0.1:8787/${activeArchive}${tileSubpath}`;

    get(tileUrl, upstream => {
      response.writeHead(upstream.statusCode ?? 502, {
        ...upstream.headers,
        'access-control-allow-origin': '*',
        'cache-control': mapCache,
      });
      upstream.pipe(response);
    }).on('error', () => {
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
    return;
  }

  let assetPath;
  try {
    const assetUrlPath = decodeURIComponent(pathname)
      .replace(/^\/fonts(-v[24])?\//, '/fonts/')
      .replace(/^\/sprites(-v[24])?\//, '/sprites/v4/');
    assetPath = path.resolve(assetDirectory, `.${assetUrlPath}`);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }

  if (!assetPath.startsWith(`${assetDirectory}${path.sep}`) || !existsSync(assetPath)) {
    response.writeHead(404);
    response.end();
    return;
  }

  const contentType = assetPath.endsWith('.png')
    ? 'image/png'
    : assetPath.endsWith('.json')
      ? 'application/json'
      : 'application/x-protobuf';
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': mapCache,
    'Content-Type': contentType,
  });
  createReadStream(assetPath).pipe(response);
});

styleServer.listen(8788, '0.0.0.0', () => {
  console.log('Style: http://localhost:8788/style-v4.json');
});

function stopServers() {
  styleServer.close();
  tileServer.kill('SIGTERM');
}

process.on('SIGINT', stopServers);
process.on('SIGTERM', stopServers);
tileServer.on('exit', code => {
  if (code && code !== 0) {
    console.error(`Server tile berhenti dengan kode ${code}.`);
    styleServer.close();
  }
});

