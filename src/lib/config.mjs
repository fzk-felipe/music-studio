import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULTS = {
  video: { resolution: '1080p', width: 1920, height: 1080, fps: 'auto' }, // resolution: 1080p | 1440p | 4k // auto = fps of the background video (30 for images)
  // codec: auto picks the fastest working one (NVIDIA → Intel → AMD → CPU); cq: lower = better/larger
  encode: { codec: 'auto', cq: 21, maxrate: '12M', audioBitrate: '320k' },
  cleanMetadata: false, // do not copy source/container or stream tags and chapters to rendered MP4s
  audio: { targetLufs: -14, crossfade: 4, minDurationMin: 60, ambience: null },
  tracks: 'tracks',
  background: null,
  backgroundDim: 0,
  loopFade: 0.75, // seconds of crossfade at the video loop seam (hides imperfect loops); 0 = off
  loopTransition: 'crossfade', // cut | crossfade | fade-black; crossfade on the same still image is invisible
  imageLoopSeconds: 15, // duration of one still-image cycle when fade-black is selected
  backgroundAnim: 'none', // none | fade (only at the start of the finished video)
  backgroundSmooth: 5, // frames of temporal smoothing on video loops (removes AI texture shimmer); 0 = off
  bottomShade: { strength: 0, height: 380 }, // dark gradient behind the visualizer (0-1)
  visualizer: {
    enabled: true,
    preset: 'bars', // bars | wave | circle (FFmpeg) — capsules | dots | silk | mountains | needles | ribbon | ring | orbit | halo | sunburst (custom-drawn)
    color: '#F2D7A6',
    color2: null, // gradient bottom color (optional)
    opacity: 0.9,
    width: 1100,
    height: 160,
    bottom: 110, // px from the bottom edge to the baseline (bars) / center line (wave)
    bars: 64,
    gap: 0.4, // fraction of each slot left empty between bars
    minBar: 2,
    sensitivity: 6, // bars: showcqt bar_v; wave: volume multiplier
    tilt: 0.5, // bars: boosts highs relative to bass (0 = flat)
    gamma: 2.5,
    smoothing: 0.25, // seconds; higher = calmer bars
    minFreq: 50,
    maxFreq: 6000,
    glow: 10,
    glowStrength: 0.55,
    reflection: 0.15, // bars only; 0 disables
    anim: 'none', // intro: none | fade | slide-left | slide-right | rise
    animDuration: 1,
    radius: 160, // circle only
    center: { x: 0.5, y: 0.5 }, // circle only, fraction of the frame
    centerImage: null, // circle only: cover art shown as a spinning disc
    centerImageScale: 90, // photo diameter as % of 2 * radius; may overlap the ring above 100%
    rotation: 6, // degrees per second for the disc
    // custom-drawn presets
    mirror: true, // bass in the middle, treble at both edges
    anchor: 'center', // capsules/dots: 'center' grows up+down, 'bottom' grows upward
    lineWidth: 3, // silk/mountains/ribbon outlines and needle width
    fillAlpha: 0.3, // silk/mountains body opacity
    ringGap: 10, // ring: space between the disc and the bars
    attack: 0.55, // how fast bars rise (0-1)
    release: 0.12, // how fast bars fall (0-1)
  },
  // Layout from the niche research: title only at the start, song name briefly, small channel mark.
  text: {
    title: {
      enabled: false, text: '{title}', font: 'C:/Windows/Fonts/georgiai.ttf', size: 56, color: '#FFF6E8', shadow: true,
      x: '90', y: '80', duration: 25,
      subtitle: { text: '', font: 'C:/Windows/Fonts/segoeui.ttf', size: 24, opacity: 0.9, y: '152' },
    },
    nowPlaying: {
      enabled: false, prefix: '', font: 'C:/Windows/Fonts/georgiai.ttf', size: 30, color: '#FFF6E8', opacity: 0.95, shadow: true,
      x: '90', y: 'h-112', duration: 12,
      label: { text: 'NOW PLAYING', font: 'C:/Windows/Fonts/segoeui.ttf', size: 16, opacity: 0.7, y: 'h-138' },
    },
    trackProgress: {
      enabled: false, font: 'C:/Windows/Fonts/segoeuib.ttf', size: 30, color: '#FFFFFF', opacity: 1,
      x: '760', y: '45', width: 400, lineGap: 12, lineColor: '#FFFFFF', dotColor: '#FFFFFF', dotShape: 'circle', shadow: true,
      anim: 'none',
    },
    cta: {
      enabled: false, text: 'PLEASE LIKE, COMMENT, AND SUBSCRIBE',
      font: 'C:/Windows/Fonts/segoeuib.ttf', size: 34, color: '#FFFFFF', opacity: 1, shadow: true,
      x: '(w-text_w)/2', y: '920', first: 90, repeat: true, every: 900, duration: 8, anim: 'fade',
    },
    watermark: {
      enabled: false, text: '', font: 'C:/Windows/Fonts/georgiai.ttf', size: 24, color: '#FFF6E8', opacity: 0.75, shadow: true,
      x: 'w-text_w-60', y: 'h-82',
      anim: 'none',
    },
  },
  // Channel reminder image ("like & subscribe"), shown at `first` s and then every `every` s.
  overlay: { enabled: false, image: null, width: 560, x: 60, y: 60, first: 60, every: 900, duration: 8 },
  // Channel intro: a green-screen clip played over the start of every video, its background keyed out.
  // similarity/blend = chromakey tolerance and edge softness; scale = % of the frame width; volume 0 = muted.
  intro: { enabled: false, file: null, color: '#00FF00', similarity: 0.3, blend: 0.08, scale: 100, volume: 1 },
  description: { template: '{title}\n\n{tracklist}', tags: [] },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a?.[k]) ? merge(a[k], v) : v;
  return out;
}

