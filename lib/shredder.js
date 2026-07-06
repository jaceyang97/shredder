// The shred engine — a reimplementation of the algorithm behind Mark Napier's
// Shredder 1.1 (potatoland.org/shredder), reverse-engineered from its live
// output (same page shredded under multiple seeds, plus varied pages).
//
// The raw HTTP response is the material: every redirect hop's status line and
// headers, then the escaped HTML source. It is chopped into exactly 12
// diagonal strips; the page's images are squeezed into thin slivers or tiled
// columns (one per <img>, in document order); its links become clickable
// fragments; colors found in <style> blocks are harvested (duplicates kept)
// as both the text palette and a stack of labeled swatches. Framesets recurse:
// each frame is fetched and shredded into the same canvas.
//
// Verified rules from the original:
//   - text: 12 layers, left = top = i*20, w60 h800, z=i, chunk = total/12
//   - exactly ONE strip per shred is 94px 'verylargetext'
//   - text color per chunk from harvested pool; '#c0c0c0' when pool is empty
//   - BGLyr: iff images exist; top=20, height = width/2 + 200,
//     clip:rect(20px {w}px {h}px 30px)
//   - FgImg: one, 220x420, left = top + 300
//   - ImgLyr: one per <img>, doc order; w=rand(20..50); tiled h=200 /
//     stretched h=420, coin flip
//   - LnkLyr: one per <a href>, doc order, left=10 w=400 h=10, top=rand(50..450)
//   - VidLyr: one per mp4, 700x700 clipped window onto the playing video
//   - ClrLyr: left=40, top=i*10, h=20, doc order, dupes kept
//   - body background = <body bgcolor> verbatim, else #fff
//   - default seed = unix time; same seed reproduces the layout

// ---- constants ------------------------------------------------------------
const TEXT_LAYERS = 12;
// Chunk over the FULL material (the original has no cap — wired.com's 2M chars
// go in whole, so each strip samples a different region of the document), but
// cap what each strip EMITS: the canvas clips at 4000px, which a 60px-wide
// column exhausts in well under 8000 chars. Identical pixels, sane DOM.
const CHUNK_RENDER_CAP = 8000;
const STRIP_STEP = 20;
const STRIP_W = 60;
const STRIP_H = 800;
const CANVAS_W = 2000;
const CANVAS_H = 4000;
// Sanity ceilings only — far above anything the original demonstrated
// (32 imgs / 162 links / 55 colors / 28 videos observed uncapped).
const MAX_IMG_LAYERS = 300;
const MAX_LINK_LAYERS = 2000;
const MAX_COLOR_LAYERS = 12000; // github alone yields ~7740 from its stylesheets
const MAX_VIDEO_LAYERS = 400;
const MAX_FRAMES = 8;           // frameset recursion budget
const MONOSPACE_CHANCE = 0.05;
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function jsString(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ').replace(/<\//g, '<\\/');
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function randInt(rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

// ---- harvesting -----------------------------------------------------------

export function harvestTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  // The original takes the raw <title> content verbatim — NOT trimmed, NOT
  // whitespace-collapsed (microsoft's title keeps its literal newline+indent),
  // CRLF normalized to LF, with basic HTML entities decoded ("&amp;" -> "&").
  return m ? decodeEntities(m[1].replace(/\r\n/g, '\n')) : '';
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

export function harvestBodyBg(html) {
  const m = /<body[^>]*\bbgcolor\s*=\s*["']?([^"'\s>]+)/i.exec(html);
  return m ? m[1] : '#fff';
}

// Colors are harvested ONLY from <style> element content — NOT inline style=""
// attributes, NOT bgcolor=/text= markup attributes, NOT <script> strings.
// Verified against 16 real pages: e.g. wired's 57 colors are exactly its
// <style>-block colors (its 43 CSS-custom-property colors live in <script> and
// are excluded); sito's inline style="color:#000" attribute colors are dropped.
// Document order, duplicates kept. Any run of >=3 hex digits after '#' (so 3/4/6/8
// -digit CSS colors all survive — the previous {3,6} form silently dropped rgba
// hex, which is the "missing colors" bug on modern sites).
export function inlineStyleCss(html) {
  let css = '';
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) css += m[1] + '\n';
  return css;
}

export function stylesheetLinks(html, baseUrl) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/stylesheet/i.test(tag) && !/\.css\b/i.test(tag)) continue;
    const hm = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!hm) continue;
    const href = (hm[1] ?? hm[2] ?? hm[3] ?? '').trim();
    const abs = naiveResolve(href, baseUrl);
    if (/^https?:/i.test(abs)) out.push(abs);
  }
  return out;
}

