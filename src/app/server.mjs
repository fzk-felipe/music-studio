// Local web app: the same pipeline as the CLI, driven from the browser.
// Listens on 127.0.0.1 only. Renders run the CLI as a child process so the app and the
// command line always behave identically.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ROOT, channelConfig, resolvePaths, readJson, merge } from '../lib/config.mjs';
import { listTracks, titleFromFile } from '../lib/audio.mjs';
import os from 'node:os';
import { duration, fmtTime, run, ffmpeg, frameRate, hasVideoStream } from '../lib/ffmpeg.mjs';
import { resolveFlow, safeName, download } from '../lib/flow.mjs';
import { listFonts, fontName, missingGlyphs } from '../lib/fonts.mjs';
import { RESOLUTIONS, backgroundReady } from '../lib/render.mjs';
import { forecast } from '../lib/speed.mjs';
import * as yt from '../lib/youtube.mjs';
import { readRenderState } from '../lib/project-state.mjs';

const PROJECTS = path.join(ROOT, 'projects');
const CHANNELS = path.join(ROOT, 'channels');
const VISUALS = path.join(ROOT, 'visuals');
const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus']);
const VISUAL_EXT = new Set([...IMAGE_EXT, '.mp4', '.mov', '.webm', '.mkv']);
const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac', '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};
// Settings the app edits; everything else in project.json is kept as is.
const EDITABLE = ['audio', 'backgroundDim', 'bottomShade', 'loopTransition', 'loopFade', 'imageLoopSeconds', 'backgroundAnim', 'visualizer', 'text', 'video', 'cleanMetadata']; // overlay (reminder) is saved to the channel

// ---------- helpers ----------------------------------------------------------------------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function diff(value, base) {
  if (isObj(value) && isObj(base)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const d = diff(v, base[k]);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
}

const projectDir = (name) => {
  if (!/^[\w.-]+$/.test(name)) throw httpError(400, 'nome de projeto inválido');
  const dir = path.join(PROJECTS, name);
  if (!fs.existsSync(path.join(dir, 'project.json'))) throw httpError(404, `projeto não encontrado: ${name}`);
  return dir;
};
const httpError = (status, message) => Object.assign(new Error(message), { status });
const writeJson = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
const slug = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

const channelDirs = () => fs.existsSync(CHANNELS)
  ? fs.readdirSync(CHANNELS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];
const channels = () => channelDirs()
  .filter((id) => fs.existsSync(path.join(CHANNELS, id, 'channel.json')))
  .flatMap((id) => {
    try { return [{ id, name: readJson(path.join(CHANNELS, id, 'channel.json')).name || id }]; }
    catch { return []; } // one broken channel.json must not hide every other channel
  });
const unconfiguredChannelFolders = () => channelDirs()
  .filter((id) => !fs.existsSync(path.join(CHANNELS, id, 'channel.json')));
const invalidChannelFolders = () => channelDirs().flatMap((id) => {
  const file = path.join(CHANNELS, id, 'channel.json');
  if (!fs.existsSync(file)) return [];
  try { readJson(file); return []; }
  catch (e) { return [{ id, error: e.message }]; }
});

const durCache = new Map();
// A song's id is its path inside the tracks folder: "01 - Song.m4a" or "Playlist name/01 - Song.m4a".
const trackId = (tracksDir, file) => path.relative(tracksDir, file).replaceAll('\\', '/');
const folderOf = (id) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');
async function trackInfo(file, tracksDir = path.dirname(file)) {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (!durCache.has(key)) durCache.set(key, await duration(file).catch(() => 0));
  const id = trackId(tracksDir, file);
  return { file: id, playlist: folderOf(id) || null, title: titleFromFile(file), duration: durCache.get(key) };
}

function loadRaw(name) {
  const dir = projectDir(name);
  const project = readJson(path.join(dir, 'project.json'));
  const base = channelConfig(project.channel);
  const cfg = merge(base, resolvePaths(project, dir));
  cfg.overlay = base.overlay; // the reminder is always the channel's
  cfg.intro = base.intro; // so is the intro
  return { dir, project, base, cfg };
}

// Browsers can't play HEVC/ProRes (and 4K60 is heavy): the live preview gets a small H.264 copy.
// The render always uses the original file.
async function browserPreview(bg, dir) {
  if (IMAGE_EXT.has(path.extname(bg).toLowerCase())) return null;
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width', '-of', 'csv=p=0', bg]);
  const [codec, width] = stdout.trim().split(',');
  if (codec === 'h264' && Number(width) <= 1920 && path.extname(bg).toLowerCase() === '.mp4') return null;
  const out = path.join(dir, '.work', 'bg_browser.mp4');
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(bg).mtimeMs) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await ffmpeg(['-i', bg, '-an', '-vf', 'scale=960:-2,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', out]);
  }
  return out;
}

async function projectView(name) {
  const { dir, project, base, cfg } = loadRaw(name);
  const tracksDir = cfg.tracks || path.join(dir, 'tracks');
  fs.mkdirSync(tracksDir, { recursive: true });
  if (!locks.has(name)) recoverTracks(tracksDir);
  const tracks = await Promise.all(listTracks(tracksDir).map((f) => trackInfo(f, tracksDir)));
  const xf = tracks.length > 1 ? cfg.audio.crossfade : 0;
  const total = tracks.reduce((s, t) => s + t.duration, 0) - xf * Math.max(0, tracks.length - 1);
  const bg = cfg.background && fs.existsSync(cfg.background) ? cfg.background : null;
  const out = path.join(dir, 'output');
  const output = {};
  for (const [k, f] of Object.entries({ preview: 'preview.mp4', video: 'video.mp4', overlay: 'visualizer_overlay.mp4', compareA: 'compare-a.mp4', compareB: 'compare-b.mp4' })) {
    const p = path.join(out, f);
    if (fs.existsSync(p)) output[k] = { url: `/media/${name}/output/${f}`, size: fs.statSync(p).size, mtime: fs.statSync(p).mtimeMs };
  }
  const descFile = path.join(out, 'description.txt');
  const proxy = bg && (await browserPreview(bg, dir).catch(() => null));
  return {
    name,
    channel: project.channel,
    title: project.title || '',
    settings: { ...Object.fromEntries(EDITABLE.map((k) => [k, cfg[k]])), audio: { ...cfg.audio,
      ambience: cfg.audio.ambience ? { volumeDb: -22, fadeIn: 0, fadeOut: 0, enabled: true, ...cfg.audio.ambience } : { file: null, volumeDb: -22, fadeIn: 0, fadeOut: 0, enabled: false } }, overlay: cfg.overlay, intro: cfg.intro },
    audio: cfg.audio,
    ambience: cfg.audio?.ambience?.file && fs.existsSync(cfg.audio.ambience.file) ? {
      name: path.basename(cfg.audio.ambience.file),
      url: path.dirname(cfg.audio.ambience.file) === dir ? `/media/${name}/${encodeURIComponent(path.basename(cfg.audio.ambience.file))}` : null,
    } : null,
    background: bg && {
      file: path.basename(bg),
      url: !proxy && path.dirname(bg) === VISUALS
        ? `/visual?name=${encodeURIComponent(path.basename(bg))}&v=${fs.statSync(bg).mtimeMs}`
        : `/media/${name}/${path.relative(dir, proxy || bg).replaceAll('\\', '/')}?v=${fs.statSync(bg).mtimeMs}`,
      isImage: IMAGE_EXT.has(path.extname(bg).toLowerCase()),
      inProject: !path.relative(dir, bg).startsWith('..'),
    },
    tracks: tracks.map((t) => ({ ...t, url: `/media/${name}/${path.relative(dir, path.join(tracksDir, t.file)).split(path.sep).map(encodeURIComponent).join('/')}` })),
    total,
    totalText: fmtTime(total),
    output,
    renderState: readRenderState(dir, cfg),
    estimate: await estimate(name).catch(() => null),
    compareSlots: (() => { try { const x = readJson(path.join(dir, '.work', 'compare-settings.json')); return { a: !!x.a, b: !!x.b }; } catch { return { a: false, b: false }; } })(),
    description: fs.existsSync(descFile) ? fs.readFileSync(descFile, 'utf8') : null,
    thumbnailUrl: (() => {
      const t = fs.readdirSync(dir).find((x) => /^thumbnail\.(jpe?g|png)$/i.test(x));
      return t ? `/media/${name}/${t}?v=${fs.statSync(path.join(dir, t)).mtimeMs}` : null;
    })(),
    youtube: fs.existsSync(path.join(dir, 'youtube.json')) ? readJson(path.join(dir, 'youtube.json')) : null,
    upload: publicUpload(name),
    import: publicImport(name),
    uploadSession: (() => { const f = path.join(dir, '.work', 'upload-session.json');
      if (!fs.existsSync(f)) return null;
      try { const s = readJson(f); return { offset: s.offset, size: s.size, startedAt: s.startedAt }; } catch { return null; }
    })(),
    yt: project.channel ? yt.status(project.channel) : { configured: !!yt.client(), connected: false },
    fonts: fontsOf(cfg.text),
    introInfo: cfg.intro?.file && fs.existsSync(cfg.intro.file) ? { name: path.basename(cfg.intro.file), v: fs.statSync(cfg.intro.file).mtimeMs } : null,
    overlayUrl: cfg.overlay?.image && fs.existsSync(cfg.overlay.image) ? `/asset?f=${encodeURIComponent(cfg.overlay.image)}&v=${fs.statSync(cfg.overlay.image).mtimeMs}` : null,
    centerImageUrl: cfg.visualizer?.centerImage && fs.existsSync(cfg.visualizer.centerImage) ? `/asset?f=${encodeURIComponent(cfg.visualizer.centerImage)}&v=${fs.statSync(cfg.visualizer.centerImage).mtimeMs}` : null,
    hasChannelDefaults: !!base,
  };
}
const fontsOf = (t = {}) => {
  const list = [t.title, t.title?.subtitle, t.nowPlaying, t.nowPlaying?.label, t.trackProgress, t.cta, t.watermark].map((o) => o?.font).filter(Boolean);
  return Object.fromEntries(list.map((f) => [f, `/font?f=${encodeURIComponent(f)}`]));
};

