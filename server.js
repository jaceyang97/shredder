// Shredder — local recreation of Mark Napier's Shredder (1998).
// Plain Node, no dependencies. `node server.js` then open http://localhost:8014
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPage, fetchAsset, fetchStylesheet, normalizeUrl } from './lib/fetchPage.js';
import { shred, shredErrorPage } from './lib/shredder.js';

const PORT = process.env.PORT || 8014;
const ROOT = fileURLToPath(new URL('./public', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  const safe = normalize(urlPath).replace(/^([/\\]|\.\.)+/, '');
  const file = join(ROOT, safe === '' || safe === '.' ? 'index.html' : safe);
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

async function handleShred(req, res, query) {
  const target = query.get('url') || '';
  const seedParam = query.get('srand');
  // the original seeds with the server's unix time when none is given
  const seed = seedParam && /^\d+$/.test(seedParam)
    ? Number(seedParam) >>> 0
    : (Math.floor(Date.now() / 1000) >>> 0);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!normalizeUrl(target)) {
    res.writeHead(200);
    res.end(shredErrorPage(''));
    return;
  }

  try {
    const page = await fetchPage(target);
    const html = await shred(page, { requestedUrl: target, seed, proxyAssets: true, fetchPage, fetchStylesheet });
    res.writeHead(200);
    res.end(html);
  } catch (err) {
    console.error(`[shred] ${target} failed: ${err.message}`);
    res.writeHead(200);
    res.end(shredErrorPage(''));
  }
}

async function handleAsset(req, res, query) {
  const u = query.get('u') || '';
  const ref = query.get('ref') || undefined;
  try {
    const { contentType, stream } = await fetchAsset(u, ref);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
    stream.pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('asset unavailable');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/shred') return await handleShred(req, res, url.searchParams);
    if (url.pathname === '/asset') return await handleAsset(req, res, url.searchParams);
    return await serveStatic(res, decodeURIComponent(url.pathname));
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('server error');
  }
});

server.listen(PORT, () => {
  console.log(`Shredder running at http://localhost:${PORT}`);
});