// Harvest colors from a CSS string: `#hex` matched as EXACTLY 3 or 6 digits
// (word-boundary — a 4/5/7/8-digit run like `#00000073` rgba is skipped
// entirely, verified against netflix/reddit). Document order, dupes kept. The
// caller passes inline <style> content + fetched external stylesheet text — NOT
// inline style="" attributes (sito proves those are excluded) and NOT <script>
// (wired proves that).
export function harvestColors(css) {
  const out = [];
  const re = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
  let m;
  while ((m = re.exec(css)) && out.length < MAX_COLOR_LAYERS) {
    out.push('#' + m[1]);
  }
  return out;
}

// The original engine mixes two hardcoded default colors into the text-strip
// color pool (never emitted as swatches): grey #c0c0c0 and green #20f040.
export const DEFAULT_TEXT_COLORS = ['#c0c0c0', '#20f040'];

// The original resolves references by naive concatenation against the final
// URL's directory — no normalization ('../' stays visible), and anything that
// isn't absolute http(s) gets glued too (even 'mailto:...', verified in its
// output). The /asset proxy normalizes dot-segments when it actually fetches,
// so the quirk costs nothing functionally.
// Reject strings that are JS template fragments or otherwise can't be real
// URLs (they leak in when an <img>/<a>/mp4 pattern matches inside a <script>).
function isJunkUrl(u) {
  // note: backslash is allowed — wired's .mp4 URLs are JSON-escaped (/)
  return !u || /[`{}<>]|\$\{|\s/.test(u);
}

export function naiveResolve(ref, baseUrl) {
  const r = (ref || '').trim();
  if (/^https?:\/\//i.test(r)) return r;
  try {
    const b = new URL(baseUrl);
    if (r.startsWith('//')) return b.protocol + r;
    if (r.startsWith('/')) return b.origin + r;
    const dir = b.origin + b.pathname.replace(/[^/]*$/, '');
    return dir + r;
  } catch {
    return r;
  }
}

// The original harvests <img>/<a>/<input> tags from the RENDERED markup, not
// from script source or comments — so strip those first (verified: cnn/duckduckgo
// shed their script-embedded links, classic pages unchanged). Videos are NOT
// stripped: the original does pull .mp4 URLs out of JSON in <script> (wired).
export function stripScriptsComments(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

// Harvest <img> tags by their `src` attribute — but `src` must be a
// WHITESPACE-DELIMITED word, so `data-src=`/`srcset=` (lazy-load placeholders)
// don't false-match. data: URIs are skipped. Verified exact on 7 classic pages
// (graffiti 7, sito 15, wikipedia 20, textfiles 6, berkshire 1, gallery1 24…).
// Duplicates kept, document order.
export function harvestImages(html, baseUrl) {
  const out = [];
  const re = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html)) && out.length < MAX_IMG_LAYERS) {
    const src = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!src || src.startsWith('data:') || isJunkUrl(src)) continue;
    out.push(naiveResolve(src, baseUrl)); // duplicates kept, document order
  }
  return out;
}

// The original harvests videos by scanning for '.mp4' URL substrings anywhere
// in the source (quoted or after '='), not just <video>/<source> tags — this
// is how it pulls 28 clips out of wired's JSON-embedded player data. Each
// occurrence becomes a layer (duplicates kept, document order).
export function harvestVideos(html, baseUrl) {
  const out = [];
  // one URL per '.mp4' occurrence; stop the tail at a comma/quote so a
  // "...mp4,...webm" srcset doesn't get glued into one bogus URL
  const re = /(?:"|'|=)([^\s"'>(){}$,]+\.mp4[^\s"'>(){},]*)/gi;
  let m;
  while ((m = re.exec(html)) && out.length < MAX_VIDEO_LAYERS) {
    const u = decodeEntities(m[1].trim());
    if (!isJunkUrl(u)) out.push(naiveResolve(u, baseUrl));
  }
  return out;
}

export function harvestLinks(html, baseUrl) {
  const out = [];
  const re = /<a[^>]+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html)) && out.length < MAX_LINK_LAYERS) {
    const href = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    // empty and pure-fragment ('#...') hrefs are dropped; everything else
    // (including mailto:/javascript:) is glued to the base like the original
    if (!href || href.startsWith('#') || isJunkUrl(href)) continue;
    out.push(naiveResolve(href, baseUrl)); // duplicates kept, document order
  }
  return out;
}

// The Perl-era shredder floated the page's own form fields through the text
// columns — one <form><input></form> after each chunk while any remain.
// Inputs are rebuilt from a safe attribute whitelist, not copied verbatim.
export function harvestInputs(html) {
  const out = [];
  const re = /<input\b[^>]*>/gi;
  const attrRe = /(type|name|value|placeholder|size|checked)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    const attrs = [];
    let am;
    attrRe.lastIndex = 0;
    while ((am = attrRe.exec(m[0]))) {
      const name = am[1].toLowerCase();
      const val = (am[2] ?? am[3] ?? am[4] ?? '').slice(0, 100);
      if (name === 'type' && /^(submit|button|image|file|password)$/i.test(val)) {
        attrs.length = 0;
        attrs.push('type="text"');
        continue;
      }
      attrs.push(`${name}="${escapeAttr(val)}"`);
    }
    out.push(`<input ${attrs.join(' ')}>`);
  }
  return out;
}

function harvestFrames(html, baseUrl) {
  if (!/<frameset[\s>]/i.test(html)) return [];
  const out = [];
  const re = /<frame[^>]+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html)) && out.length < MAX_FRAMES) {
    const src = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    const abs = resolveUrl(src, baseUrl);
    if (abs && /^https?:/.test(abs)) out.push(abs);
  }
  return out;
}

// ---- composition ----------------------------------------------------------

/**
 * Shred one fetched page into layer markup. Returns the section's HTML.
 * Layer ids restart per section, matching the original's frameset output.
 */
function shredSection(page, rand, asset, requestedUrl, isRoot, palette) {
  const finalUrl = page.finalUrl;
  const html = page.body || '';

  const title = harvestTitle(html);
  const bodyBg = harvestBodyBg(html);
  // palette is precomputed by the caller from inline <style> + fetched external
  // stylesheets; fall back to inline-only if not provided (e.g. frame sections)
  if (!palette) palette = harvestColors(inlineStyleCss(html));
  const textPalette = palette.length ? palette : ['#c0c0c0'];
  // images/links/inputs come from the rendered markup (scripts & comments
  // stripped); videos scan the full source (mp4 URLs live in <script> JSON)
  const clean = stripScriptsComments(html);
  const images = harvestImages(clean, finalUrl);
  const videos = harvestVideos(html, finalUrl);
  const links = harvestLinks(clean, finalUrl);
  const inputs = harvestInputs(clean);

  // material: every hop's status line + headers (bodies of redirects are
  // dropped), blank line, then the escaped source
  const hopTexts = page.hops.map((hop) => {
    const lines = [];
    for (let i = 0; i < hop.rawHeaders.length; i += 2) {
      lines.push(`${hop.rawHeaders[i]}: ${hop.rawHeaders[i + 1]}`);
    }
    return `${hop.statusLine}\n${lines.join('\n')}`;
  });
  const material = escapeHtml(`${hopTexts.join('\n\n')}\n\n${html}`);
  const textTotal = material.length;
  // The original chops with chunkLen = floor(N/12) and a stride of chunkLen+1
  // — one source char is skipped at each of the 11 strip boundaries (a genuine
  // off-by-one in the 1998 engine). The Text(N) label is still the full length.
  const chunkLen = Math.floor(textTotal / TEXT_LAYERS) || 1;
  const stride = chunkLen + 1;

  const parts = [];
  const push = (s) => parts.push(s);

  push(`<!-------- Start Shred: ${escapeHtml(requestedUrl)} -------->\n`);
  push(`<!-------- Output Shred: ${escapeHtml(finalUrl)} -------->\n`);
  if (isRoot) {
    push(`<SCRIPT>document.body.style.backgroundColor = '${jsString(bodyBg)}';</SCRIPT>\n`);
    push(`<SCRIPT>setShredderTitle('${jsString(title)}'); setShredderLocation('${jsString(finalUrl)}');</SCRIPT>\n`);
  }

  // -- Background: iff the image pool is non-empty; one pool image, smeared
  push(`<!-------- Background -------->\n`);
  if (images.length) {
    const img = pick(rand, images);
    const left = randInt(rand, 100, 290);
    const w = randInt(rand, 416, 590);
    const h = Math.round(w / 2) + 200;
    push(`<div id='BGLyr' style='position:absolute; left:${left}px; top:20px; width:${w}px; height:${h}px; background-image:url(${escapeAttr(asset(img))}); clip:rect(20px ${w}px ${h}px 30px); z-index:0'>\n</div>\n\n`);
  }

  // -- Text: 12 diagonal strips; exactly one goes 94px
  push(`<!-------- Text (${textTotal}) -------->\n`);
  const veryLargeIdx = randInt(rand, 0, TEXT_LAYERS - 1);
  for (let i = 0; i < TEXT_LAYERS; i++) {
    // slice from the FULL material with the original's floor+stride chunking;
    // emit only what the 4000px canvas can show
    const chunk = material.slice(i * stride, i * stride + chunkLen).slice(0, CHUNK_RENDER_CAP);
    const cls = i === veryLargeIdx ? 'verylargetext'
      : rand() < MONOSPACE_CHANCE ? 'monospacetext'
      : 'smalltext';
    const color = textPalette.length === 1 ? textPalette[0] : pick(rand, textPalette);
    push(`<div id="Lyr${i}" style="position:absolute; left:${i * STRIP_STEP}px; top:${i * STRIP_STEP}px; width:${STRIP_W}px; height:${STRIP_H}px; z-index:${i}">\n`);
    const stray = inputs[i] ? `<form>${inputs[i]}</form> ` : ' ';
    push(`<p class='${cls}' style='color:${escapeAttr(color)}'> ${chunk} </p>\n<p> ${stray}</p>\n</div>\n\n`);
  }

  let z = TEXT_LAYERS;

  // -- Fg Img: one pool image blown up 220x420; left is derived from top
  push(`<!-------- Fg Img -------->\n`);
  if (images.length) {
    const img = pick(rand, images);
    const top = randInt(rand, 150, 250);
    const left = top + 300;
    push(`<div id="FlkLyr${z}" style="position:absolute; left:${left}px; top:${top}px; width:220px; height:420px; z-index:${z}">\n`);
    push(`<img src='${escapeAttr(asset(img))}' style='width:100%; height:100%'>\n</div>\n\n`);
  }

  // -- mp4s: a 700x700 clipped window onto each playing video
  push(`<!-------- mp4s -------->\n`);
  for (const v of videos) {
    const left = randInt(rand, 0, 500);
    const top = randInt(rand, 0, 60);
    const clipL = randInt(rand, 0, 260);
    const clipR = clipL + randInt(rand, 20, 280);
    push(`<div id='VidLyr${z}' style='position:absolute; left:${left}px; top:${top}px; width:700px; height:700px; overflow:hidden; clip:rect(0px ${clipR}px 700px ${clipL}px); z-index:${z};'>`);
    push(`<video id='video1' controls autoplay loop muted playsinline style='height:100%'><source src='${escapeAttr(asset(v))}' type='video/mp4'></video></div>\n\n`);
    z++;
  }

  // -- Images: one thin sliver or tiling column per <img>, document order
  push(`<!-------- Images -------->\n`);
  for (const img of images) {
    const left = randInt(rand, 0, 495);
    const top = randInt(rand, 0, 300);
    const w = randInt(rand, 20, 50);
    if (rand() < 0.5) {
      push(`<div id="ImgLyr${z}" style="position:absolute; left:${left}px; top:${top}px; width:${w}px; height:200px; background-image:url(${escapeAttr(asset(img))}); z-index:${z}">\n</div>\n\n`);
    } else {
      push(`<div id="ImgLyr${z}" style="position:absolute; left:${left}px; top:${top}px; width:${w}px; height:420px; z-index:${z}">\n`);
      push(`<img src='${escapeAttr(asset(img))}' style='width:100%; height:100%'>\n</div>\n\n`);
    }
    z++;
  }

  // -- Links: live fragments; clicking one shreds its target
  push(`<!-------- Links -------->\n`);
  links.forEach((href, i) => {
    const top = randInt(rand, 50, 450);
    const zi = 100 + i;
    push(`<div id="LnkLyr${zi}" style="position:absolute; left:10px; top:${top}px; width:400px; height:10px; z-index:${zi}">\n`);
    push(`<A HREF='${escapeAttr(href)}' onClick='shred("${jsString(href)}");return false;'>${escapeHtml(href)}</A><P>\n</div>\n\n`);
  });

  // -- colors: the harvested palette, stacked as labeled swatch bars
  push(`<!-------- colors -------->\n`);
  palette.forEach((c, i) => {
    const zi = 400 + i;
    push(`<div id="ClrLyr${zi}" style="position:absolute; left:40px; top:${i * 10}px; height:20px; background-color:${escapeAttr(c)}; z-index:${zi}">\nColor=${escapeHtml(c)}<P>\n</div>\n\n`);
  });

  return parts.join('');
}

/**
 * Build the full shredded document. Framesets recurse: every frame is
 * fetched and shredded as another section on the same canvas.
 * @param {object} page      result of fetchPage()
 * @param {object} opts      { requestedUrl, seed, proxyAssets, fetchPage, fetchStylesheet }
 */
export async function shred(page, opts) {
  const seed = opts.seed >>> 0;
  const rand = mulberry32(seed);
  const asset = (u) =>
    opts.proxyAssets ? `/asset?u=${encodeURIComponent(u)}&ref=${encodeURIComponent(page.finalUrl)}` : u;

  // Colors: inline <style> content + the text of external stylesheets the page
  // links (fetched in parallel, capped for latency). This is what gives modern
  // sites their dense color-swatch columns — their palette lives in .css files.
  const palette = await gatherPalette(page, opts);

  const sections = [shredSection(page, rand, asset, opts.requestedUrl, true, palette)];

  // frameset recursion (depth 2, budgeted)
  if (opts.fetchPage) {
    let budget = MAX_FRAMES;
    const queue = harvestFrames(page.body || '', page.finalUrl).map((u) => ({ url: u, depth: 1 }));
    while (queue.length && budget > 0) {
      const { url, depth } = queue.shift();
      budget--;
      try {
        const sub = await opts.fetchPage(url);
        sections.push(shredSection(sub, rand, asset, url, false));
        if (depth < 2) {
          for (const f of harvestFrames(sub.body || '', sub.finalUrl)) {
            queue.push({ url: f, depth: depth + 1 });
          }
        }
      } catch {
        // a frame that won't load just isn't part of the composition
      }
    }
  }

  const permaQuery = `url=${encodeURIComponent(opts.requestedUrl)}&srand=${seed}&frame=n`;
  const permalink = `<div class='permalink'><a href='/shred?${permaQuery}' title='Permalink Shredder ${escapeAttr(opts.requestedUrl)}'>Shredder 1.1</a></div>`;

  return wrapDocument(sections.join('') + permalink, { canvasW: CANVAS_W, canvasH: CANVAS_H });
}

// How many external stylesheets to fetch and their total budget. github links
// 35 sheets; fetching them all would blow the serverless timeout, so we cap —
// partial CSS still yields a rich palette, just not a byte-exact count.
const MAX_STYLESHEETS = 10;

export async function gatherPalette(page, opts) {
  const html = page.body || '';
  let css = inlineStyleCss(html);
  if (opts.fetchStylesheet) {
    const links = stylesheetLinks(html, page.finalUrl).slice(0, MAX_STYLESHEETS);
    const sheets = await Promise.all(links.map((u) => opts.fetchStylesheet(u, page.finalUrl).catch(() => '')));
    css += '\n' + sheets.join('\n');
  }
  return harvestColors(css);
}

export function shredErrorPage(message) {
  return wrapDocument(
    `<div style='margin-left: 10px;'>\n<h3>Error: ${escapeHtml(message || '')} &nbsp;:(</h3>\n<p><a href='javascript:history.back()'>&lt; BACK</a></p>\n</div>`,
    { bare: true }
  );
}

// The wrapper document: CSS matching the original output shell — the three
// text treatments and the oversized scaled canvas are what give shreds
// their look.
function wrapDocument(inner, { canvasW = 2000, canvasH = 4000, bare = false } = {}) {
  const body = bare
    ? `<body>${inner}\n<script>if(parent.Stoolbar){parent.Stoolbar.pageLoaded();}</script>\n</body>`
    : `<body><div id='shredder-out'>\n<script>\tsetShredderScale(); </script>\n${inner}</div>\n\t<script>\n\t\tif (parent.Stoolbar) { parent.Stoolbar.pageLoaded(); }\n\t</script>\n\t</body>`;

  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">
<html>
<head>
<meta name="robots" content="noindex">
<title>Shredder 1.1</title>
<script>
	function shred(url) {
		if (parent.Stoolbar) {
			parent.Stoolbar.loadPage(url);
		}
		else {
			document.location.href='/shred?url=' + encodeURIComponent(url) + '&frame=n';
		}
	}
	function setShredderTitle(title) {
		document.title='Shredder 1.1: ' + title;
	}
	function setShredderScale() {
		var width = window.innerWidth || document.body.clientWidth;
		var scale = width/800;
		var el = document.getElementById('shredder-out');
		el.style.transformOrigin = 'left top';
		el.style.transform = 'scale(' + scale + ')';
	}
	function setShredderLocation(url) {
		if (parent.Stoolbar && parent.Stoolbar.setLocationValue) {
			parent.Stoolbar.setLocationValue(url);
		}
	}
</script>
<style>
	html, body {
		height: 100%;
		width: 100%;
	}
	body {
		margin: 0;
		padding: 0;
		background-color: #fefefe;
	}
	.verylargetext {
		letter-spacing: 6px;
		font-size: 94px;
		line-height: 27px;
	}
	.monospacetext {
		font-size: 18px;
		font-family: "Courier New", Courier, monospace;
	}
	.smalltext {
		font-family: 'arial';
		font-size: 10px;
		line-height: 1.2;
		margin-top: 0;
	}
	.permalink {
		position: absolute;
		left: 700px;
		top: 0px;
	}
	.permalink a {
		font-family: 'arial';
		font-size: 8px;
		text-decoration: none;
		color: #ccc;
	}
	.permalink a:hover {
		text-decoration: underline;
		color: #ccc;
	}
	#shredder-out {
		position: relative;
		margin: 2px 0px 0px 2px;
		width: ${canvasW}px;
		height: ${canvasH}px;
		overflow: hidden;
	}
</style>
</head>
${body}</html>
`;
}