function listVisuals() {
  if (!fs.existsSync(VISUALS)) return [];
  return fs.readdirSync(VISUALS).filter((name) => VISUAL_EXT.has(path.extname(name).toLowerCase()) && fs.statSync(path.join(VISUALS, name)).isFile())
    .map((name) => {
      const st = fs.statSync(path.join(VISUALS, name));
      const image = IMAGE_EXT.has(path.extname(name).toLowerCase());
      const thumb = image ? `/visual?name=${encodeURIComponent(name)}` : fs.existsSync(path.join(VISUALS, '.thumbs', `${name}.jpg`)) ? `/visual-thumb?name=${encodeURIComponent(name)}` : null;
      return { name, url: `/visual?name=${encodeURIComponent(name)}`, thumb, image, size: st.size, mtime: st.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
}

function listProjects() {
  if (!fs.existsSync(PROJECTS)) return [];
  return fs.readdirSync(PROJECTS)
    .filter((n) => !n.startsWith('_') && fs.existsSync(path.join(PROJECTS, n, 'project.json')))
    .map((name) => {
      const dir = path.join(PROJECTS, name);
      let p = {};
      try { p = readJson(path.join(dir, 'project.json')); } catch { /* broken json: still list it */ }
      const tracksDir = path.join(dir, 'tracks');
      const video = path.join(dir, 'output', 'video.mp4');
      let renderStatus = fs.existsSync(video) ? 'unknown' : 'missing';
      if (renderStatus !== 'missing') try { renderStatus = readRenderState(dir, loadRaw(name).cfg).status; } catch {}
      return {
        name,
        title: p.title || name,
        channel: p.channel,
        tracks: fs.existsSync(tracksDir) ? listTracks(tracksDir).length : 0,
        done: fs.existsSync(video),
        importing: importing(name),
        renderStatus,
        mtime: fs.statSync(path.join(dir, 'project.json')).mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function saveProject(name, body) {
  const { dir, project, base } = loadRaw(name);
  const next = { ...project };
  if (body.channel && body.channel !== project.channel) {
    channelFile(body.channel);
    next.channel = body.channel;
  }
  if (typeof body.title === 'string') next.title = body.title;
  const chBase = next.channel === project.channel ? base : channelConfig(next.channel);
  for (const k of EDITABLE) {
    if (!(k in (body.settings || {}))) continue;
    const value = k === 'audio' ? structuredClone(body.settings.audio) : body.settings[k];
    if (k === 'audio' && value?.ambience?.file && path.dirname(path.resolve(value.ambience.file)) === dir)
      value.ambience.file = path.basename(value.ambience.file);
    const d = diff(value, chBase[k]);
    if (d === undefined) delete next[k];
    else next[k] = d;
  }
  // The reminder belongs to the channel: its settings are saved there (never per video), and only
  // when the channel didn't just change (the page still holds the old channel's values).
  for (const [key, own] of [['overlay', 'image'], ['intro', 'file']]) {
    delete next[key];
    const ov = body.settings?.[key];
    if (!(ov && next.channel && next.channel === project.channel && body.channel == null)) continue;
    const cf = path.join(CHANNELS, next.channel, 'channel.json');
    const ch = readJson(cf);
    const { [own]: _file, ...rest } = ov; // the file itself only changes through its upload route
    const cur = ch[key] || {};
    if (Object.entries(rest).some(([k, v]) => JSON.stringify(cur[k]) !== JSON.stringify(v) && JSON.stringify(chBase[key]?.[k]) !== JSON.stringify(v))) {
      ch[key] = { ...cur, ...rest };
      writeJson(cf, ch);
    }
  }
  writeJson(path.join(dir, 'project.json'), next);
}

// Saves the visual look (not texts) as the channel default, so the next videos start from it.
function saveChannelLook(name, body) {
  const { project } = loadRaw(name);
  if (!project.channel) throw httpError(400, 'projeto sem canal');
  const file = path.join(CHANNELS, project.channel, 'channel.json');
  const ch = readJson(file);
  const s = body.settings || {};
  if (s.visualizer) ch.visualizer = { ...ch.visualizer, ...s.visualizer };
  if (s.bottomShade) ch.bottomShade = s.bottomShade;
  if (s.backgroundDim != null) ch.backgroundDim = s.backgroundDim;
  // Reminder timing/position (the image itself is already the channel's).
  if (s.overlay) { const { image, ...rest } = s.overlay; ch.overlay = { ...(ch.overlay || {}), ...rest }; }
  if (s.intro) { const { file, ...rest } = s.intro; ch.intro = { ...(ch.intro || {}), ...rest }; }
  // Text styles (font, size, color, opacity) become the channel's; the texts themselves stay per video.
  const STYLE = ['font', 'size', 'color', 'opacity'];
  const pick = (o) => Object.fromEntries(STYLE.filter((k) => o?.[k] != null).map((k) => [k, o[k]]));
  if (s.text) {
    ch.text ??= {};
    for (const [k, sub] of [['title', 'subtitle'], ['nowPlaying', 'label'], ['trackProgress', null], ['cta', null], ['watermark', null]]) {
      if (!s.text[k]) continue;
      ch.text[k] = { ...(ch.text[k] || {}), ...pick(s.text[k]) };
      if (sub && s.text[k][sub]) ch.text[k][sub] = { ...(ch.text[k][sub] || {}), ...pick(s.text[k][sub]) };
    }
  }
  writeJson(file, ch);
  // The project no longer needs its own copy of those settings.
  saveProject(name, { settings: { visualizer: s.visualizer, bottomShade: s.bottomShade, backgroundDim: s.backgroundDim, text: s.text, overlay: s.overlay } });
}

// ---------- channels ----------
const channelFile = (id) => {
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(id) || /[. ]$/.test(id))
    throw httpError(400, 'nome de pasta de canal inválido');
  const f = path.join(CHANNELS, id, 'channel.json');
  if (!fs.existsSync(f)) throw httpError(404, `canal não encontrado: ${id}`);
  return f;
};
function channelView(id) {
  const ch = readJson(channelFile(id));
  const projects = listProjects().filter((p) => p.channel === id).length;
  return { id, name: ch.name || id, watermark: ch.text?.watermark?.text || '', description: ch.description || { template: '', tags: [] }, projects };
}
// New channel = copy of an existing one's look (visualizer, fonts, text layout) with its own name/description.
function createChannel({ name, from, folder }) {
  if (!name?.trim()) throw httpError(400, 'dê um nome ao canal');
  const id = folder || slug(name) || 'canal';
  if (folder) {
    if (!unconfiguredChannelFolders().includes(folder)) throw httpError(400, 'pasta não encontrada ou já configurada');
  } else if (fs.existsSync(path.join(CHANNELS, id))) throw httpError(400, `já existe um canal ou pasta "${id}"`);
  const source = from === '' ? null : (from || channels()[0]?.id);
  const base = source ? readJson(channelFile(source)) : channelConfig(null);
  const ch = structuredClone(base);
  ch.name = name.trim();
  ch.text ??= {};
  ch.text.watermark = { ...(ch.text.watermark || {}), enabled: true, text: name.trim() };
  ch.description = { template: '{title}\n\n🎵 Tracklist\n{tracklist}', tags: [] };
  // The reminder image is the source channel's own: a new channel starts without one.
  if (ch.overlay) ch.overlay = { ...ch.overlay, image: null, enabled: false };
  if (ch.intro) ch.intro = { ...ch.intro, file: null, enabled: false }; // same for the intro video
  fs.mkdirSync(path.join(CHANNELS, id), { recursive: true });
  writeJson(path.join(CHANNELS, id, 'channel.json'), ch);
  return id;
}
function updateChannel(id, { name, watermark, description }) {
  const f = channelFile(id);
  const ch = readJson(f);
  if (name?.trim()) ch.name = name.trim();
  if (typeof watermark === 'string') {
    ch.text ??= {};
    ch.text.watermark = { ...(ch.text.watermark || {}), text: watermark, enabled: !!watermark.trim() && ch.text.watermark?.enabled !== false };
  }
  if (description) ch.description = { template: String(description.template ?? ''), tags: (description.tags || []).map(String).filter(Boolean) };
  writeJson(f, ch);
}
const presetDir = (id) => path.join(path.dirname(channelFile(id)), 'presets');
function listPresets(id) {
  const dir = presetDir(id);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[\w-]+\.json$/.test(f))
    .map((f) => ({ id: path.basename(f, '.json'), name: (() => { try { return readJson(path.join(dir, f)).name || path.basename(f, '.json'); } catch { return path.basename(f, '.json'); } })() })) : [];
}
function savePreset(id, { name, settings }) {
  if (!name?.trim() || !settings || typeof settings !== 'object') throw httpError(400, 'informe um nome e configurações');
  const key = slug(name);
  if (!key) throw httpError(400, 'nome de modelo inválido');
  const dir = presetDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const selected = Object.fromEntries(EDITABLE.filter((k) => k in settings).map((k) => [k, structuredClone(settings[k])]));
  if (selected.text?.title) selected.text.title.text = '{title}';
  writeJson(path.join(dir, key + '.json'), { name: name.trim(), settings: selected });
  return key;
}
function applyPreset(projectName, id) {
  if (!/^[\w-]+$/.test(id)) throw httpError(400, 'modelo inválido');
  const { project } = loadRaw(projectName);
  const file = path.join(presetDir(project.channel), id + '.json');
  if (!fs.existsSync(file)) throw httpError(404, 'modelo não encontrado');
  saveProject(projectName, { settings: readJson(file).settings });
}

function createProject({ title, channel }) {
  if (!title?.trim()) throw httpError(400, 'dê um nome ao vídeo');
  channelFile(channel);
  let name = slug(title) || 'video';
  for (let i = 2; fs.existsSync(path.join(PROJECTS, name)); i++) name = `${slug(title)}-${i}`;
  const dir = path.join(PROJECTS, name);
  fs.mkdirSync(path.join(dir, 'tracks'), { recursive: true });
  // On-screen title: the short part of the YouTube title ("Rainy Day Piano 🌧️ Soft Piano…" → "Rainy Day Piano").
  const short = title.split(/[|–—:•]|\s-\s|\p{Extended_Pictographic}/u)[0].trim();
  writeJson(path.join(dir, 'project.json'), {
    channel, title: title.trim(), background: null, tracks: 'tracks', ...(short && { text: { title: { text: short } } }),
  });
  return name;
}

function dirSize(target) {
  if (!target || !fs.existsSync(target)) return 0;
  const st = fs.statSync(target);
  if (st.isFile()) return st.size;
  return fs.readdirSync(target, { withFileTypes: true }).reduce((n, e) =>
    n + (e.isSymbolicLink() ? 0 : dirSize(path.join(target, e.name))), 0);
}
function storageView(name) {
  const { dir, cfg } = loadRaw(name);
  const out = path.join(dir, 'output');
  const tracksDir = cfg.tracks || path.join(dir, 'tracks');
  return { tracks: dirSize(tracksDir), trash: dirSize(path.join(tracksDir, '.lixeira')), background: dirSize(cfg.background),
    cache: dirSize(path.join(dir, '.work')), output: dirSize(out),
    previews: ['preview.mp4', 'visualizer_overlay.mp4', 'compare-a.mp4', 'compare-b.mp4']
      .reduce((n, f) => n + dirSize(path.join(out, f)), 0) };
}
function cleanStorage(name, { cache, previews, trash }) {
  const dir = projectDir(name);
  if (job?.status === 'running' && job.project === name || uploads[name]?.status === 'running')
    throw httpError(409, 'espere terminar o render ou envio antes de limpar');
  const work = path.resolve(dir, '.work'), out = path.resolve(dir, 'output');
  if (path.dirname(work) !== path.resolve(dir) || path.dirname(out) !== path.resolve(dir)) throw httpError(400, 'caminho inválido');
  if (cache && fs.existsSync(work)) for (const e of fs.readdirSync(work)) {
    if (e === 'upload-session.json') continue; // never erase an interrupted upload silently
    const target = path.resolve(work, e);
    if (path.dirname(target) !== work) throw httpError(400, 'caminho fora do cache');
    fs.rmSync(target, { recursive: true, force: true });
  }
  if (trash) {
    const { cfg } = loadRaw(name);
    const bin = path.resolve(cfg.tracks || path.join(dir, 'tracks'), '.lixeira');
    if (path.basename(bin) !== '.lixeira') throw httpError(400, 'caminho inválido');
    fs.rmSync(bin, { recursive: true, force: true });
  }
  if (previews) for (const f of ['preview.mp4', 'visualizer_overlay.mp4', 'compare-a.mp4', 'compare-b.mp4']) {
    const target = path.resolve(out, f);
    if (path.dirname(target) !== out) throw httpError(400, 'caminho fora dos resultados');
    fs.rmSync(target, { force: true });
  }
  return storageView(name);
}

// Rewrites "NN - Title.ext" names to follow `order` (and optional new titles).
// Renames are all-or-nothing: files are moved into a private staging folder, then to their final
// names; any failure (Windows refuses to rename a file another program has open) moves every file
// back to its original name. Nothing is ever renamed over an existing file.
function renameAll(tracksDir, plan /* [{from, to}] track ids (paths inside tracksDir) */) {
  const changes = plan.filter((p) => p.from !== p.to);
  if (!changes.length) return;
  const stage = path.join(tracksDir, `.staging-${Date.now()}`);
  fs.mkdirSync(stage);
  const done = []; // [src, dst] moves to undo
  const move = (a, b) => {
    if (fs.existsSync(b)) throw new Error(`já existe: ${path.basename(b)}`);
    fs.renameSync(a, b);
    done.push([a, b]);
  };
  try {
    changes.forEach((p, i) => move(path.join(tracksDir, p.from), path.join(stage, `${i}${path.extname(p.from)}`)));
    changes.forEach((p, i) => move(path.join(stage, `${i}${path.extname(p.from)}`), path.join(tracksDir, p.to)));
  } catch (e) {
    for (const [a, b] of done.reverse()) try { fs.renameSync(b, a); } catch { /* left in staging; recovered on next load */ }
    fs.rmSync(stage, { recursive: true, force: true });
    const busy = /EBUSY|EPERM|EACCES/.test(e.code || e.message);
    throw httpError(409, busy ? 'uma música está aberta em outro programa (render, player, CapCut) — feche e tente de novo' : e.message);
  }
  fs.rmSync(stage, { recursive: true, force: true });
}

// Leftovers of an interrupted rename (older versions used __tmp_N names) are put back as tracks.
function recoverTracks(tracksDir) {
  if (!fs.existsSync(tracksDir)) return;
  for (const d of fs.readdirSync(tracksDir).filter((f) => f.startsWith('.staging-'))) {
    const sd = path.join(tracksDir, d);
    for (const f of fs.readdirSync(sd)) fs.renameSync(path.join(sd, f), nextTrackName(tracksDir, `Recuperada ${f}`, path.extname(f)));
    fs.rmSync(sd, { recursive: true, force: true });
  }
}

// A playlist folder name Windows accepts as is ('' = loose songs, no folder).
const folderName = (s) => (String(s || '').trim() ? safeName(String(s)).replace(/^[. ]+|[. ]+$/g, '') : '');
const playlistFolders = (tracksDir) => fs.readdirSync(tracksDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
// `moves` = { id: folder }: songs dragged into another playlist (only existing playlists, or '' = loose).
function reorderTracks(name, { order, titles = {}, moves = {} }) {
  const { cfg, dir } = loadRaw(name);
  const tracksDir = cfg.tracks || path.join(dir, 'tracks');
  const existing = listTracks(tracksDir).map((f) => trackId(tracksDir, f));
  const folders = new Set(['', ...playlistFolders(tracksDir)]);
  // Tracks missing from `order` (e.g. a stale page) keep their relative order at the end.
  const files = [...new Set(order.filter((f) => existing.includes(f))), ...existing.filter((f) => !order.includes(f))];
  const pad = Math.max(2, String(files.length).length);
  const plan = files.map((f, i) => {
    const wanted = typeof titles[f] === 'string' && titles[f].trim() ? titles[f] : titleFromFile(f); // empty name = keep
    const folder = typeof moves[f] === 'string' && folders.has(moves[f]) ? moves[f] : folderOf(f); // otherwise it stays in its playlist
    return { from: f, to: `${folder ? folder + '/' : ''}${String(i + 1).padStart(pad, '0')} - ${safeName(wanted)}${path.extname(f)}` };
  });
  renameAll(tracksDir, plan);
  for (const d of playlistFolders(tracksDir)) if (!fs.readdirSync(path.join(tracksDir, d)).length) fs.rmdirSync(path.join(tracksDir, d)); // emptied by moves
}
function renamePlaylist(name, from, to) {
  const { cfg, dir } = loadRaw(name);
  const tracksDir = cfg.tracks || path.join(dir, 'tracks');
  const next = folderName(to);
  if (!playlistFolders(tracksDir).includes(from)) throw httpError(404, 'playlist não encontrada');
  if (!next) throw httpError(400, 'dê um nome à playlist');
  if (next === from) return;
  if (playlistFolders(tracksDir).some((d) => d.toLowerCase() === next.toLowerCase())) throw httpError(409, `já existe uma playlist "${next}" neste vídeo`);
  try { fs.renameSync(path.join(tracksDir, from), path.join(tracksDir, next)); }
  catch { throw httpError(409, 'uma música da playlist está aberta em outro programa — feche e tente de novo'); }
}

// Removed tracks go to tracks/.lixeira/<time>/<id> (hidden), so a delete can be undone; the
// "Limpar cache e prévias" button empties it for good.
function trashTracks(name, ids) {
  const { cfg, dir } = loadRaw(name);
  const tracksDir = cfg.tracks || path.join(dir, 'tracks');
  const known = new Set(listTracks(tracksDir).map((f) => trackId(tracksDir, f)));
  const batch = path.join(tracksDir, '.lixeira', String(Date.now()));
  for (const id of ids.filter((x) => known.has(x))) {
    const to = path.join(batch, id);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(path.join(tracksDir, id), to); }
    catch { throw httpError(409, 'a música está aberta em outro programa — feche e tente de novo'); }
    const folder = folderOf(id);
    if (folder && !fs.readdirSync(path.join(tracksDir, folder)).length) fs.rmdirSync(path.join(tracksDir, folder));
  }
  reorderTracks(name, { order: [] }); // close the numbering gap
}
const trashTrack = (name, id) => trashTracks(name, [id]);
const trashPlaylist = (name, folder) => {
  const { cfg, dir } = loadRaw(name);
  const tracksDir = cfg.tracks || path.join(dir, 'tracks');
  trashTracks(name, listTracks(tracksDir).map((f) => trackId(tracksDir, f)).filter((id) => folderOf(id) === folder));
};
// Undo of the last removal (one song or a whole playlist). `index` puts a single song back in place.
function restoreTrack(name, { index }) {
  const { cfg, dir } = loadRaw(name);
  const tracksDir = cfg.tracks || path.join(dir, 'tracks');
  const trash = path.join(tracksDir, '.lixeira');
  const last = fs.existsSync(trash) ? fs.readdirSync(trash).sort().at(-1) : null;
  if (!last) throw httpError(404, 'nada para desfazer');
  const src = path.join(trash, last);
  // Older versions trashed single files as "<time>__<name>"; batches are folders.
  const items = fs.statSync(src).isFile() ? [[src, '']] : (fs.readdirSync(src, { recursive: true }))
    .map((rel) => path.join(src, rel)).filter((f) => fs.statSync(f).isFile()).sort()
    .map((f) => [f, folderOf(path.relative(src, f).replaceAll('\\', '/'))]);
  const back = items.map(([f, folder]) => {
    const to = nextTrackName(tracksDir, titleFromFile(path.basename(f).replace(/^\d+__/, '')), path.extname(f), folder);
    fs.renameSync(f, to);
    return trackId(tracksDir, to);
  });
  fs.rmSync(src, { recursive: true, force: true });
  const order = listTracks(tracksDir).map((f) => trackId(tracksDir, f)).filter((id) => !back.includes(id));
  order.splice(back.length === 1 ? Math.max(0, Math.min(order.length, index ?? order.length)) : order.length, 0, ...back);
  reorderTracks(name, { order });
}

// One change at a time per project, and none while that project is rendering (ffmpeg has the files open).
const locks = new Map();
async function trackOp(name, fn) {
  if (job?.status === 'running' && job.project === name) throw httpError(409, 'espere a tarefa atual terminar (ou cancele) para mexer nas músicas');
  if (importing(name)) throw httpError(409, 'espere a importação da playlist terminar para mexer nas músicas');
  const prev = locks.get(name) || Promise.resolve();
  const cur = prev.catch(() => {}).then(fn);
  locks.set(name, cur);
  try { return await cur; } finally { if (locks.get(name) === cur) locks.delete(name); }
}

// Numbers are shared by all playlist folders, so the video order is simply by number.
function nextTrackName(tracksDir, title, ext, folder = '') {
  const nums = listTracks(tracksDir).map((f) => Number(path.basename(f).match(/^(\d+)/)?.[1])).filter(Number.isFinite);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  fs.mkdirSync(path.join(tracksDir, folder), { recursive: true });
  return path.join(tracksDir, folder, `${String(n).padStart(2, '0')} - ${safeName(title)}${ext}`);
}

// Code version = newest source file time. A newer copy of the app replaces an older one still running.
const srcFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(path.join(d, e.name)) : [path.join(d, e.name)]));
const codeVersion = () => String(Math.max(...srcFiles(path.join(ROOT, 'src')).map((f) => fs.statSync(f).mtimeMs)));
const VERSION = codeVersion();

// ---------- jobs (one at a time: renders use the whole GPU) ------------------------------
let job = null;
let jobSeq = 0;
const publicJob = () =>
  job && { id: job.id, kind: job.kind, project: job.project, status: job.status, stage: job.stage, pct: job.pct,
    eta: job.status === 'running' && buildLeft(job) != null ? fmtTime(buildLeft(job)) : job.eta,
    log: job.log.slice(-80), error: job.error, startedAt: job.startedAt, endedAt: job.endedAt };

function newJob(kind, project) {
  if (job?.status === 'running') throw httpError(409, 'já tem uma tarefa rodando — espere terminar ou cancele');
  job = { id: ++jobSeq, kind, project, status: 'running', stage: 'iniciando…', pct: null, eta: null, log: [], startedAt: Date.now() };
  return job;
}
const finish = (j, status, error) => {
  Object.assign(j, { status, error, endedAt: Date.now(), pct: status === 'done' ? 100 : j.pct });
  if (j.kind === 'build') history.unshift({ project: j.project, status, error, endedAt: j.endedAt, took: j.endedAt - j.startedAt });
  history.length = Math.min(history.length, 15);
  estCache.clear(); // a finished render taught new speeds
  saveQueueState();
  setTimeout(pump, 1500); // next video in the queue
};

// ---------- render queue: full videos run one after another (e.g. overnight) ----------
const QUEUE_FILE = path.join(PROJECTS, '_studio-state', 'queue.json');
const savedQueue = (() => { try { return readJson(QUEUE_FILE); } catch { return {}; } })();
const queue = Array.isArray(savedQueue.queue) ? savedQueue.queue.filter((p) => typeof p === 'string') : [];
const history = Array.isArray(savedQueue.history) ? savedQueue.history.slice(0, 15) : [];
if (savedQueue.runningBuild && !queue.includes(savedQueue.runningBuild)) queue.unshift(savedQueue.runningBuild);
const saveQueueState = () => {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  const tmp = QUEUE_FILE + '.tmp';
  writeJson(tmp, { queue, history, runningBuild: job?.status === 'running' && job.kind === 'build' ? job.project : null });
  fs.renameSync(tmp, QUEUE_FILE);
};
function checkRenderable(p) {
  const { cfg } = loadRaw(p);
  if (!cfg.background || !fs.existsSync(cfg.background)) throw httpError(400, `"${p}" está sem fundo`);
  // A video whose playlist is still downloading can wait in the queue; pump() skips it until done.
  if (!importing(p) && !listTracks(cfg.tracks || path.join(PROJECTS, p, 'tracks')).length) throw httpError(400, `"${p}" está sem músicas`);
}
function pump() {
  if (job?.status === 'running') return;
  const i = queue.findIndex((p) => !importing(p));
  if (i < 0) return;
  const [p] = queue.splice(i, 1);
  try {
    checkRenderable(p);
    runCli(p, ['build', p]);
  } catch (e) {
    history.unshift({ project: p, status: 'error', error: e.message, endedAt: Date.now(), took: 0 });
    saveQueueState();
    pump();
  }
}
// Key color of a green/blue-screen clip: the average of its two top corners, a little into the clip.
async function screenColor(file) {
  const out = path.join(os.tmpdir(), `msc-key-${process.pid}-${Date.now()}.rgb`);
  try {
    const at = Math.min(1, (await duration(file).catch(() => 0)) / 2);
    await ffmpeg(['-ss', at.toFixed(2), '-i', file, '-filter_complex',
      '[0:v]split[a][b];[a]crop=iw/20:ih/20:0:0[l];[b]crop=iw/20:ih/20:iw-iw/20:0[r];[l][r]hstack,scale=1:1:flags=area,format=rgb24',
      '-frames:v', '1', '-f', 'rawvideo', out]);
    return '#' + [...fs.readFileSync(out).subarray(0, 3)].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  } finally { fs.rmSync(out, { force: true }); }
}

// ---------- render-time forecast (learned from this PC's renders, see lib/speed.mjs) ----------
const fpsCache = new Map();
async function outputFps(cfg, bg, bgImage) {
  if (cfg.video.fps !== 'auto') return cfg.video.fps;
  if (bgImage) return 30;
  const st = fs.statSync(bg), key = `${bg}|${st.size}|${st.mtimeMs}`;
  if (!fpsCache.has(key)) fpsCache.set(key, await frameRate(bg).catch(() => 30));
  let fps = Math.round(fpsCache.get(key) * 1000) / 1000;
  while (fps > 31) fps /= 2; // same rule as render()
  return fps;
}
async function estimate(name) {
  const { dir, cfg } = loadRaw(name);
  const bg = cfg.background && fs.existsSync(cfg.background) ? cfg.background : null;
  const files = listTracks(cfg.tracks || path.join(dir, 'tracks'));
  if (!bg || !files.length) return null;
  const infos = await Promise.all(files.map(trackInfo));
  const total = infos.reduce((s, t) => s + t.duration, 0) - (files.length > 1 ? cfg.audio.crossfade : 0) * (files.length - 1);
  const bgImage = IMAGE_EXT.has(path.extname(bg).toLowerCase());
  const [W, H] = RESOLUTIONS[cfg.video.resolution] || [cfg.video.width, cfg.video.height];
  const work = path.join(dir, '.work');
  const ids = files.map((f) => { const st = fs.statSync(f); return [path.basename(f), st.size, st.mtimeMs]; });
  // Loudness is cached per file; the mix is reused while the same files and audio settings are used (getMix in cli.mjs).
  const loud = (() => { try { return readJson(path.join(work, 'loudness-cache.json')); } catch { return {}; } })();
  const analyzeSec = ids.reduce((s, id, i) => s + (loud[id.join('|')] ? 0 : infos[i].duration), 0);
  const mix = (() => {
    try { const k = JSON.parse(readJson(path.join(work, 'mix.json')).key);
      return !fs.existsSync(path.join(work, 'master.flac')) || JSON.stringify(k.files) !== JSON.stringify(ids) || JSON.stringify(k.audio) !== JSON.stringify(cfg.audio); }
    catch { return true; }
  })();
  const needsPrep = !bgImage || (cfg.loopTransition === 'fade-black' && cfg.loopFade > 0);
  const prepClipSec = needsPrep && !backgroundReady(cfg, work) ? (bgImage ? Math.max(5, Number(cfg.imageLoopSeconds) || 15) : (await trackInfo(bg)).duration) : 0;
  const look = { W, H, fps: await outputFps(cfg, bg, bgImage), codec: cfg.encode.codec,
    preset: cfg.visualizer?.enabled === false ? 'off' : cfg.visualizer.preset, bgImage };
  return { ...forecast(look, { total, analyzeSec, mix, prepClipSec }), total };
}
// The queue is polled every second: reuse an estimate for a few seconds.
const estCache = new Map();
async function cachedEstimate(name) {
  const hit = estCache.get(name);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  const value = await estimate(name).catch(() => null);
  estCache.set(name, { at: Date.now(), value });
  return value;
}
const clockSec = (s) => String(s || '').split(':').reduce((a, x) => a * 60 + Number(x), 0);
// Seconds left in the running full render: what remains of the current step + the forecast of the next ones.
function buildLeft(j) {
  const plan = j.plan?.parts;
  if (j.kind !== 'build' || !plan) return null;
  const order = ['analyze', 'mix', 'prep', 'render'];
  const step = /^analisando/.test(j.stage) ? 'analyze' : /^mixando/.test(j.stage) ? 'mix' : /^preparando o fundo/.test(j.stage) ? 'prep' : /^renderizando/.test(j.stage) ? 'render' : null;
  if (!step) return order.reduce((s, k) => s + plan[k], 0); // still starting (or reusing the mix)
  const inStep = (Date.now() - (j.stageAt || j.startedAt)) / 1000;
  // ffmpeg's own ETA is exact once it has run a while; before that (and for steps without one) use the forecast.
  const own = j.eta != null && (j.pct > 2 || step !== 'render') ? clockSec(j.eta) : null;
  const now = own ?? (j.pct != null ? plan[step] * (1 - j.pct / 100) : Math.max(plan[step] * 0.1, plan[step] - inStep));
  return now + order.slice(order.indexOf(step) + 1).reduce((s, k) => s + plan[k], 0);
}
async function publicQueue() {
  const running = job?.status === 'running' ? job : null;
  const estimates = await Promise.all(queue.map(async (p) => (await cachedEstimate(p))?.seconds ?? null));
  return { queue: [...queue], estimates, runningLeft: running ? buildLeft(running) : null, history };
}

function logLine(j, line) {
  const before = j.stage;
  try { logLineInner(j, line); } finally { if (j.stage !== before) j.stageAt = Date.now(); }
}
function logLineInner(j, line) {
  line = line.replace(/\s+$/, '');
  if (!line.trim()) return;
  // Progress lines ("mixando áudio: 42.0%  (95x, restante ~00:12)") update in place.
  const m = line.match(/^\s*(.+?):\s*([\d.]+)%\s*\(([^,]*),\s*restante ~([^)]*)\)/);
  if (m) {
    Object.assign(j, { stage: m[1], pct: Number(m[2]), eta: m[4] === '?' ? null : m[4] });
    if (j.log.at(-1)?.startsWith(m[1] + ':')) j.log[j.log.length - 1] = line.trim();
    else j.log.push(line.trim());
    return;
  }
  const a = line.match(/analisando faixa (\d+)\/(\d+)/);
  if (a) {
    Object.assign(j, { stage: 'analisando volume das faixas', pct: (100 * a[1]) / a[2], eta: null });
    return;
  }
  if (/^• fundo/.test(line.trim())) Object.assign(j, { stage: 'preparando o fundo (1ª vez)', pct: null, eta: null });
  j.log.push(line.trim());
}

function runCli(project, args) {
  const j = newJob(args[0], project);
  if (j.kind === 'build') {
    saveQueueState();
    // Forecast taken before the build changes the caches it looks at.
    j.plan = estCache.get(project)?.value;
    if (!j.plan) estimate(project).then((e) => (j.plan ??= e)).catch(() => {});
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), ...args], { cwd: ROOT, windowsHide: true });
  j.child = child;
  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    const parts = buf.split(/\r|\n/);
    buf = parts.pop();
    parts.forEach((l) => logLine(j, l));
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    if (buf) logLine(j, buf);
    if (j.status !== 'running') return; // canceled
    const err = j.log.filter((l) => l.startsWith('✖')).join('\n');
    finish(j, code === 0 ? 'done' : 'error', code === 0 ? null : err || `saiu com código ${code}`);
  });
  return j;
}

