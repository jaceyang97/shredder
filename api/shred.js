// Vercel serverless function backing /shred (see routes in vercel.json).
// Mirrors the /shred handler in server.js; both share the same lib engine.
import { fetchPage, fetchStylesheet, normalizeUrl } from '../lib/fetchPage.js';
import { shred, shredErrorPage } from '../lib/shredder.js';

// Fetching the page + up to 10 external stylesheets can take a few seconds;
// give the function headroom beyond the 10s default.
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const target = url.searchParams.get('url') || '';
  const seedParam = url.searchParams.get('srand') || '';
  // default seed = server unix time, like the original engine
  const seed = /^\d+$/.test(seedParam)
    ? Number(seedParam) >>> 0
    : (Math.floor(Date.now() / 1000) >>> 0);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!normalizeUrl(target)) {
    res.statusCode = 200;
    res.end(shredErrorPage(''));
    return;
  }

  try {
    const page = await fetchPage(target);
    const html = await shred(page, { requestedUrl: target, seed, proxyAssets: true, fetchPage, fetchStylesheet });
    res.statusCode = 200;
    res.end(html);
  } catch (err) {
    console.error(`[shred] ${target} failed: ${err.message}`);
    res.statusCode = 200;
    res.end(shredErrorPage(''));
  }
}
