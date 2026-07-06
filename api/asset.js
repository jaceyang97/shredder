// Vercel serverless function backing /asset (see routes in vercel.json).
// Proxies remote images/videos so hotlink-protected assets still render inside
// shreds. The SSRF guard lives in lib/fetchPage.js -> lib/ssrf.js.
import { fetchAsset } from '../lib/fetchPage.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const u = url.searchParams.get('u') || '';
  const ref = url.searchParams.get('ref') || undefined;

  try {
    const { contentType, stream } = await fetchAsset(u, ref);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.statusCode = 200;
    await new Promise((resolve, reject) => {
      stream.on('error', (e) => {
        if (!res.headersSent) reject(e);
        else { res.end(); resolve(); }
      });
      res.on('error', reject);
      res.on('finish', resolve);
      stream.pipe(res);
    });
  } catch {
    if (!res.headersSent) {
      res.statusCode = 404;
      res.end('asset unavailable');
    }
  }
}