// Kill the whole tree (node → ffmpeg), otherwise ffmpeg keeps running orphaned.
const killTree = (pid) => new Promise((r) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => r()));

// ---------- Flow imports (network only): run alongside the render, one per project ----------
const imports = {};
const importing = (p) => imports[p]?.status === 'running';
const publicImport = (p) => {
  const x = imports[p];
  return x && { status: x.status, stage: x.stage, pct: x.pct, error: x.error, log: x.log.slice(-30), startedAt: x.startedAt, endedAt: x.endedAt };
};
const endImport = (j, status, error) => {
  Object.assign(j, { status, error, endedAt: Date.now(), pct: status === 'done' ? 100 : j.pct });
  pump(); // a queued video may have been waiting for its songs
};

/** `ids`: only these songs, in this order (picked in the app); `folder`: playlist to put them in. */
async function importFlow(name, url, { ids, folder: wanted } = {}) {
  const { cfg, dir } = loadRaw(name);
  const tracksDir = cfg.tracks || path.join(dir, 'tracks');
  if (importing(name)) throw httpError(409, 'já está importando uma playlist neste vídeo');
  if (job?.status === 'running' && job.project === name) throw httpError(409, 'espere a tarefa deste vídeo terminar para importar músicas nele');
  if (locks.has(name)) throw httpError(409, 'espere terminar a mudança nas músicas');
  fs.mkdirSync(tracksDir, { recursive: true });
  const j = (imports[name] = { status: 'running', stage: 'lendo a playlist', pct: null, log: [], startedAt: Date.now() });
  (async () => {
    try {
      j.stage = 'lendo os links do Flow';
      const found = await resolveFlow(url);
      const byId = new Map(found.clips.map((c) => [c.id, c]));
      const clips = Array.isArray(ids) ? ids.map((id) => byId.get(id)).filter(Boolean) : found.clips;
      if (!clips.length) throw new Error('nenhuma música escolhida');
      // One folder per playlist: removing it later (app or Explorer) clears exactly these songs.
      const folder = folderName(wanted) || folderName(found.name) || defaultPlaylistName();
      j.log.push(`${clips.length} música(s) → playlist "${folder}" (pasta tracks/${folder})`);
      const nums = Array.isArray(ids) ? [] : clips.map((c) => c.num).filter((n) => n != null);
      const missing = nums.length ? Array.from({ length: Math.max(...nums) }, (_, i) => i + 1).filter((n) => !nums.includes(n)) : [];
      if (missing.length) j.log.push(`⚠ faltando na playlist: ${missing.map((n) => String(n).padStart(2, '0')).join(', ')}`);
      writeJson(path.join(dir, 'flow-tracks.json'), clips.map((c) => [c.title, c.id]));
      for (const [i, c] of clips.entries()) {
        if (j.status !== 'running') return;
        Object.assign(j, { stage: `baixando ${i + 1}/${clips.length}: ${c.title}`, pct: (100 * i) / clips.length });
        const file = nextTrackName(tracksDir, c.title, '.m4a', folder);
        await download(c.url, file);
        j.log.push(`✔ ${path.basename(file)}`);
      }
      j.stage = 'músicas importadas';
      endImport(j, 'done');
    } catch (e) {
      j.log.push('✖ ' + e.message);
      endImport(j, 'error', e.message);
    }
  })();
  return j;
}

