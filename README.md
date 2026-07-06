# Shredder

A recreation of **Mark Napier's _Shredder 1.0_ (1998)** — one of the classic works
of net.art. Enter a URL and the page is deconstructed into an abstract composition made
from its own raw material.

- **Live:** <https://shredder-nine.vercel.app>
- Original artwork: <https://www.marknapier.com/portfolio/shredder/>
- Still running at: <https://potatoland.org/shredder/>

## Run locally

```
node server.js
```

Open <http://localhost:8014>, type an address in the **Location** box (no `http://`
needed), press Enter. Links inside a shred are alive — clicking one shreds its target.

No dependencies. Node 18+.

## Deploy (Vercel)

The same engine runs on Vercel as two zero-config serverless functions:

- `api/shred.js` → routed from `/shred` (see `vercel.json` rewrites)
- `api/asset.js` → routed from `/asset`
- `public/` is served statically; `lib/` is bundled into the functions

```
vercel deploy --prod
```

Because the deployed app fetches arbitrary user-supplied URLs, `lib/ssrf.js` blocks
requests that resolve to loopback, private (RFC1918), link-local (including the
`169.254.169.254` cloud-metadata endpoint), and other reserved address space — wired in
as the DNS `lookup` on every outbound request, plus an explicit numeric-IP check (Node
skips `lookup` for IP literals). The `/asset` proxy additionally refuses to relay
`text/html`, so it can't be turned into a generic web proxy.

## How the shredding works

The algorithm was reverse-engineered from the original engine's live output
(`shred_v1_3521.php`) — the same page shredded under multiple fixed seeds, varied
pages to expose caps and edge cases, plus archived Perl-era (`shred.pl`) outputs from
the Wayback Machine. Verified rules:

1. **The raw HTTP response is the material.** Every redirect hop's status line and
   headers, then the full HTML source — escaped so the markup itself becomes visible
   texture. There is no length cap in the original (a 2MB page goes in whole).
2. **Text**: the material is chopped into exactly **12 equal chunks**, each placed in
   a 60px-wide, 800px-tall layer cascading diagonally in 20px steps (`left = top =
   i×20`). Chunks render as 10px Arial, except **exactly one random strip per shred**
   gets **94px type squeezed onto 27px line-height** — the signature towers of
   overlapping glyphs (70pt/20pt in the 1998 Perl version).
3. **Colors are harvested from `<style>` blocks _and the page's external
   stylesheets_** (each `<link rel=stylesheet>` is fetched and scanned) — 3/6-digit
   `#hex` only, in document order, duplicates kept. Inline `style=""` attributes,
   `bgcolor=` attributes and `<script>` are ignored. This is why modern sites yield
   hundreds-to-thousands of swatches (github ~7740, discord 3754). They become the
   per-chunk text colors and the labeled `Color=#xxx` swatch stack (left 40, stepping
   10px). When a page declares none, every strip falls back
   to `#c0c0c0` silver.
4. **Images**: one layer per `<img>`, in document order — squeezed into a thin
   stretched sliver (20–50px × 420px) or tiled as the background of a 200px column,
   coin flip. One extra image is blown up 220×420 in the foreground (`left = top +
   300`, exactly), and one smeared behind everything (`top = 20`, `height = width/2 +
   200`, `clip:rect(20px w h 30px)`, exactly).
5. **Links**: one live fragment per `<a href>` in document order (left 10, width 400,
   random top 50–450); the visible text is the resolved URL itself, and clicking one
   re-shreds its target.
6. **Form fields float in the columns**: the page's own `<input>` elements are
   scattered after the text chunks, one per strip — a Perl-1.0 behavior the PHP
   version dropped (rebuilt here from a safe attribute whitelist).
7. **mp4s** get a 700×700 clipped window onto the playing video.
8. **Framesets recurse**: each `<frame>` is fetched and shredded onto the same canvas
   as another full section.
9. **The page's own `<body bgcolor>`** becomes the canvas background (else `#fff`).
10. Randomness is **seeded** (`?srand=`, default = unix time, like the original): a
    permalink reproduces the same composition (modulo volatile headers like `Date:`,
    which genuinely change — the material is the live response).

The whole composition sits on a 2000×4000px canvas scaled to `windowWidth / 800`,
exactly like the original output shell, with the original's CSS classes
(`smalltext` / `verylargetext` / `monospacetext`) verbatim.

## Tests

The original engine's output _embeds the exact source it shredded_ (its text strips
are the escaped page HTML), so the mapping from page to shred is verifiable. The suite
reconstructs the input from each captured shred and requires our harvesters to produce
the same colors/images/links/videos the original did — deterministically, no fetch skew.

```
npm test
```

Ground truth is **54 real pages** captured from the original engine: 16 classic (net.art
+ a few majors) and 38 current most-visited (incl. Google, YouTube, OpenAI, Anthropic,
GitHub, Discord…). Both corpora pass with **0 rule failures**; every remaining divergence
is documented as fetch-skew or an edge case rather than hidden. See [`test/README.md`](test/README.md).

## Layout

- `server.js` — static file server + `/shred` + `/asset` (image/CSS proxy so
  hotlink-protected assets still render; the original hotlinked directly)
- `lib/fetchPage.js` — raw HTTP fetch matching the original's User-Agent, following
  redirects, decompressing gzip/brotli, preserving status line + header order
- `lib/shredder.js` — the shred engine
- `lib/ssrf.js` — SSRF guard (blocks private/loopback/link-local targets) for the proxy
- `api/` — Vercel serverless functions (`/shred`, `/asset`); `public/` — the toolbar UI
- `test/` — the parity suite and captured fixtures

This is an independent homage built for study; all credit for the concept and the
original work belongs to Mark Napier.
