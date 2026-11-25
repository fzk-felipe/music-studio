import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Fonts available for on-screen text: Windows fonts, the user's own installed fonts and
// <raiz>/fonts (fonts added through the app, e.g. downloaded from Google Fonts).
// Only .ttf/.otf: they work in both FFmpeg (drawtext) and the browser preview.

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, pos);
  return b;
}

/** Full font name from the OpenType 'name' table ("Georgia Italic"), or null. */
export function fontName(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = readAt(fd, 0, 12);
    if (![0x00010000, 0x74727565, 0x74797031, 0x4f54544f].includes(head.readUInt32BE(0))) return null;
    const numTables = head.readUInt16BE(4);
    const dir = readAt(fd, 12, numTables * 16);
    let off = -1;
    for (let i = 0; i < numTables; i++) if (dir.toString('latin1', i * 16, i * 16 + 4) === 'name') off = dir.readUInt32BE(i * 16 + 8);
    if (off < 0) return null;
    const nh = readAt(fd, off, 6);
    const count = nh.readUInt16BE(2);
    const strOff = off + nh.readUInt16BE(4);
    const recs = readAt(fd, off + 6, count * 12);
    const found = {};
    for (let i = 0; i < count; i++) {
      const [plat, , lang, id, len, o] = [0, 2, 4, 6, 8, 10].map((k) => recs.readUInt16BE(i * 12 + k));
      if (![1, 2, 4].includes(id)) continue;
      const raw = readAt(fd, strOff + o, len);
      let s;
      if (plat === 3 || plat === 0) {
        if (plat === 3 && lang !== 0x409 && found[`w${id}`]) continue;
        s = '';
        for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
        found[`w${id}`] ??= s;
        if (plat === 3 && lang === 0x409) found[`w${id}`] = s;
      } else if (plat === 1) found[`m${id}`] ??= raw.toString('latin1');
    }
    const full = found.w4 || found.m4;
    const fam = found.w1 || found.m1;
    const sub = found.w2 || found.m2;
    return (full || (fam && `${fam} ${sub && sub !== 'Regular' ? sub : ''}`) || '').trim() || null;
  } catch {
    return null;
  } finally {
    if (fd) fs.closeSync(fd);
  }
}

// drawtext has no fallback font: a character the font lacks (ã, ç, ●…) is drawn as a box in the
// video. Reads the 'cmap' table (Unicode format 12 or 4) into a "has this code point?" test.
const cmaps = new Map();
function cmapOf(file) {
  if (cmaps.has(file)) return cmaps.get(file);
  let has = null, fd;
  try {
    fd = fs.openSync(file, 'r');
    const numTables = readAt(fd, 4, 2).readUInt16BE(0);
    const dir = readAt(fd, 12, numTables * 16);
    let off = -1, len = 0;
    for (let i = 0; i < numTables; i++) if (dir.toString('latin1', i * 16, i * 16 + 4) === 'cmap') [off, len] = [dir.readUInt32BE(i * 16 + 8), dir.readUInt32BE(i * 16 + 12)];
    if (off >= 0) {
      const t = readAt(fd, off, len);
      const subs = Array.from({ length: t.readUInt16BE(2) }, (_, i) => ({ pid: t.readUInt16BE(4 + 8 * i), eid: t.readUInt16BE(6 + 8 * i), o: t.readUInt32BE(8 + 8 * i) }))
        .filter((s) => s.pid === 0 || (s.pid === 3 && (s.eid === 1 || s.eid === 10))); // Unicode only (not symbol fonts)
      const f12 = subs.find((s) => t.readUInt16BE(s.o) === 12), f4 = subs.find((s) => t.readUInt16BE(s.o) === 4);
      if (f12) {
        const groups = Array.from({ length: t.readUInt32BE(f12.o + 12) }, (_, i) => [t.readUInt32BE(f12.o + 16 + 12 * i), t.readUInt32BE(f12.o + 20 + 12 * i)]);
        has = (c) => groups.some(([a, b]) => c >= a && c <= b);
      } else if (f4) {
        const o = f4.o, seg = t.readUInt16BE(o + 6) / 2, ends = o + 14, starts = ends + 2 * seg + 2, deltas = starts + 2 * seg, ranges = deltas + 2 * seg;
        has = (c) => {
          for (let i = 0; i < seg; i++) {
            if (c > t.readUInt16BE(ends + 2 * i)) continue;
            const start = t.readUInt16BE(starts + 2 * i), delta = t.readUInt16BE(deltas + 2 * i), ro = t.readUInt16BE(ranges + 2 * i);
            if (c < start) return false;
            if (!ro) return ((c + delta) & 0xffff) !== 0;
            const g = t.readUInt16BE(ranges + 2 * i + ro + 2 * (c - start));
            return g !== 0 && ((g + delta) & 0xffff) !== 0;
          }
          return false;
        };
      }
    }
  } catch { has = null; } finally { if (fd) fs.closeSync(fd); }
  cmaps.set(file, has);
  return has;
}
/** Distinct characters of `text` the font cannot draw ([] when it can, or when the font can't be read). */
export function missingGlyphs(file, text) {
  const has = cmapOf(file);
  if (!has) return [];
  return [...new Set(String(text))].filter((ch) => ch.trim() && !has(ch.codePointAt(0)));
}

let cache = null;
function registeredWindowsFonts() {
  if (process.platform !== 'win32') return [];
  const base = path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts');
  const files = [];
  for (const key of ['HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
    let output;
    try { output = execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 5000 }); }
    catch { continue; }
    for (const line of output.split(/\r?\n/)) {
      const raw = line.match(/\sREG_(?:EXPAND_)?SZ\s+(.+)$/)?.[1]?.trim();
      if (!raw || !/\.(ttf|otf)$/i.test(raw)) continue;
      const expanded = raw.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
      const file = path.isAbsolute(expanded) ? expanded : path.join(base, expanded);
      if (fs.existsSync(file)) files.push(file);
    }
  }
  return files;
}
export function listFonts(root, { refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const dirs = [
    { dir: path.join(root, 'fonts'), source: 'adicionada' },
    { dir: path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts'), source: 'instalada' },
    { dir: path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts'), source: 'windows' },
  ];
  const seen = new Set();
  const out = [];
  for (const { dir, source } of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(ttf|otf)$/i.test(f)) continue;
      const file = path.join(dir, f).replaceAll('\\', '/');
      const name = fontName(file) || path.parse(f).name;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ file, name, source });
    }
  }
  for (const raw of registeredWindowsFonts()) {
    const file = raw.replaceAll('\\', '/');
    const name = fontName(raw) || path.parse(raw).name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ file, name, source: 'instalada' });
  }
  // Fonts added through the app first, then alphabetical.
  const rank = (f) => (f.source === 'adicionada' ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  cache = out;
  return out;
}
