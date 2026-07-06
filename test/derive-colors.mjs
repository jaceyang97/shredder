// Derives the original's color-harvest rule by testing candidate regexes
// against the ground-truth ClrLyr lists, using the INTACT page source.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFixture, reconstructInput } from './lib-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');

function styleBlocks(src) {
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m, css = ''; while ((m = re.exec(src))) css += m[1] + '\n';
  return css;
}

// candidate rules: each returns the ordered list of harvested colors
const candidates = {
  // S36: style blocks only, 3 or 6 digit hex, preceding-char guard
  'S 3/6': (src) => {
    const out = []; const re = /(^|[^0-9a-zA-Z"'=&])#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
    let m; const css = styleBlocks(src); while ((m = re.exec(css))) out.push('#' + m[2]); return out;
  },
  // S38: style blocks only, 3-8 digit hex (CSS4 rgba)
  'S 3-8': (src) => {
    const out = []; const re = /(^|[^0-9a-zA-Z"'=&])#([0-9a-fA-F]{3,8})(?![0-9a-fA-F])/g;
    let m; const css = styleBlocks(src); while ((m = re.exec(css))) out.push('#' + m[2]); return out;
  },
  // S-simple: style blocks only, greedy #hex 3+ no guard (naive 1998 regex)
  'S simple': (src) => {
    const out = []; const re = /#([0-9a-fA-F]{3,})/g;
    let m; const css = styleBlocks(src); while ((m = re.exec(css))) out.push('#' + m[1]); return out;
  },
  // A: whole-doc, preceded by non-[alnum " ' = &], 3 or 6 digits
  'A 3/6 ctx': (src) => {
    const out = [];
    const re = /(^|[^0-9a-zA-Z"'=&])#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
    let m; while ((m = re.exec(src))) out.push('#' + m[2]);
    return out;
  },
  // B: like A but allow 3-8 digits (CSS4 rgba)
  'B 3-8 ctx': (src) => {
    const out = [];
    const re = /(^|[^0-9a-zA-Z"'=&])#([0-9a-fA-F]{3,8})(?![0-9a-fA-F])/g;
    let m; while ((m = re.exec(src))) out.push('#' + m[2]);
    return out;
  },
  // C: greedy any-length hex >=3, preceded ctx (1998-style #[0-9a-f]+)
  'C 3+ ctx': (src) => {
    const out = [];
    const re = /(^|[^0-9a-zA-Z"'=&])#([0-9a-fA-F]{3,})/g;
    let m; while ((m = re.exec(src))) out.push('#' + m[2]);
    return out;
  },
  // D: only preceded by ':' or whitespace (strict CSS value)
  'D colon/ws': (src) => {
    const out = [];
    const re = /[:\s]#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
    let m; while ((m = re.exec(src))) out.push('#' + m[1]);
    return out;
  },
};

function cmp(mine, theirs) {
  if (mine.length !== theirs.length) {
    const i = mine.findIndex((v, k) => v !== theirs[k]);
    return { ok: false, why: `len ${mine.length}!=${theirs.length}, first ≠ @${i}: ${mine[i]} vs ${theirs[i]}` };
  }
  for (let i = 0; i < mine.length; i++) if (mine[i] !== theirs[i]) return { ok: false, why: `@${i}: ${mine[i]} vs ${theirs[i]}` };
  return { ok: true };
}

const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = (ids.length ? ids : null);
import { readdirSync } from 'node:fs';
const all = (files || readdirSync(FIX).filter((f) => f.endsWith('.html') && !f.endsWith('.src.html')).map((f) => f.replace('.html', '')));

for (const name of Object.keys(candidates)) {
  let pass = 0, total = 0;
  const fails = [];
  for (const id of all) {
    total++;
    const fixture = parseFixture(readFileSync(join(FIX, `${id}.html`), 'latin1'));
    // reconstructed source = the exact bytes the original shredded (skew-free)
    const src = reconstructInput(fixture.sections[0]).source;
    const truth = fixture.sections[0].colorLayers.map((c) => c.color);
    const got = candidates[name](src).slice(0, 400);
    const r = cmp(got, truth);
    if (r.ok) pass++; else fails.push(`${id}: ${r.why}`);
  }
  console.log(`\n## ${name}: ${pass}/${total} exact`);
  for (const f of fails.slice(0, 8)) console.log('   ✗ ' + f);
}