function defaultPlaylistName() {
  const d = new Date(), pad = (x) => String(x).padStart(2, '0');
  return `Playlist ${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

// ---------- YouTube uploads (network, so they can run while the GPU renders) ----------
const uploads = {};
let serverPort = 43863;
const redirectUri = () => `http://127.0.0.1:${serverPort}/api/youtube/callback`;
function publicUpload(p) {
  const u = uploads[p];
  return u && { status: u.status, pct: u.pct, sent: u.sent, size: u.size, error: u.error, warning: u.warning, stage: u.stage, startedAt: u.startedAt };
}

// YouTube takes thumbnails up to 2 MB: bigger files are re-encoded as 1280x720 JPG.
async function thumbForUpload(dir) {
  const t = fs.readdirSync(dir).find((x) => /^thumbnail\.(jpe?g|png)$/i.test(x));
  if (!t) return null;
  const f = path.join(dir, t);
  if (fs.statSync(f).size <= 2_000_000) return f;
  const out = path.join(dir, '.work', 'thumbnail_yt.jpg');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await ffmpeg(['-i', f, '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2', '-q:v', '3', out]);
  return out;
}

async function preflight(p, meta = {}) {
  const { dir, cfg, project } = loadRaw(p);
  const video = path.join(dir, 'output', 'video.mp4');
  const errors = [], warnings = [], info = {};
  const state = readRenderState(dir, cfg);
  if (!fs.existsSync(video)) errors.push('Gere o vídeo completo antes de publicar.');
  if (state.status === 'stale') warnings.push('O vídeo pronto não corresponde às configurações ou mídias atuais. Renderize novamente.');
  if (state.status === 'unknown') warnings.push('Não foi possível confirmar se este vídeo corresponde às configurações atuais (render antigo).');
  if (!project.channel || !yt.status(project.channel).connected) errors.push('Conecte o canal ao YouTube.');
  if (!String(meta.title || project.title || '').trim()) errors.push('O título está vazio.');
  if (String(meta.title || project.title || '').length > 100) errors.push('O título ultrapassa 100 caracteres.');
  if (String(meta.description || '').length > 5000) errors.push('A descrição ultrapassa 5.000 caracteres.');
  const thumb = fs.readdirSync(dir).find((x) => /^thumbnail\.(jpe?g|png)$/i.test(x));
  if (!thumb) warnings.push('Nenhuma thumbnail foi adicionada.');
  else {
    try {
      const t = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path.join(dir, thumb)])).stdout).streams?.[0];
      if (!t?.width || !t?.height) warnings.push('A thumbnail não pôde ser lida.');
      else if (t.width < 1280 || t.height < 720 || Math.abs(t.width / t.height - 16 / 9) > 0.02)
        warnings.push(`Thumbnail ${t.width}×${t.height}: prefira 1280×720 (16:9).`);
    } catch { warnings.push('A thumbnail não pôde ser verificada.'); }
  }
  if (video && fs.existsSync(video)) {
    try {
      const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video])).stdout);
      const v = probe.streams?.find((s) => s.codec_type === 'video'), a = probe.streams?.find((s) => s.codec_type === 'audio');
      info.duration = Number(probe.format?.duration) || 0;
      info.resolution = v ? `${v.width}×${v.height}` : null;
      info.videoCodec = v?.codec_name; info.audioCodec = a?.codec_name;
      if (!v) errors.push('O MP4 não contém vídeo.');
      if (!a) errors.push('O MP4 não contém áudio.');
      if (!(info.duration > 0)) errors.push('A duração do MP4 é inválida.');
      if (v && (v.width < 1280 || v.height < 720)) warnings.push('A resolução está abaixo de 720p.');
      const files = listTracks(cfg.tracks || path.join(dir, 'tracks'));
      if (files.length) {
        const lengths = await Promise.all(files.map((f) => duration(f)));
        const expected = lengths.reduce((s, x) => s + x, 0) - Math.max(0, files.length - 1) * (cfg.audio?.crossfade || 0);
        info.expectedDuration = expected;
        if (Math.abs(info.duration - expected) > Math.max(5, expected * 0.01)) warnings.push(`Duração do vídeo (${fmtTime(info.duration)}) difere da soma das faixas (${fmtTime(expected)}).`);
      }
      if (v && a && info.duration > 6) {
        const sampleAt = Math.max(0, info.duration / 2 - 2);
        const { stderr } = await run('ffmpeg', ['-hide_banner', '-ss', String(sampleAt), '-i', video, '-t', '4',
          '-vf', 'blackdetect=d=1:pix_th=0.08', '-af', 'silencedetect=n=-50dB:d=1', '-f', 'null', '-']);
        if (/black_start:/.test(stderr)) warnings.push('Foi detectado um trecho escuro no meio do vídeo; confira se é intencional.');
        if (/silence_start:/.test(stderr)) warnings.push('Foi detectado silêncio no meio do vídeo; confira se é intencional.');
      }
    } catch (e) { errors.push(`Não foi possível verificar o MP4: ${e.message}`); }
  }
  return { ok: !errors.length, errors, warnings, info, renderState: state };
}

