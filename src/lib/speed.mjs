import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

// Render-time forecast learned from this PC's real renders. Each step records how fast it went:
//   render:  frames encoded per second for one look (resolution + codec + visualizer + background type)
//   prep:    background preparation, seconds of work per (second of clip × megapixel)
//   analyze: loudness analysis, seconds of audio per second
//   mix:     audio mix, seconds of audio per second
const FILE = path.join(ROOT, 'projects', '_studio-state', 'render-speed.json');
const KEEP = 60;

export function readSpeeds() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
export function recordSpeed(entry) {
  if (!(entry.rate > 0) || !Number.isFinite(entry.rate)) return;
  try {
    const all = [...readSpeeds(), { ...entry, at: Date.now() }].slice(-KEEP);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all, null, 1));
  } catch { /* the forecast is a convenience: never fail a render over it */ }
}

export const renderKey = ({ W, H, codec, preset, bgImage }) => `${W}x${H}|${codec}|${preset}|${bgImage ? 'img' : 'vid'}`;

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const recent = (list) => median(list.slice(-5)); // the last runs reflect the current drivers/settings

// Guesses used until this PC has rendered something comparable (frames per second at 1080p).
const DEFAULT_FPS_1080 = 180, DEFAULT_PREP = 0.35, DEFAULT_ANALYZE = 40, DEFAULT_MIX = 500;
// A 20 s preview runs ~15% slower than a long render (warm-up is a bigger share): full renders win when there are any.
const best = (list) => (list.some((s) => !s.preview) ? list.filter((s) => !s.preview) : list);

/**
 * Seconds a full render will take. `look` = { W, H, fps, codec, preset, bgImage };
 * `work` = { total, analyzeSec, mix, prepClipSec }. Returns { seconds, measured, parts }.
 */
export function forecast(look, work, speeds = readSpeeds()) {
  const px = look.W * look.H;
  const renders = best(speeds.filter((s) => s.kind === 'render'));
  const exact = best(speeds.filter((s) => s.kind === 'render' && s.key === renderKey(look)));
  // Same look measured → exact. Otherwise scale other measurements by pixel count (slower at 4K).
  let rate, measured = exact.length > 0;
  if (measured) rate = recent(exact.map((s) => s.rate));
  else if (renders.length) rate = recent(renders.map((s) => (s.rate * s.px) / px));
  else rate = (DEFAULT_FPS_1080 * 1920 * 1080) / px;
  const startup = exact.length ? recent(exact.map((s) => s.startup || 0)) : 6;
  const of = (kind, fallback) => { const l = speeds.filter((s) => s.kind === kind); return l.length ? recent(l.map((s) => s.rate)) : fallback; };
  const parts = {
    analyze: work.analyzeSec / of('analyze', DEFAULT_ANALYZE),
    mix: work.mix ? work.total / of('mix', DEFAULT_MIX) : 0,
    prep: work.prepClipSec ? work.prepClipSec * (px / 1e6) * of('prep', DEFAULT_PREP) : 0,
    render: startup + (work.total * look.fps) / rate,
  };
  return { seconds: Object.values(parts).reduce((a, b) => a + b, 0), measured, parts };
}
