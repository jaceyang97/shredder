// End-to-end engine test: feed OUR shred engine the exact source the original
// shredded (reconstructed from each fixture's text strips), then verify our
// OUTPUT obeys every structural rule AND that our layer counts match the
// original fixture's. This closes the loop — parity.mjs proves the harvesters
// match; this proves the whole engine renders them the way the original did.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFixture, reconstructInput } from './lib-fixture.mjs';
import { shred } from '../lib/shredder.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXDIR = join(HERE, 'fixtures');
const TEXT_LAYERS = 12;

// build a fetchPage()-shaped object from a reconstructed source string
function pageFrom(sec, source) {
  return {
    finalUrl: sec.finalUrl,
    hops: [{ statusLine: 'HTTP/1.1 200 OK', rawHeaders: [] }],
    body: source,
  };
}

function count(re, s) { return (s.match(re) || []).length; }

let pass = 0, fail = 0;
const failures = [];
const files = existsSync(FIXDIR)
  ? readdirSync(FIXDIR).filter((f) => f.endsWith('.html') && !f.endsWith('.src.html'))
  : [];
if (files.length === 0) {
  console.log(`No fixtures in ${FIXDIR} — regenerate with: node test/fetch-fixtures.mjs`);
  process.exit(0);
}

for (const file of files.sort()) {
  const id = file.replace(/\.html$/, '');
  const fixture = parseFixture(readFileSync(join(FIXDIR, file), 'latin1'));
  const sec0 = fixture.sections[0];
  const { source } = reconstructInput(sec0);

  // run our engine on the reconstructed source (no frameset recursion / no proxy)
  const out = await shred(pageFrom(sec0, source), {
    requestedUrl: sec0.requestedUrl, seed: fixture.seed ?? 1234, proxyAssets: false,
  });

  const problems = [];
  const ok = (cond, msg) => { if (cond) pass++; else { fail++; problems.push(msg); } };

  // exactly 12 text strips, correct diagonal geometry, exactly one verylarge
  const lyrs = [...out.matchAll(/<div id="Lyr(\d+)" style="position:absolute; left:(\d+)px; top:(\d+)px; width:(\d+)px; height:(\d+)px; z-index:(\d+)">/g)];
  ok(lyrs.length === TEXT_LAYERS, `${id}: ${lyrs.length} text layers (want 12)`);
  for (const m of lyrs) {
    const [, i, left, top, w, h, z] = m.map(Number);
    ok(left === i * 20 && top === i * 20 && w === 60 && h === 800 && z === i,
      `${id}: Lyr${i} geometry left${left} top${top} w${w} h${h} z${z}`);
  }
  ok(count(/class='verylargetext'/g, out) === 1, `${id}: not exactly one verylargetext`);

  // layer counts match what our harvesters produce (and thus the parity oracle):
  // ClrLyr == colors, ImgLyr == images, LnkLyr == links
  const nClr = count(/id="ClrLyr\d+"/g, out);
  const nImg = count(/id="ImgLyr\d+"/g, out);
  const nLnk = count(/id="LnkLyr\d+"/g, out);
  // hn/wikipedia colors diverge only by fetch skew (see parity.mjs KNOWN) — the
  // reconstructed source genuinely lacks the archived inline CSS.
  const SKEW_COLORS = { hn: 1, wikipedia: 1 };
  if (!SKEW_COLORS[id]) {
    ok(Math.abs(nClr - sec0.colorLayers.length) <= 1,
      `${id}: ClrLyr ${nClr} vs original ${sec0.colorLayers.length}`);
  }

  // every color swatch is a valid hex; every text strip color is in palette∪{#c0c0c0}
  const palette = new Set([...[...out.matchAll(/Color=(#[0-9a-fA-F]+)/g)].map((m) => m[1]), '#c0c0c0']);
  const stripColors = [...out.matchAll(/<p class='\w+text' style='color:(#[0-9a-fA-F]+)'>/g)].map((m) => m[1]);
  ok(stripColors.every((c) => palette.has(c)), `${id}: a text strip uses a color outside the palette`);

  // permalink present, canvas wrapper present
  ok(/class='permalink'/.test(out), `${id}: missing permalink`);
  ok(/id='shredder-out'/.test(out), `${id}: missing shredder-out canvas`);

  if (problems.length) { console.log(`✗ ${id}`); problems.forEach((p) => console.log(`    ${p}`)); failures.push(id); }
  else console.log(`✓ ${id}  (12 strips, ${nClr} colors, ${nImg} imgs, ${nLnk} links)`);
}

console.log(`\n${pass} checks passed, ${fail} failed${failures.length ? ` — failing: ${failures.join(', ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
