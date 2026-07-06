// Downloads ground-truth fixtures from the ORIGINAL Shredder engine at
// potatoland.org — one per site in sites.json, pinned to a fixed srand so the
// layout is reproducible. Sequential with a polite delay (it is a 27-year-old
// art server). Existing fixtures are kept unless --refresh is passed.
//
//   node test/fetch-fixtures.mjs [--refresh] [id ...]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = 'https://potatoland.org/shredder/php/shred_v1_3521.php';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const REFERER = 'https://potatoland.org/shredder/toolbar.html';
const DELAY_MS = 2500;

const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
// --manifest <file> picks a different site list; fixtures land in a sibling
// directory named after it (sites.json -> fixtures/, top-sites.json -> fixtures-top/)
const mArg = args.indexOf('--manifest');
const manifestFile = mArg >= 0 ? args[mArg + 1] : 'sites.json';
const FIXDIR = join(HERE, manifestFile === 'sites.json' ? 'fixtures' : 'fixtures-' + manifestFile.replace(/\.json$/, '').replace(/-sites$/, ''));
const { seed, sites } = JSON.parse(readFileSync(join(HERE, manifestFile), 'utf8'));
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--manifest');

mkdirSync(FIXDIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = 0, failed = 0, skipped = 0;
for (const site of sites) {
  if (only.length && !only.includes(site.id)) continue;
  const file = join(FIXDIR, `${site.id}.html`);
  if (existsSync(file) && !refresh) {
    console.log(`  = ${site.id} (kept)`);
    skipped++;
    continue;
  }
  // the WAF rejects raw slashes in the url param
  const target = site.target.replaceAll('/', '%2F');
  const url = `${ENGINE}?frame=n&url=${target}&srand=${seed}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: REFERER },
      signal: AbortSignal.timeout(90000),
    });
    const body = await res.text();
    if (!body.includes('Start Shred:')) {
      const why = body.includes('<h3>Error') ? 'engine error page'
        : body.includes('Not Acceptable') ? 'WAF block'
        : `unrecognized (${body.length}b)`;
      console.log(`  ✗ ${site.id}: ${why}`);
      failed++;
    } else {
      writeFileSync(file, body);
      // Also save the INTACT page source. The shred's text strips are lossy
      // (one char dropped per strip boundary), so harvest-rule derivation needs
      // the real bytes. CSS/colors are stable across fetches even on dynamic
      // pages, which is what the color rule is derived against.
      let srcNote = '';
      try {
        const outM = /<!-{2,}\s*Output Shred:\s*(.*?)\s*-{2,}>/.exec(body);
        const realUrl = outM ? outM[1] : (/^https?:/i.test(site.target) ? site.target : 'http://' + site.target);
        const sres = await fetch(realUrl, {
          headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
          signal: AbortSignal.timeout(60000),
        });
        writeFileSync(join(FIXDIR, `${site.id}.src.html`), Buffer.from(await sres.arrayBuffer()));
        srcNote = ' +src';
      } catch (e) {
        srcNote = ` (src failed: ${e.message})`;
      }
      console.log(`  ✓ ${site.id} (${body.length} bytes)${srcNote}`);
      ok++;
    }
  } catch (e) {
    console.log(`  ✗ ${site.id}: ${e.message}`);
    failed++;
  }
  await sleep(DELAY_MS);
}
console.log(`\nfixtures: ${ok} fetched, ${skipped} kept, ${failed} failed`);