async function startPublish(p, meta) {
  const dir = projectDir(p);
  const { project } = loadRaw(p);
  const video = path.join(dir, 'output', 'video.mp4');
  const sessionFile = path.join(dir, '.work', 'upload-session.json');
  if (!fs.existsSync(video)) throw httpError(400, 'gere o vídeo completo antes de enviar');
  const resume = meta.resume ? (() => { try { return readJson(sessionFile); } catch { throw httpError(400, 'não há envio para retomar'); } })() : null;
  if (resume) {
    const st = fs.statSync(video);
    if (resume.channel !== project.channel || resume.size !== st.size || resume.mtimeMs !== st.mtimeMs)
      throw httpError(409, 'o vídeo ou canal mudou desde o envio interrompido; descarte a sessão e envie novamente');
    meta = { ...resume.meta, resume: true, confirmWarnings: meta.confirmWarnings };
  }
  if (!project.channel || !yt.status(project.channel).connected) throw httpError(400, 'conecte o canal ao YouTube primeiro');
  if (uploads[p]?.status === 'running') throw httpError(409, 'este vídeo já está sendo enviado');
  if (job?.status === 'running' && job.project === p && job.kind === 'build') throw httpError(409, 'espere o render deste vídeo terminar');
  if (!meta.title?.trim()) throw httpError(400, 'o título está vazio');
  if (meta.publishAt && new Date(meta.publishAt) < new Date(Date.now() + 15 * 60 * 1000)) throw httpError(400, 'o agendamento precisa ser pelo menos 15 minutos no futuro');
  const check = await preflight(p, meta);
  if (!check.ok) throw httpError(400, check.errors.join(' '));
  if (check.warnings.length && !meta.confirmWarnings) throw httpError(409, 'Confirme os avisos da verificação antes de publicar.');
  const u = (uploads[p] = { status: 'running', pct: 0, sent: 0, size: fs.statSync(video).size, stage: 'enviando o vídeo', abort: new AbortController(), startedAt: Date.now() });
  (async () => {
    try {
      const id = await yt.uploadVideo(project.channel, video, meta, {
        signal: u.abort.signal,
        onProgress: (sent, size) => Object.assign(u, { sent, pct: (100 * sent) / size }),
        resumeState: resume,
        onSession: ({ session, offset }) => {
          fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
          const st = fs.statSync(video);
          writeJson(sessionFile, { session, offset, size: st.size, mtimeMs: st.mtimeMs, channel: project.channel,
            meta: { title: meta.title, description: meta.description, tags: meta.tags, privacy: meta.privacy, publishAt: meta.publishAt },
            startedAt: resume?.startedAt || Date.now() });
        },
      });
      fs.rmSync(sessionFile, { force: true });
      const result = { videoId: id, url: `https://youtu.be/${id}`, studio: `https://studio.youtube.com/video/${id}/edit`,
        ytChannel: yt.status(project.channel).ytChannel, privacy: meta.publishAt ? 'scheduled' : meta.privacy, publishAt: meta.publishAt || null,
        uploadedAt: new Date().toISOString() };
      const thumb = await thumbForUpload(dir);
      if (thumb) {
        u.stage = 'enviando a thumbnail';
        try { await yt.setThumbnail(project.channel, id, thumb); result.thumbnail = true; }
        catch (e) { u.warning = e.message; result.thumbnail = false; }
      }
      writeJson(path.join(dir, 'youtube.json'), result);
      Object.assign(u, { status: 'done', pct: 100, stage: 'pronto' });
    } catch (e) {
      Object.assign(u, { status: u.abort.signal.aborted ? 'canceled' : 'error', error: e.message });
    }
  })();
}

