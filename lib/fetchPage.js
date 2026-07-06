// Fetches a target page the way the original Shredder's CGI did: raw HTTP,
// keeping the status line and headers, because they become part of the shred.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { safeLookup, hostIsBlockedLiteral } from './ssrf.js';

// Some CDNs (CloudFront/Amazon) return a gzip/brotli-compressed body even when
// we don't request it. Decompress by the Content-Encoding header, else the raw
// compressed bytes get rendered as text — the "broken Amazon" garbage. Falls
// back to the raw buffer if decompression fails (e.g. a truncated stream).
function decompress(buf, contentEncoding) {
  const enc = (contentEncoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) {
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
  } catch { /* fall through to raw */ }
  return buf;
}

const MAX_BODY = 4 * 1024 * 1024; // generous — some top-site shells are large
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;
// Match the ORIGINAL engine's request byte-for-byte (probed via httpbin): an
// old Chrome 46 UA + `Accept: */*`, no Accept-Language/Encoding. Sites vary
// their HTML by User-Agent, so using a modern UA would fetch different markup
// than the original and diverge the shreds before the algorithm even runs.
const UA = 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/46.0.2490.80 Safari/537.36';

export function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) return null;
  // The original prepends the scheme for you; bare domains are the norm.
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function requestOnce(url) {
  return new Promise((resolve, reject) => {
    if (hostIsBlockedLiteral(url.hostname)) {
      return reject(new Error('blocked: private or reserved address'));
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': '*/*', // the original sends exactly this
      },
      timeout: TIMEOUT_MS,
      lookup: safeLookup, // refuse private/reserved addresses (SSRF guard)
    }, (res) => {
      resolve({ res, url });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.destroy();
        resolve(Buffer.concat(chunks)); // truncate quietly; the shredder eats what it gets
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

function decodeBody(buf, contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  const charset = (m ? m[1] : 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * Fetch a page, following redirects, and return the pieces the shredder needs:
 * { finalUrl, hops: [{ statusLine, rawHeaders }], body }
 * Every redirect hop's status line + headers are kept — the original shredder
 * feeds them all into the composition.
 */
export async function fetchPage(inputUrl) {
  let url = normalizeUrl(inputUrl);
  if (!url) throw new Error('bad url');

  const hops = [];
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const { res } = await requestOnce(url);
    const status = res.statusCode || 0;
    hops.push({
      statusLine: `HTTP/${res.httpVersion} ${status} ${res.statusMessage || ''}`.trim(),
      rawHeaders: res.rawHeaders, // preserves case + wire order, like the original showed
    });

    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume(); // drain
      if (i === MAX_REDIRECTS) throw new Error('too many redirects');
      url = new URL(res.headers.location, url);
      continue;
    }

    const raw = await readBody(res);
    const buf = decompress(raw, res.headers['content-encoding']);
    const contentType = res.headers['content-type'] || '';
    if (contentType && !/text\/html|application\/xhtml|text\/plain|xml/i.test(contentType)) {
      throw new Error(`not an html page (${contentType.split(';')[0]})`);
    }

    return {
      finalUrl: url.href,
      hops,
      body: decodeBody(buf, contentType),
    };
  }
  throw new Error('too many redirects');
}

/**
 * Fetch a linked stylesheet as text so its colors can be harvested — the
 * original engine does this, which is why modern sites (colors in external
 * CSS, not inline) produce hundreds/thousands of color layers. Returns the CSS
 * text, or '' on any failure (a missing sheet just contributes no colors).
 * Capped in size; the SSRF guard applies via safeLookup.
 */
export function fetchStylesheet(inputUrl, referer) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(inputUrl); } catch { return resolve(''); }
    if (!/^https?:$/.test(url.protocol)) return resolve('');

    let redirects = 0;
    const go = (u) => {
      if (hostIsBlockedLiteral(u.hostname)) return resolve('');
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(u, {
        headers: { 'User-Agent': UA, 'Accept': '*/*', ...(referer ? { Referer: referer } : {}) },
        timeout: 8000,
        lookup: safeLookup,
      }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
          redirects++; res.resume(); go(new URL(res.headers.location, u)); return;
        }
        if (status !== 200) { res.resume(); return resolve(''); }
        const enc = res.headers['content-encoding'];
        const chunks = []; let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 3 * 1024 * 1024) { res.destroy(); resolve(decompress(Buffer.concat(chunks), enc).toString('utf8')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve(decompress(Buffer.concat(chunks), enc).toString('utf8')));
        res.on('error', () => resolve(''));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(''));
    };
    go(url);
  });
}

/**
 * Proxy-fetch a binary resource (image/video) so hotlink-protected assets
 * still render inside shreds. Returns { contentType, stream } or throws.
 */
export function fetchAsset(inputUrl, referer) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(inputUrl);
    } catch {
      return reject(new Error('bad url'));
    }
    if (!/^https?:$/.test(url.protocol)) return reject(new Error('bad scheme'));

    let redirects = 0;
    const go = (u) => {
      if (hostIsBlockedLiteral(u.hostname)) {
        return reject(new Error('blocked: private or reserved address'));
      }
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(u, {
        headers: {
          'User-Agent': UA,
          'Accept': 'image/avif,image/webp,image/*,video/*,*/*;q=0.8',
          ...(referer ? { Referer: referer } : {}),
        },
        timeout: TIMEOUT_MS,
        lookup: safeLookup, // refuse private/reserved addresses (SSRF guard)
      }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
          redirects++;
          res.resume();
          go(new URL(res.headers.location, u));
          return;
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`status ${status}`));
        }
        const contentType = res.headers['content-type'] || 'application/octet-stream';
        // Don't let the image proxy be used as a generic web proxy for pages.
        if (/^\s*(text\/html|application\/xhtml)/i.test(contentType)) {
          res.resume();
          return reject(new Error('not an asset'));
        }
        resolve({ contentType, stream: res });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    };
    go(url);
  });
}