// Paths in a JSON file are relative to that file's folder.
function resolvePaths(obj, base) {
  const r = (p) => (p ? path.resolve(base, p) : p);
  const o = structuredClone(obj);
  if (o.tracks) o.tracks = r(o.tracks);
  if (o.background) o.background = r(o.background);
  if (o.visualizer?.centerImage) o.visualizer.centerImage = r(o.visualizer.centerImage);
  if (o.overlay?.image) o.overlay.image = r(o.overlay.image);
  if (o.intro?.file) o.intro.file = r(o.intro.file);
  if (o.audio?.ambience?.file) o.audio.ambience.file = r(o.audio.ambience.file);
  for (const k of ['title', 'nowPlaying', 'trackProgress', 'cta', 'watermark']) {
    const t = o.text?.[k];
    for (const x of [t, t?.subtitle, t?.label]) if (x?.font) x.font = fontPath(x.font, base);
  }
  return o;
}

// A font path saved on another PC (e.g. C:/Users/<other>/msc/fonts/x.ttf) is looked up by file name
// in <raiz>/fonts and the Windows font folders.
function fontPath(p, base) {
  const r = path.resolve(base, p);
  if (fs.existsSync(r)) return r;
  const dirs = [path.join(ROOT, 'fonts'), path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts')];
  for (const d of dirs) if (fs.existsSync(path.join(d, path.basename(p)))) return path.join(d, path.basename(p));
  return r;
}

// Strip the BOM Notepad/PowerShell may add, so hand-edited files still parse.
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));

export { readJson, merge, resolvePaths };

/** Built-in defaults <- channel.json (what a project inherits before its own overrides). */
export function channelConfig(channel) {
  if (!channel) return structuredClone(DEFAULTS);
  const cDir = path.join(ROOT, 'channels', channel);
  return merge(DEFAULTS, resolvePaths(readJson(path.join(cDir, 'channel.json')), cDir));
}

/** channel.json (defaults of the channel) <- project.json (this video) */
export function loadProject(projectDir, { requireBackground = true } = {}) {
  // Accept a path, or just the project name (looked up in <raiz>/projects/).
  const byName = path.join(ROOT, 'projects', projectDir);
  projectDir = fs.existsSync(path.resolve(projectDir, 'project.json')) ? path.resolve(projectDir) : byName;
  const pFile = path.join(projectDir, 'project.json');
  if (!fs.existsSync(pFile)) throw new Error(`project.json não encontrado em ${projectDir}`);
  const project = readJson(pFile);
  const chCfg = channelConfig(project.channel);
  let cfg = merge(chCfg, resolvePaths(project, projectDir));
  cfg.overlay = chCfg.overlay; // the reminder is always the channel's, never per video
  cfg.intro = chCfg.intro; // so is the intro
  if (requireBackground && !cfg.background) throw new Error('Defina "background" (imagem ou vídeo em loop) no project.json');
  // "{title}" in the on-screen title uses the video title.
  if (cfg.text.title?.text) cfg.text.title.text = cfg.text.title.text.replace('{title}', cfg.title || '');
  return { cfg, projectDir };
}
