import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listTracks } from './audio.mjs';

export const fileIdentity = (file) => {
  if (!file || !fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  if (!st.isFile()) return null;
  // A small content sample catches replacements whose timestamp was preserved by a copy tool.
  const fd = fs.openSync(file, 'r');
  try {
    const n = Math.min(st.size, 65536), first = Buffer.alloc(n), last = Buffer.alloc(n);
    fs.readSync(fd, first, 0, n, 0);
    fs.readSync(fd, last, 0, n, Math.max(0, st.size - n));
    return { path: path.resolve(file), size: st.size, mtimeMs: st.mtimeMs, sample: crypto.createHash('sha256').update(first).update(last).digest('hex') };
  } finally { fs.closeSync(fd); }
};

export function renderSignature(cfg) {
  const { description, ...rest } = cfg; // description.txt is separate from the encoded video
  const videoCfg = structuredClone(rest);
  if (videoCfg.text?.title?.text) videoCfg.text.title.text = videoCfg.text.title.text.replace('{title}', cfg.title || '');
  if (!videoCfg.text?.title?.enabled) delete videoCfg.title;
  const tracks = cfg.tracks && fs.existsSync(cfg.tracks) ? listTracks(cfg.tracks).map(fileIdentity) : [];
  const data = { cfg: videoCfg, background: fileIdentity(cfg.background), tracks,
    ambience: fileIdentity(cfg.audio?.ambience?.file), centerImage: fileIdentity(cfg.visualizer?.centerImage),
    overlay: fileIdentity(cfg.overlay?.image), intro: fileIdentity(cfg.intro?.file) };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export const stampFile = (projectDir) => path.join(projectDir, 'output', 'render-state.json');
export function readRenderState(projectDir, cfg) {
  const video = path.join(projectDir, 'output', 'video.mp4');
  if (!fs.existsSync(video)) return { status: 'missing' };
  const stamp = stampFile(projectDir);
  if (!fs.existsSync(stamp)) return { status: 'unknown' }; // older renders predate the stamp
  try {
    const saved = JSON.parse(fs.readFileSync(stamp, 'utf8'));
    const current = renderSignature(cfg);
    const st = fs.statSync(video);
    return { status: saved.signature === current && saved.videoSize === st.size &&
      (saved.videoMtimeMs == null || saved.videoMtimeMs === st.mtimeMs) ? 'fresh' : 'stale', renderedAt: saved.renderedAt };
  } catch { return { status: 'unknown' }; }
}
export function writeRenderState(projectDir, cfg) {
  const video = path.join(projectDir, 'output', 'video.mp4');
  const st = fs.statSync(video);
  fs.writeFileSync(stampFile(projectDir), JSON.stringify({ signature: renderSignature(cfg), videoSize: st.size, videoMtimeMs: st.mtimeMs,
    renderedAt: new Date().toISOString() }, null, 2) + '\n');
}
