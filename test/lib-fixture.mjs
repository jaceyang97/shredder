// Parses a ground-truth fixture (an original potatoland Shredder output) into
// structured layers, and reconstructs the exact input the original engine saw
// — its text strips carry the full escaped source, so the fixture doubles as
// a snapshot of the page at shred time. That reconstruction is what makes
// parity testing 100% deterministic: both engines harvest the same bytes.

function unescapeHtml(s) {
  return s.replace(/&(amp|lt|gt|quot);/g, (_, e) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"' }[e]));
}

/** Split a fixture into sections (framesets produce several). */
export function parseFixture(html) {
  const sections = [];
  const marks = [...html.matchAll(/<!-{2,}\s*Start Shred:\s*(.*?)\s*-{2,}>/g)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : html.length;
    sections.push(parseSection(html.slice(start, end), marks[i][1]));
  }
  const seedM = /[?&]srand=(\d+)/.exec(html);
  const bgM = /document\.body\.style\.backgroundColor = '([^']*)'/.exec(html);
  const titleM = /setShredderTitle\('([\s\S]*?)'\); setShredderLocation/.exec(html);
  return {
    sections,
    seed: seedM ? Number(seedM[1]) : null,
    bodyBg: bgM ? bgM[1] : null,
    title: titleM ? titleM[1] : null,
  };
}

function parseSection(sec, requestedUrl) {
  const out = { requestedUrl, textLayers: [], imgLayers: [], linkLayers: [], colorLayers: [], vidLayers: [], fgImg: null, bgLayer: null };

  const outM = /<!-{2,}\s*Output Shred:\s*(.*?)\s*-{2,}>/.exec(sec);
  out.finalUrl = outM ? outM[1] : null;

  const textM = /<!-{2,}\s*Text \((\d+)\)\s*-{2,}>/.exec(sec);
  out.textTotal = textM ? Number(textM[1]) : null;

  // text strips: <div id="LyrN" style="...left:Lpx; top:Tpx..."><p class='CLS' style='color:C'> CHUNK </p>
  const lyrRe = /<div id="Lyr(\d+)" style="position:absolute; left:(\d+)px; top:(\d+)px;[^"]*">\s*<p class='(\w+)' style='color:([^']*)'>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = lyrRe.exec(sec))) {
    let chunk = m[6];
    // the engine pads the chunk with exactly one space on each side
    if (chunk.startsWith(' ')) chunk = chunk.slice(1);
    if (chunk.endsWith(' ')) chunk = chunk.slice(0, -1);
    out.textLayers.push({ idx: +m[1], left: +m[2], top: +m[3], cls: m[4], color: m[5], chunk });
  }

  // BG layer
  const bgRe = /<div id='BGLyr' style='position:absolute; left:(\d+)px; top:(\d+)px; width:(\d+)px; height:(\d+)px; background-image:url\(([^)]*)\); clip:rect\(([^)]*)\)/.exec(sec);
  if (bgRe) out.bgLayer = { left: +bgRe[1], top: +bgRe[2], width: +bgRe[3], height: +bgRe[4], img: bgRe[5], clip: bgRe[6] };

  // Fg image
  const fgRe = /<div id="FlkLyr(\d+)" style="position:absolute; left:(\d+)px; top:(\d+)px; width:(\d+)px; height:(\d+)px;[^"]*">\s*<img src='([^']*)'/.exec(sec);
  if (fgRe) out.fgImg = { left: +fgRe[2], top: +fgRe[3], width: +fgRe[4], height: +fgRe[5], img: fgRe[6] };

  // image strips: tiled (background-image) or stretched (inner img)
  const imgRe = /<div id="ImgLyr(\d+)" style="position:absolute; left:(\d+)px; top:(\d+)px; width:(\d+)px; height:(\d+)px;(?: background-image:url\(([^)]*)\);)? z-index:\d+">(?:\s*<img src='([^']*)')?/g;
  while ((m = imgRe.exec(sec))) {
    out.imgLayers.push({
      idx: +m[1], left: +m[2], top: +m[3], width: +m[4], height: +m[5],
      mode: m[6] ? 'tiled' : 'stretched',
      img: m[6] || m[7] || '',
    });
  }

  // video layers
  const vidRe = /<div id='VidLyr(\d+)' style='position:absolute; left:(\d+)px; top:(\d+)px; width:(\d+)px; height:(\d+)px;[^']*'>\s*<video[^>]*>\s*<source src='([^']*)'/g;
  while ((m = vidRe.exec(sec))) {
    out.vidLayers.push({ idx: +m[1], left: +m[2], top: +m[3], width: +m[4], height: +m[5], src: m[6] });
  }

  // link layers
  const lnkRe = /<div id="LnkLyr(\d+)" style="position:absolute; left:(\d+)px; top:(\d+)px; width:(\d+)px; height:(\d+)px; z-index:\d+">\s*<A HREF='([^']*)'/g;
  while ((m = lnkRe.exec(sec))) {
    out.linkLayers.push({ idx: +m[1], left: +m[2], top: +m[3], width: +m[4], height: +m[5], href: m[6] });
  }

  // color swatches
  const clrRe = /<div id="ClrLyr(\d+)" style="position:absolute; left:(\d+)px; top:(\d+)px; height:(\d+)px; background-color:([^;]*); z-index:\d+">/g;
  while ((m = clrRe.exec(sec))) {
    out.colorLayers.push({ idx: +m[1], left: +m[2], top: +m[3], height: +m[4], color: m[5] });
  }

  // raw <form>/<input> markup evidence (escaped source can't produce these)
  out.formTags = (sec.match(/<form\b/gi) || []).length;
  out.inputTags = (sec.match(/<input\b/gi) || []).length;

  return out;
}

/**
 * Reconstruct what the original engine fetched, from its own text strips:
 * material = hop headers (raw) + blank line + escaped source.
 * Returns { material, hops, source } where source is the UNESCAPED page HTML.
 */
export function reconstructInput(section) {
  const material = section.textLayers
    .sort((a, b) => a.idx - b.idx)
    .map((l) => l.chunk)
    .join('');

  let rest = material;
  const hops = [];
  while (/^HTTP\//.test(rest)) {
    const sep = /\r?\n\r?\n/.exec(rest);
    if (!sep) break;
    hops.push(rest.slice(0, sep.index));
    rest = rest.slice(sep.index + sep[0].length);
  }
  return { material, hops, source: unescapeHtml(rest) };
}