// ---------- http -------------------------------------------------------------------------
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

function serveFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'arquivo não encontrado' });
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
}

let lastSeen = Date.now(); // last request from an open window (see startServer's "window" mode)
async function handle(req, res) {
  lastSeen = Date.now();
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const M = req.method;

  if (url.pathname === '/' ) return send(res, 200, fs.readFileSync(UI, 'utf8'), 'text/html; charset=utf-8');
  if (parts[0] === 'asset') {
    // Images inside the program folder (channel reminder images).
    const f = path.resolve(url.searchParams.get('f') || '');
    if (!f.startsWith(ROOT + path.sep) || !IMAGE_EXT.has(path.extname(f).toLowerCase()) && path.extname(f).toLowerCase() !== '.gif')
      return send(res, 403, { error: 'arquivo não permitido' });
    return serveFile(req, res, f);
  }
  if (url.pathname === '/favicon.ico') return serveFile(req, res, path.join(path.dirname(UI), 'icon.ico'));
  if (parts[0] === 'font') {
    const f = url.searchParams.get('f') || '';
    if (!/\.(ttf|otf)$/i.test(f)) return send(res, 400, { error: 'fonte inválida' });
    return serveFile(req, res, f);
  }
  if (parts[0] === 'visual') {
    const name = url.searchParams.get('name') || '';
    if (name !== path.basename(name) || !VISUAL_EXT.has(path.extname(name).toLowerCase())) return send(res, 400, { error: 'visual inválido' });
    return serveFile(req, res, path.join(VISUALS, name));
  }
  if (parts[0] === 'visual-thumb') {
    const name = url.searchParams.get('name') || '';
    if (name !== path.basename(name) || !VISUAL_EXT.has(path.extname(name).toLowerCase())) return send(res, 400, { error: 'visual inválido' });
    return serveFile(req, res, path.join(VISUALS, '.thumbs', `${name}.jpg`));
  }
  if (parts[0] === 'media') {
    const dir = projectDir(parts[1]);
    const file = path.resolve(dir, parts.slice(2).join('/'));
    const cfgBg = loadRaw(parts[1]).cfg.background;
    // Only files inside the project (or its configured background, which may live elsewhere).
    if (!file.startsWith(dir + path.sep) && file !== cfgBg) return send(res, 403, { error: 'fora do projeto' });
    return serveFile(req, res, file);
  }
  if (parts[0] !== 'api') return send(res, 404, { error: 'não encontrado' });

  const [, a, p, b, c] = parts;
  const busy = job?.status === 'running' || Object.keys(imports).some(importing);
  if (a === 'version' && M === 'GET') return send(res, 200, { app: 'msc-studio', version: VERSION, busy });
  if (a === 'shutdown' && M === 'POST') {
    if (busy) return send(res, 409, { error: 'renderizando ou importando' });
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 200);
    return;
  }
  // ---- YouTube ----
  if (a === 'youtube' && p === 'credentials' && M === 'POST') {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    yt.saveCredentials(Buffer.concat(chunks));
    return send(res, 200, { ok: true });
  }
  if (a === 'youtube' && p === 'connect' && M === 'GET') {
    const ch = url.searchParams.get('channel');
    channelFile(ch);
    res.writeHead(302, { location: yt.authUrl(ch, redirectUri()) });
    return res.end();
  }
  if (a === 'youtube' && p === 'callback' && M === 'GET') {
    const esc = (x) => String(x).replace(/[<>&"]/g, '');
    const page = (msg, ok) => send(res, 200, `<!doctype html><meta charset="utf-8"><title>Music Studio</title><body style="font:16px Segoe UI;background:#14110f;color:#f3ebe1;display:grid;place-items:center;height:90vh;text-align:center"><div><h2 style="color:${ok ? '#8fcf9a' : '#ef8a7a'}">${esc(msg)}</h2><p>Pode fechar esta aba e voltar ao Music Studio.</p></div>`, 'text/html; charset=utf-8');
    const err = url.searchParams.get('error');
    if (err) return page(err === 'access_denied' ? 'Conexão cancelada' : `Erro: ${err}`, false);
    try {
      const ch = url.searchParams.get('state');
      channelFile(ch);
      const info = await yt.finishConnect(ch, url.searchParams.get('code'), redirectUri());
      return page(`✓ Conectado ao canal "${info.title}"`, true);
    } catch (e) { return page(e.message, false); }
  }
  if (a === 'youtube' && p === 'disconnect' && M === 'POST') {
    const { channel } = await readBody(req);
    channelFile(channel);
    yt.disconnect(channel);
    return send(res, 200, yt.status(channel));
  }
  if (a === 'youtube' && p === 'status' && M === 'GET') {
    const ch = url.searchParams.get('channel');
    return send(res, 200, ch ? yt.status(ch) : { configured: !!yt.client() });
  }
  if (a === 'fonts' && M === 'GET') return send(res, 200, { fonts: listFonts(ROOT, { refresh: url.searchParams.has('refresh') }) });
  if (a === 'fonts' && p === 'missing' && M === 'POST') {
    // [{ font, text }] -> characters each font can't draw (they'd be boxes in the video)
    const { checks = [] } = await readBody(req);
    return send(res, 200, { missing: checks.map((x) => (/\.(ttf|otf)$/i.test(x?.font || '') ? missingGlyphs(x.font, x.text || '') : [])) });
  }
  if (a === 'visuals' && M === 'GET') return send(res, 200, { visuals: listVisuals() });
  if (a === 'visuals' && M === 'POST') {
    const fname = path.basename(url.searchParams.get('name') || '');
    const ext = path.extname(fname).toLowerCase();
    if (!VISUAL_EXT.has(ext)) throw httpError(400, 'use imagem PNG/JPG/WebP ou vídeo MP4/MOV/WebM/MKV');
    fs.mkdirSync(VISUALS, { recursive: true });
    const tmp = path.join(VISUALS, `.import-${crypto.randomUUID()}.tmp`);
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      if (!fs.statSync(tmp).size) throw httpError(400, 'arquivo vazio');
      const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', tmp]).catch(() => null);
      if (!probe?.stdout?.includes('video')) throw httpError(400, 'imagem ou vídeo inválido');
      const stem = path.parse(fname).name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'visual';
      const digest = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(tmp)) digest.update(chunk);
      const hash = digest.digest('hex').slice(0, 12);
      const dest = path.join(VISUALS, `${stem}-${hash}${ext}`);
      if (!fs.existsSync(dest)) fs.renameSync(tmp, dest);
      if (!IMAGE_EXT.has(ext)) {
        const thumbs = path.join(VISUALS, '.thumbs');
        fs.mkdirSync(thumbs, { recursive: true });
        const thumb = path.join(thumbs, `${path.basename(dest)}.jpg`);
        if (!fs.existsSync(thumb)) await ffmpeg(['-i', dest, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '3', thumb]).catch(() => {});
      }
      return send(res, 200, { name: path.basename(dest), visuals: listVisuals() });
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  if (a === 'fonts' && M === 'POST') {
    const fname = path.basename(url.searchParams.get('name') || '');
    if (!/\.(ttf|otf)$/i.test(fname)) throw httpError(400, 'escolha um arquivo de fonte .ttf ou .otf');
    if (Number(req.headers['content-length']) > 25 * 1024 * 1024) throw httpError(413, 'fonte muito grande (máximo 25 MB)');
    const dir = path.join(ROOT, 'fonts');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.import-${crypto.randomUUID()}.tmp`);
    let file;
    try {
      await pipeline(req, fs.createWriteStream(tmp));
      if (fs.statSync(tmp).size > 25 * 1024 * 1024) throw httpError(413, 'fonte muito grande (máximo 25 MB)');
      if (!fontName(tmp)) throw httpError(400, 'arquivo de fonte inválido ou incompatível');
      const hash = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex').slice(0, 12);
      const stem = path.parse(fname).name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'fonte';
      file = path.join(dir, `${stem}-${hash}${path.extname(fname).toLowerCase()}`);
      if (!fs.existsSync(file)) fs.renameSync(tmp, file);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    return send(res, 200, { file: file.replaceAll('\\', '/'), fonts: listFonts(ROOT, { refresh: true }) });
  }
  if (a === 'state' && M === 'GET') return send(res, 200, { channels: channels(), unconfiguredChannelFolders: unconfiguredChannelFolders(), invalidChannelFolders: invalidChannelFolders(), projects: listProjects(), job: publicJob(), ...(await publicQueue()) });
  if (a === 'queue' && !p && M === 'POST') {
    const { project } = await readBody(req);
    projectDir(project);
    if (queue.includes(project) || (job?.status === 'running' && job.kind === 'build' && job.project === project)) throw httpError(409, 'este vídeo já está na fila');
    checkRenderable(project);
    queue.push(project);
    saveQueueState();
    pump();
    return send(res, 200, { job: publicJob(), ...(await publicQueue()) });
  }
  if (a === 'queue' && p === 'clear' && M === 'POST') { queue.length = 0; saveQueueState(); return send(res, 200, await publicQueue()); }
  if (a === 'queue' && p != null && M === 'DELETE') { queue.splice(Number(p), 1); saveQueueState(); return send(res, 200, await publicQueue()); }
  if (a === 'queue' && p != null && b === 'up' && M === 'POST') {
    const i = Number(p);
    if (i > 0 && i < queue.length) [queue[i - 1], queue[i]] = [queue[i], queue[i - 1]];
    saveQueueState();
    return send(res, 200, await publicQueue());
  }
  if (a === 'job' && M === 'GET') return send(res, 200, { job: publicJob(), ...(await publicQueue()) });
  if (a === 'job' && p === 'cancel' && M === 'POST') {
    if (job?.status === 'running') {
      finish(job, 'canceled', 'cancelado');
      if (job.child) await killTree(job.child.pid);
      // Drop the half-written render (the previous finished file is untouched).
      const out = path.join(PROJECTS, job.project, 'output');
      for (const f of fs.existsSync(out) ? fs.readdirSync(out) : []) if (f.endsWith('.tmp.mp4')) fs.rmSync(path.join(out, f), { force: true });
    }
    return send(res, 200, { job: publicJob() });
  }
  if (a === 'channels' && !p && M === 'POST') return send(res, 200, { id: createChannel(await readBody(req)) });
  if (a === 'channels' && p && b === 'presets' && M === 'GET') return send(res, 200, { presets: listPresets(p) });
  if (a === 'channels' && p && b === 'presets' && M === 'POST') return send(res, 200, { id: savePreset(p, await readBody(req)) });
  if (a === 'channels' && p && !b && M === 'GET') return send(res, 200, channelView(p));
  if (a === 'channels' && p && b === 'overlay' && M === 'POST') {
    // Reminder image belongs to the channel: channels/<id>/overlay.<ext>
    const ext = path.extname(url.searchParams.get('name') || '').toLowerCase();
    if (!['.png', '.gif', '.webp', '.jpg', '.jpeg'].includes(ext)) throw httpError(400, 'use PNG (fundo transparente) ou GIF animado');
    const cf = channelFile(p);
    const dir = path.dirname(cf);
    const tmp = path.join(dir, `overlay.upload${ext}`);
    await pipeline(req, fs.createWriteStream(tmp));
    for (const x of fs.readdirSync(dir)) if (/^overlay\.[a-z]+$/i.test(x)) fs.rmSync(path.join(dir, x));
    fs.renameSync(tmp, path.join(dir, `overlay${ext}`));
    const ch = readJson(cf);
    ch.overlay = { ...(ch.overlay || {}), image: `overlay${ext}`, enabled: true };
    writeJson(cf, ch);
    return send(res, 200, { ok: true });
  }
  // ---- channel intro (green-screen clip): channels/<id>/intro.<ext> ----
  if (a === 'channels' && p && b === 'intro' && !c && M === 'POST') {
    const ext = path.extname(url.searchParams.get('name') || '').toLowerCase();
    if (!['.mp4', '.mov', '.webm', '.mkv', '.m4v'].includes(ext)) throw httpError(400, 'use um vídeo (MP4, MOV, WebM ou MKV)');
    const cf = channelFile(p), dir = path.dirname(cf);
    const tmp = path.join(dir, `.intro-upload${ext}`);
    await pipeline(req, fs.createWriteStream(tmp));
    if (!(await hasVideoStream(tmp).catch(() => false))) { fs.rmSync(tmp, { force: true }); throw httpError(400, 'o arquivo não contém vídeo'); }
    // The key color is read from the clip's corners (green and blue screens both work).
    const color = await screenColor(tmp).catch(() => '#00FF00');
    for (const x of fs.readdirSync(dir)) if (/^intro\.[a-z0-9]+$/i.test(x)) fs.rmSync(path.join(dir, x));
    fs.renameSync(tmp, path.join(dir, `intro${ext}`));
    const ch = readJson(cf);
    ch.intro = { ...(ch.intro || {}), file: `intro${ext}`, enabled: true, color };
    writeJson(cf, ch);
    return send(res, 200, { ok: true, color });
  }
  if (a === 'channels' && p && b === 'intro' && !c && M === 'DELETE') {
    const cf = channelFile(p), dir = path.dirname(cf);
    for (const x of fs.readdirSync(dir)) if (/^intro\.[a-z0-9]+$/i.test(x)) try { fs.rmSync(path.join(dir, x)); } catch { throw httpError(409, 'a intro está aberta em outro programa'); }
    const ch = readJson(cf);
    ch.intro = { ...(ch.intro || {}), file: null, enabled: false };
    writeJson(cf, ch);
    return send(res, 200, { ok: true });
  }
  if (a === 'channels' && p && b === 'intro' && c === 'frame' && M === 'GET') {
    // One frame of the intro with the key applied, as a transparent PNG (the page draws a checkerboard behind).
    const file = channelConfig(p).intro?.file;
    if (!file || !fs.existsSync(file)) throw httpError(404, 'este canal não tem intro');
    const q = (k, d) => (Number.isFinite(Number(url.searchParams.get(k))) && url.searchParams.get(k) !== null ? Number(url.searchParams.get(k)) : d);
    const hex = String(url.searchParams.get('color') || '#00FF00').replace(/[^0-9a-f]/gi, '').padStart(6, '0').slice(0, 6);
    const at = Math.max(0, (await duration(file).catch(() => 0)) * Math.min(0.99, Math.max(0, q('at', 0.5))));
    const out = path.join(os.tmpdir(), `msc-intro-${process.pid}-${Date.now()}.png`);
    try {
      await ffmpeg(['-ss', at.toFixed(2), '-i', file, '-vf',
        `scale=640:360:force_original_aspect_ratio=decrease,format=yuva444p,chromakey=color=0x${hex}:similarity=${q('similarity', 0.3)}:blend=${q('blend', 0.08)},format=rgba`,
        '-frames:v', '1', out]);
      return send(res, 200, fs.readFileSync(out), 'image/png');
    } finally { fs.rmSync(out, { force: true }); }
  }
  if (a === 'channels' && p && M === 'PUT') {
    updateChannel(p, await readBody(req));
    return send(res, 200, channelView(p));
  }
  if (a === 'projects' && !p && M === 'POST') return send(res, 200, { name: createProject(await readBody(req)) });
  if (a !== 'projects' || !p) return send(res, 404, { error: 'rota desconhecida' });

  if (!b && M === 'GET') return send(res, 200, await projectView(p));
  if (!b && M === 'PUT') {
    saveProject(p, await readBody(req));
    return send(res, 200, await projectView(p));
  }
  if (b === 'channel-look' && M === 'POST') {
    saveChannelLook(p, await readBody(req));
    return send(res, 200, await projectView(p));
  }
  if (b === 'preset' && M === 'POST') {
    applyPreset(p, (await readBody(req)).id);
    return send(res, 200, await projectView(p));
  }
  if (b === 'storage' && M === 'GET') return send(res, 200, storageView(p));
  if (b === 'storage' && M === 'POST') return send(res, 200, cleanStorage(p, await readBody(req)));
  if (b === 'compare' && c === 'capture' && M === 'POST') {
    const { slot, settings } = await readBody(req);
    if (!['a', 'b'].includes(slot) || !settings || typeof settings !== 'object') throw httpError(400, 'opção inválida');
    const file = path.join(projectDir(p), '.work', 'compare-settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let saved = {}; try { saved = readJson(file); } catch {}
    saved[slot] = Object.fromEntries(EDITABLE.filter((k) => k in settings).map((k) => [k, settings[k]]));
    writeJson(file, saved);
    return send(res, 200, { slots: { a: !!saved.a, b: !!saved.b } });
  }
  if (b === 'center-image' && M === 'DELETE') {
    const { dir, project } = loadRaw(p);
    writeJson(path.join(dir, 'project.json'), { ...project, visualizer: { ...project.visualizer, centerImage: null } });
    return send(res, 200, await projectView(p));
  }
  if (b === 'center-image' && M === 'POST') {
    const { dir, project } = loadRaw(p);
    let image;
    if ((req.headers['content-type'] || '').includes('application/json')) {
      const name = (await readBody(req)).name;
      if (typeof name !== 'string' || name !== path.basename(name) || !IMAGE_EXT.has(path.extname(name).toLowerCase())) throw httpError(400, 'escolha uma imagem da biblioteca');
      image = path.join(VISUALS, name);
      if (!fs.existsSync(image)) throw httpError(404, 'imagem não encontrada');
    } else {
      const ext = path.extname(url.searchParams.get('name') || '').toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw httpError(400, 'use uma foto PNG, JPG ou WebP');
      const tmp = path.join(dir, `center-image.upload${ext}`);
      try {
        await pipeline(req, fs.createWriteStream(tmp));
        const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', tmp]).catch(() => null);
        if (!probe?.stdout?.includes('video')) throw httpError(400, 'foto inválida');
        image = path.join(dir, `center-image${ext}`);
        fs.renameSync(tmp, image);
      } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    }
    writeJson(path.join(dir, 'project.json'), { ...project, visualizer: { ...project.visualizer, centerImage: image.replaceAll('\\', '/') } });
    return send(res, 200, await projectView(p));
  }
  if (b === 'visual' && M === 'POST') {
    const name = (await readBody(req)).name;
    if (typeof name !== 'string' || name !== path.basename(name) || !VISUAL_EXT.has(path.extname(name).toLowerCase())) throw httpError(400, 'visual inválido');
    const file = path.join(VISUALS, name);
    if (!fs.existsSync(file)) throw httpError(404, 'visual não encontrado');
    const { dir, project } = loadRaw(p);
    writeJson(path.join(dir, 'project.json'), { ...project, background: file.replaceAll('\\', '/') });
    return send(res, 200, await projectView(p));
  }
  if (b === 'ambience' && M === 'DELETE') {
    if (job?.status === 'running' && job.project === p) throw httpError(409, 'espere a tarefa deste vídeo terminar');
    const { dir, project } = loadRaw(p);
    const old = project.audio?.ambience?.file;
    writeJson(path.join(dir, 'project.json'), { ...project, audio: { ...project.audio, ambience: null } });
    if (old && /^ambience-[\w-]+\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(old)) {
      const owned = path.resolve(dir, old);
      if (path.dirname(owned) === dir) try { fs.rmSync(owned, { force: true }); } catch { /* player may still hold the file on Windows */ }
    }
    return send(res, 200, await projectView(p));
  }
  if (b === 'upload' && M === 'POST') {
    const kind = url.searchParams.get('kind');
    const fname = path.basename(url.searchParams.get('name') || '');
    const ext = path.extname(fname).toLowerCase();
    const { dir, cfg, project } = loadRaw(p);
    if (kind === 'background') {
      if (!IMAGE_EXT.has(ext) && !['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) throw httpError(400, 'use um vídeo (mp4) ou imagem (png/jpg)');
      const tmp = path.join(dir, `background.upload${ext}`);
      await pipeline(req, fs.createWriteStream(tmp));
      for (const f of fs.readdirSync(dir)) if (/^background\.[a-z0-9]+$/i.test(f)) fs.rmSync(path.join(dir, f));
      fs.renameSync(tmp, path.join(dir, `background${ext}`));
      writeJson(path.join(dir, 'project.json'), { ...project, background: `background${ext}` });
    } else if (kind === 'ambience') {
      if (job?.status === 'running' && job.project === p) throw httpError(409, 'espere a tarefa deste vídeo terminar');
      if (!AUDIO_EXT.has(ext)) throw httpError(400, `formato de áudio não suportado: ${ext}`);
      const tmp = path.join(dir, `.ambience-upload-${crypto.randomUUID()}${ext}`);
      try {
        await pipeline(req, fs.createWriteStream(tmp));
        const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', tmp]).catch(() => null);
        if (!probe?.stdout?.includes('audio')) throw httpError(400, 'o arquivo não contém áudio válido');
        const owned = `ambience-${crypto.randomUUID()}${ext}`;
        fs.renameSync(tmp, path.join(dir, owned));
        const old = project.audio?.ambience?.file;
        const volumeDb = Number.isFinite(cfg.audio?.ambience?.volumeDb) ? cfg.audio.ambience.volumeDb : -22;
        const fadeIn = Number(cfg.audio?.ambience?.fadeIn) || 0;
        const fadeOut = Number(cfg.audio?.ambience?.fadeOut) || 0;
        writeJson(path.join(dir, 'project.json'), { ...project, audio: { ...project.audio,
          ambience: { file: owned, volumeDb, fadeIn, fadeOut, enabled: true } } });
        if (old && /^ambience-[\w-]+\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(old)) {
          const oldPath = path.resolve(dir, old);
          if (path.dirname(oldPath) === dir) try { fs.rmSync(oldPath, { force: true }); } catch { /* retry can be done after closing the player */ }
        }
      } finally { fs.rmSync(tmp, { force: true }); }
    } else if (kind === 'track') {
      if (!AUDIO_EXT.has(ext)) throw httpError(400, `formato de áudio não suportado: ${ext}`);
      const tracksDir = cfg.tracks || path.join(dir, 'tracks');
      fs.mkdirSync(tracksDir, { recursive: true });
      // Receive first, then name it inside the lock (two uploads must not pick the same number).
      const part = path.join(tracksDir, `.upload-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      await pipeline(req, fs.createWriteStream(part));
      await trackOp(p, () => fs.renameSync(part, nextTrackName(tracksDir, titleFromFile(fname), ext))).catch((e) => {
        fs.rmSync(part, { force: true });
        throw e;
      });
    } else throw httpError(400, 'tipo de upload desconhecido');
    return send(res, 200, await projectView(p));
  }
  if (b === 'tracks' && c && M === 'DELETE') {
    await trackOp(p, () => trashTrack(p, c));
    return send(res, 200, await projectView(p));
  }
  if (b === 'tracks' && !c && M === 'DELETE') { // every song of this video (to start the next one); undoable
    await trackOp(p, () => { const d = loadRaw(p).cfg.tracks || path.join(projectDir(p), 'tracks'); trashTracks(p, listTracks(d).map((f) => trackId(d, f))); });
    return send(res, 200, await projectView(p));
  }
  if (b === 'playlists' && c && M === 'POST') {
    const { name: to } = await readBody(req);
    await trackOp(p, () => renamePlaylist(p, c, to));
    return send(res, 200, await projectView(p));
  }
  if (b === 'playlists' && c && M === 'DELETE') {
    await trackOp(p, () => trashPlaylist(p, c));
    return send(res, 200, await projectView(p));
  }
  if (b === 'thumbnail' && M === 'POST') {
    const dir = projectDir(p);
    const ext = path.extname(url.searchParams.get('name') || '').toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) throw httpError(400, 'a thumbnail precisa ser JPG ou PNG');
    const tmp = path.join(dir, `thumbnail.upload${ext}`);
    await pipeline(req, fs.createWriteStream(tmp));
    for (const x of fs.readdirSync(dir)) if (/^thumbnail\.(jpe?g|png)$/i.test(x)) fs.rmSync(path.join(dir, x));
    fs.renameSync(tmp, path.join(dir, `thumbnail${ext}`));
    return send(res, 200, await projectView(p));
  }
  if (b === 'publish' && c === 'cancel' && M === 'POST') {
    uploads[p]?.abort.abort();
    fs.rmSync(path.join(projectDir(p), '.work', 'upload-session.json'), { force: true });
    return send(res, 200, await projectView(p));
  }
  if (b === 'publish' && c === 'discard' && M === 'POST') {
    if (uploads[p]?.status === 'running') throw httpError(409, 'cancele o envio atual primeiro');
    fs.rmSync(path.join(projectDir(p), '.work', 'upload-session.json'), { force: true });
    return send(res, 200, await projectView(p));
  }
  if (b === 'publish' && !c && M === 'POST') {
    await startPublish(p, await readBody(req));
    return send(res, 200, await projectView(p));
  }
  if (b === 'preflight' && M === 'POST') return send(res, 200, await preflight(p, await readBody(req)));
  if (b === 'tracks' && c === 'restore' && M === 'POST') {
    const body = await readBody(req);
    await trackOp(p, () => restoreTrack(p, body));
    return send(res, 200, await projectView(p));
  }
  if (b === 'tracks' && !c && M === 'POST') {
    const body = await readBody(req);
    await trackOp(p, () => reorderTracks(p, body));
    return send(res, 200, await projectView(p));
  }
  if (b === 'flow' && c === 'cancel' && M === 'POST') {
    if (importing(p)) endImport(imports[p], 'canceled', 'cancelado');
    return send(res, 200, await projectView(p));
  }
  if (b === 'flow' && c === 'preview' && M === 'POST') {
    // Lists the songs behind the pasted links, so the user picks what to import and where.
    const found = await resolveFlow((await readBody(req)).url).catch((e) => { throw httpError(400, e.message); });
    return send(res, 200, { name: found.name, suggested: folderName(found.name) || defaultPlaylistName(),
      clips: found.clips.map(({ id, title, duration }) => ({ id, title, duration })) });
  }
  if (b === 'flow' && M === 'POST') {
    const { url, ids, folder } = await readBody(req);
    await importFlow(p, url, { ids, folder });
    return send(res, 200, await projectView(p));
  }
  if (b === 'run' && M === 'POST') {
    const { cmd, start, length } = await readBody(req);
    if (!['preview', 'build', 'overlay', 'compare'].includes(cmd)) throw httpError(400, 'comando inválido');
    if (locks.has(p)) throw httpError(409, 'espere terminar a mudança nas músicas');
    if (importing(p)) throw httpError(409, 'espere a importação da playlist terminar');
    const { cfg } = loadRaw(p);
    if (!cfg.background || !fs.existsSync(cfg.background)) throw httpError(400, 'escolha um fundo antes de renderizar');
    const args = ['preview', 'compare'].includes(cmd) ? [cmd, p, String(Math.max(0, Number(start) || 0)), String(Math.min(120, Number(length) || 20))] : [cmd, p];
    runCli(p, args);
    return send(res, 200, { job: publicJob() });
  }
  if (b === 'open' && M === 'POST') {
    const { what } = await readBody(req);
    const dir = projectDir(p);
    const target = what === 'output' ? path.join(dir, 'output') : what === 'tracks' ? path.join(dir, 'tracks') : dir;
    fs.mkdirSync(target, { recursive: true });
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'rota desconhecida' });
}

