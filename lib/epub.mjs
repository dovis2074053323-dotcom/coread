import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export function smartSplit(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n[\t 　]*\n+/);
  const result = [];

  for (const block of blocks) {
    const rawLines = block.split('\n').filter(line => line.trim());
    if (rawLines.length === 0) continue;
    if (rawLines.length === 1) {
      result.push(rawLines[0].trim());
      continue;
    }

    const lines = rawLines.map(raw => ({
      raw,
      text: raw.trim().replace(/^[　]+/, ''),
      indented: /^(?:[　]{1,2}| {2,}|\t)/.test(raw),
    }));
    const contentLines = lines.filter(line => !isStructuralLine(line.text));
    const lengths = contentLines.map(line => line.text.length).sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)] || 0;
    const comparable = contentLines.slice(0, -1);
    const fixedWidthRatio = comparable.length === 0 ? 0 : comparable.filter(line =>
      line.text.length >= median * 0.7 && line.text.length <= median * 1.18
    ).length / comparable.length;
    const terminalRatio = contentLines.length === 0 ? 0 : contentLines.filter(line => endsParagraph(line.text)).length / contentLines.length;
    const hasStructure = lines.some(line => line.indented || isStructuralLine(line.text));
    const likelyVerse = !hasStructure && lines.length >= 3 && median <= 20 && terminalRatio < 0.35;
    const likelySoftWrapped = !hasStructure && lines.length >= 3 && median >= 24
      && fixedWidthRatio >= 0.7 && terminalRatio < 0.45;

    if (likelyVerse) {
      result.push(lines.map(line => line.text).join('\n'));
      continue;
    }
    if (likelySoftWrapped) {
      result.push(joinSoftLines(lines.map(line => line.text)));
      continue;
    }

    let paragraphLines = [];
    const flush = () => {
      if (paragraphLines.length) result.push(joinSoftLines(paragraphLines));
      paragraphLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = lines[i + 1];
      if (isStructuralLine(line.text)) {
        flush();
        result.push(line.text);
        continue;
      }
      if (line.indented) flush();
      paragraphLines.push(line.text);

      const nextStartsParagraph = !!next && (next.indented || isStructuralLine(next.text));
      const shortStandalone = line.text.length <= 24 && !!next && next.text.length >= line.text.length * 2
        && !/[，、,:：]$/.test(line.text);
      if (!next || nextStartsParagraph || endsParagraph(line.text) || shortStandalone) flush();
    }
    flush();
  }

  return result.map(p => p.trim()).filter(Boolean);
}

