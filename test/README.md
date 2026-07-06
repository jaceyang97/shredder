# Shredder parity test suite

The original Shredder's output **embeds the exact source it fetched** (its text
strips are the escaped page HTML). That makes the mapping from a page to its
shred verifiable: for each captured shred, we reconstruct the input and require
our engine to harvest the *same* colors, images, links, and videos the original
did — no fetch skew, no randomness excuses.

```
# fixtures are NOT committed (they are raw third-party HTML captures that can
# embed the sites' own public API keys / tokens) — regenerate them first:
node test/fetch-fixtures.mjs                        # the 16 classic sites
node test/fetch-fixtures.mjs --manifest top-sites.json   # the 38 top sites

npm test                    # parity (both corpora) + engine-output, must be green
npm run test:parity         # harvest rules vs the classic shreds
npm run test:parity-top     # harvest rules vs the top-sites shreds
npm run test:engine         # our engine's OUTPUT structure, end-to-end
```

Each run re-captures from potatoland.org (paced, ~3–4 min per corpus). The tests
print a friendly reminder if the fixtures are missing.

## Files

| file | role |
|------|------|
| `sites.json` | the corpus manifest — 16 deliberately diverse sites |
| `fixtures/<id>.html` | ground truth: a real output of the **original** engine (`srand=1234`) |
| `fixtures/<id>.src.html` | the intact page source, fetched alongside (skew-free harvest oracle for stable pages) |
| `fetch-fixtures.mjs` | (re)captures fixtures from potatoland.org |
| `lib-fixture.mjs` | parses a fixture into layers and **reconstructs the input** from its text strips |
| `parity.mjs` | for each fixture, runs our harvesters on the reconstructed/intact source and requires an exact match to the original's layers |
| `engine-output.mjs` | runs our full engine on each source and checks the OUTPUT obeys every structural rule |
| `derive-colors.mjs` | the rule-derivation harness used to reverse-engineer the color rule |

## The corpus (why these 16)

Chosen to exercise every branch: ancient attribute-color HTML (graffiti,
berkshire, textfiles), inline-`<style>` colors (example, sito, w3c), huge modern
CSS with rgba-hex and `<script>` custom properties (wired, google, wikipedia,
craigslist), framesets (grid6f), `.mp4` players (wired), forms (google), and
net.art chaos (jodi, mfws).

## Rules confirmed from the corpus

- **Text**: 12 strips, `chunkLen = floor(N/12)`, **stride `chunkLen+1`** — the
  original drops one source char at each of the 11 strip seams (a 1998
  off-by-one). `left=top=i*20`, `w60 h800`, one strip is 94px `verylargetext`.
- **Colors**: `#hex` (3/4/6/8-digit) **only from inside `<style>` blocks** — not
  inline `style=` attributes, not `bgcolor=`, not `<script>`, not `&#nn;`
  entities. Document order, duplicates kept. Text strips draw from that palette
  ∪ `{#c0c0c0}`.
- **Images**: one sliver/tile per `<img>` whose `src` is a whitespace-delimited
  attribute (so `data-src`/`srcset` don't count); `data:` skipped.
- **Videos**: one layer per `.mp4` URL substring anywhere in the source.
- **Links**: one per `<a href>`, dropping only empty and `#`-fragment hrefs;
  everything else (incl. `mailto:`) glued to the base by naive concatenation.
- **Resolution**: naive base-dir concatenation, no `../` normalization.

## Known non-rule divergences

The suite reports these but does not fail on them, because they are not
algorithm differences:

- **fetch skew** — a live page served different bytes than the archived shred
  (hn served external-CSS-only HTML; Wikipedia different inline CSS; WIRED's
  headline changed). The colors that *are* present still match the rule.
- **reconstruction boundary-drops** — reconstructing the input from the strips
  inherits the original's 11 dropped chars, which can corrupt a single token
  (a color, a URL) on small frameset sub-sections.
- **wired images** — its lazy-load SPA markup yields 0 layers in the original;
  we render 36 (a richer shred). Documented, not hidden.