// Edge (or Chrome) in "app" mode: the studio opens in its own window, without tabs or address bar.
function appBrowser() {
  for (const rel of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe'])
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA])
      if (base && fs.existsSync(path.join(base, rel))) return path.join(base, rel);
  return null;
}
const busyNow = () => job?.status === 'running' || queue.length > 0 || Object.keys(imports).some(importing) ||
  Object.values(uploads).some((u) => u.status === 'running');

/** `window`: open as a desktop-style window and quit once no window is open and nothing is running. */
export function startServer({ port = Number(process.env.MSC_PORT) || 43863, open = true, window = false } = {}) {
  const server = http.createServer((req, res) =>
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.destroy();
    }),
  );
  const requestedUrl = `http://127.0.0.1:${port}`;
  const openBrowser = (url) => {
    if (!open) return;
    const exe = window && appBrowser();
    // Own browser profile: the window is independent from the user's normal browser and its tabs.
    if (exe) spawn(exe, [`--app=${url}`, `--user-data-dir=${path.join(process.env.LOCALAPPDATA || ROOT, 'msc-studio', 'janela')}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=1500,960'], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  };
  let retried = false;
  server.on('error', async (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    // Only another Music Studio instance may be opened or asked to shut down.
    const old = await fetch(`${requestedUrl}/api/version`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (old?.app === 'msc-studio' && (old.version === VERSION || old.busy)) {
      console.log(old.busy ? 'O app aberto está renderizando um vídeo — abrindo ele.' : `O app já está aberto em ${requestedUrl}`);
      openBrowser(requestedUrl);
      return setTimeout(() => process.exit(0), 500);
    }
    if (old?.app === 'msc-studio' && !retried) {
      console.log('Atualizando o app aberto para a versão nova…');
      await fetch(`${requestedUrl}/api/shutdown`, { method: 'POST' }).catch(() => {});
      retried = true;
      return setTimeout(() => server.listen(port, '127.0.0.1'), 800);
    }
    // Another program owns the port (or the old instance did not release it): use a free one.
    if (port === 0) throw e;
    console.log(`A porta ${port} está ocupada — procurando uma porta livre para o Music Studio…`);
    server.listen(0, '127.0.0.1');
  });
  server.on('listening', () => {
    serverPort = server.address().port;
    const url = `http://127.0.0.1:${serverPort}`;
    console.log(`\n  🎵 Music Studio rodando em ${url}`);
    console.log('  Deixe esta janela aberta enquanto usa o app. Para fechar: Ctrl+C ou feche a janela.\n');
    openBrowser(url);
    pump();
    // The page pings every minute: with no window for 3 min and nothing rendering, importing or uploading, quit.
    // A queue left running keeps the app alive until the last video is done.
    if (window) setInterval(() => { if (!busyNow() && Date.now() - lastSeen > 3 * 60 * 1000) process.exit(0); }, 30 * 1000);
  });
  server.listen(port, '127.0.0.1');
  const cleanup = async () => {
    if (job?.status === 'running' && job.child) await killTree(job.child.pid);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGBREAK', cleanup);
  return server;
}