function isStructuralLine(text) {
  return /^(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)、]\s*|```|~~~)/.test(text)
    || /^第[\d一二三四五六七八九十百千万]+[章节回部篇卷]/.test(text);
}

function endsParagraph(text) {
  return /(?:[。！？!?；;]|\.{2,}|…{1,2})[”’」』）】\])》〉]?\s*$/.test(text);
}

function joinSoftLines(lines) {
  let joined = '';
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    if (!joined) { joined = text; continue; }
    const previous = joined[joined.length - 1];
    const first = text[0];
    const cjkBoundary = /[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]/.test(previous)
      || /[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]/.test(first);
    joined += cjkBoundary || /[-—/]$/.test(previous) ? text : ` ${text}`;
  }
  return joined;
}

export function parseEpub(base64Data) {
  const AdmZip = require('adm-zip');
  const buf = Buffer.from(base64Data, 'base64');
  const zip = new AdmZip(buf);

  const containerXml = zip.readAsText('META-INF/container.xml') || '';
  const opfMatch = containerXml.match(/full-path="([^"]+)"/);
  const opfPath = opfMatch ? opfMatch[1] : '';
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const epubImageMap = new Map();
  const imageEntries = zip.getEntries().filter(e => /\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(e.entryName));
  for (const entry of imageEntries) {
    const fname = entry.entryName.split('/').pop();
    if (fname) epubImageMap.set(entry.entryName, fname);
  }

  const opfXml = opfPath ? zip.readAsText(opfPath) || '' : '';

  const manifest = {};
  const manifestRe = /<item\s([^>]*)\/?\s*>/g;
  let m;
  while ((m = manifestRe.exec(opfXml)) !== null) {
    const attrs = m[1];
    const id = (attrs.match(/id="([^"]*)"/)||[])[1];
    const href = (attrs.match(/href="([^"]*)"/)||[])[1];
    const type = (attrs.match(/media-type="([^"]*)"/)||[])[1];
    if (id && href && type) manifest[id] = { href, type };
  }

  const spineRefs = [];
  const spineRe = /<itemref\s[^>]*idref="([^"]*)"/g;
  while ((m = spineRe.exec(opfXml)) !== null) spineRefs.push(m[1]);

  const tocPageIds = new Set();
  const guideRe = /<reference\s[^>]*type="toc"[^>]*href="([^"]*)"/gi;
  while ((m = guideRe.exec(opfXml)) !== null) {
    const tocHref = m[1].split('#')[0];
    const tocId = Object.entries(manifest).find(([_, v]) => v.href === tocHref || decodeURIComponent(v.href) === tocHref);
    if (tocId) tocPageIds.add(tocId[0]);
  }
  for (const [id] of Object.entries(manifest)) {
    const attrs = opfXml.match(new RegExp(`<item[^>]*id="${id}"[^>]*`));
    if (attrs && /properties\s*=\s*"[^"]*nav[^"]*"/.test(attrs[0])) tocPageIds.add(id);
  }

  let epubCoverFile = null;
  const coverMeta = opfXml.match(/<meta\s[^>]*name="cover"[^>]*content="([^"]*)"/);
  if (coverMeta) {
    const coverId = coverMeta[1];
    const coverItem = manifest[coverId];
    if (coverItem && /image/i.test(coverItem.type)) {
      epubCoverFile = opfDir + decodeURIComponent(coverItem.href);
    }
  }
  if (!epubCoverFile) {
    const coverItem = Object.entries(manifest).find(([id, item]) => /cover/i.test(id) && /image/i.test(item.type));
    if (coverItem) epubCoverFile = opfDir + decodeURIComponent(coverItem[1].href);
  }

  const tocChapters = [];
  const ncxItem = Object.values(manifest).find(x => x.type === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const ncxXml = zip.readAsText(opfDir + ncxItem.href) || '';
    const navRe = /<navPoint[^>]*>[\s\S]*?<text>([^<]*)<\/text>[\s\S]*?<content\s+src="([^"]*)"[\s\S]*?<\/navPoint>/g;
    while ((m = navRe.exec(ncxXml)) !== null) tocChapters.push({ title: m[1].trim(), src: m[2].split('#')[0] });
  }
  const tocSrcSet = new Set(tocChapters.map(c => c.src));

  const paragraphs = [];
  for (const ref of spineRefs) {
    if (tocPageIds.has(ref)) continue;
    const item = manifest[ref];
    if (!item || !item.type.includes('html')) continue;
    const filePath = opfDir + decodeURIComponent(item.href);
    const html = zip.readAsText(filePath) || '';

    const linkCount = (html.match(/<a\s/gi) || []).length;
    const plainLen = html.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
    if (linkCount > 5 && plainLen < linkCount * 30) continue;

    const hrefBase = item.href.split('/').pop() || item.href;
    if (tocSrcSet.has(hrefBase) || tocSrcSet.has(item.href)) {
      const ch = tocChapters.find(c => c.src === hrefBase || c.src === item.href);
      if (ch && ch.title) paragraphs.push('# ' + ch.title);
    }

    const htmlWithImgMarkers = html.replace(/<image\s[^>]*xlink:href\s*=\s*["']([^"']+)["'][^>]*\/?>/gi, (_, src) => {
      const fname = decodeURIComponent(src).split('/').pop();
      let matched = null;
      for (const [, f] of epubImageMap) { if (f === fname) { matched = fname; break; } }
      return matched ? `\n\n[IMG:${matched}]\n\n` : '';
    }).replace(/<img\s[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, src) => {
      const decoded = decodeURIComponent(src);
      const resolvedSrc = decoded.startsWith('/') || decoded.startsWith('http') ? decoded : opfDir + decoded;
      const normSrc = resolvedSrc.replace(/^\.\//, '').replace(/\/\.\//g, '/');
      let matchedFile = null;
      for (const [epubPath, fname] of epubImageMap) {
        if (epubPath === normSrc || epubPath.endsWith('/' + decoded.split('/').pop()) || decoded.split('/').pop() === fname) {
          matchedFile = fname; break;
        }
      }
      return matchedFile ? `\n\n[IMG:${matchedFile}]\n\n` : '';
    });

    const text = htmlWithImgMarkers
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<title[\s\S]*?<\/title>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .trim();
    if (text) paragraphs.push(...smartSplit(text));
  }

  const EPUB_JUNK = /^(Cover|封面|插图|导航|书名页|制作信息|Contents|[A-Z0-9]{3,10}(-\d+)?)$/;
  const cleaned = paragraphs
    .filter(p => !EPUB_JUNK.test(p.trim()))
    .filter((p, i, a) => i === 0 || p.trim() !== a[i - 1].trim());

  return { paragraphs: cleaned, zip, epubImageMap, epubCoverFile, opfDir };
}

export function extractImages(zip, epubImageMap, paragraphs) {
  const usedImages = new Set();
  for (const p of paragraphs) {
    const m = p.match(/\[IMG:([^\]]+)\]/);
    if (m) usedImages.add(m[1]);
  }
  const images = new Map();
  for (const [epubPath, fname] of epubImageMap) {
    if (usedImages.has(fname)) {
      try {
        const entry = zip.getEntry(epubPath);
        if (entry) images.set(fname, entry.getData());
      } catch {}
    }
  }
  return images;
}

export function extractCover(zip, epubCoverFile) {
  if (!epubCoverFile) return null;
  try {
    const entry = zip.getEntry(epubCoverFile);
    if (entry) {
      const ext = epubCoverFile.split('.').pop() || 'jpg';
      return { name: `cover.${ext}`, data: entry.getData() };
    }
  } catch {}
  return null;
}
