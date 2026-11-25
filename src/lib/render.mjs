import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, hasVideoStream, hasAudioStream, duration, frameRate, progressPrinter, videoEncodeArgs } from './ffmpeg.mjs';
import { once } from 'node:events';
import { buildVisualizer } from './visualizer.mjs';
import { RADIAL_STYLES } from './shapes.mjs';
import { bandFrames } from './spectrum.mjs';
import { fileIdentity } from './project-state.mjs';
import crypto from 'node:crypto';
import { missingGlyphs } from './fonts.mjs';
import { recordSpeed, renderKey } from './speed.mjs';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const isNewer = (a, b) => fs.existsSync(a) && fs.statSync(a).mtimeMs >= fs.statSync(b).mtimeMs;
// A prepared file is reused only if it is newer than its source AND opens: a prep cut short by an
// older version (cancel, app closed) left half-written MP4s that failed every render after it.
async function cached(out, src) {
  if (!isNewer(out, src)) return false;
  if (await hasVideoStream(out).catch(() => false)) return true;
  fs.rmSync(out, { force: true });
  return false;
}
// Written under a temporary name and renamed when complete, so an interruption never leaves a
// file that looks finished. (The ".part-" prefix also keeps it out of backgroundReady().)
async function writeCache(out, args) {
  const tmp = path.join(path.dirname(out), `.part-${path.basename(out)}`);
  await ffmpeg([...args, tmp]);
  fs.rmSync(out, { force: true });
  fs.renameSync(tmp, out);
}

// Name of the prepared background in .work: everything that changes its pixels.
function backgroundTag(src, W, H, dim, shade, smooth, loopFade, transition = 'crossfade', imageSeconds = 15) {
  const sourceTag = crypto.createHash('sha256').update(JSON.stringify(fileIdentity(src))).digest('hex').slice(0, 12);
  return `${sourceTag}_${W}x${H}_d${dim}_s${shade?.strength || 0}x${shade?.height || 0}_t${smooth || 0}_f${loopFade || 0}_${transition}_${imageSeconds}`;
}
/** True when the background is already prepared for these settings (the app's time forecast skips that step). */
export function backgroundReady(cfg, workDir) {
  const c = scaleLayout(cfg);
  const tag = backgroundTag(c.background, c.video.width, c.video.height, c.backgroundDim, c.bottomShade, c.backgroundSmooth, c.loopFade, c.loopTransition, c.imageLoopSeconds);
  return fs.existsSync(workDir) && fs.readdirSync(workDir).some((f) => f === `bg_${tag}.png` || f.startsWith(`bg_${tag}_`));
}

// Scale/crop/dim/shade the background once, so the long render doesn't redo it every frame.
// Returns the input args plus a filter prefix that yields yuv420p frames at the output fps.
async function prepareBackground(src, workDir, { width: W, height: H, fps }, dim, shade, smooth, loopFade, codec, transition = 'crossfade', imageSeconds = 15) {
  const dimF = dim > 0 ? `,drawbox=c=black@${dim}:t=fill` : '';
  // Soft dark gradient at the bottom so the visualizer reads on bright scenes.
  let shadeF = '';
  if (shade?.strength > 0) {
    const top = H - shade.height;
    const k = `(1-${shade.strength}*pow(clip((Y-${top})/${shade.height},0,1),1.6))`;
    shadeF = `,format=gbrp,geq=r='r(X,Y)*${k}':g='g(X,Y)*${k}':b='b(X,Y)*${k}'`;
  }
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1${dimF}${shadeF}`;
  const sourceTag = crypto.createHash('sha256').update(JSON.stringify(fileIdentity(src))).digest('hex').slice(0, 12);
  const tag = backgroundTag(src, W, H, dim, shade, smooth, loopFade, transition, imageSeconds);
  if (IMAGE_EXT.has(path.extname(src).toLowerCase())) {
    if (transition === 'fade-black' && loopFade > 0) {
      const cycle = Math.max(5, Number(imageSeconds) || 15), fade = Math.min(loopFade, cycle / 3);
      const out = path.join(workDir, `bg_${tag}_${fps}.mp4`);
      if (!(await cached(out, src))) await writeCache(out, [
        '-loop', '1', '-framerate', String(fps), '-i', src, '-t', String(cycle),
        '-vf', `${fit},fps=${fps},fade=t=in:st=0:d=${fade},fade=t=out:st=${cycle - fade}:d=${fade},format=yuv420p`,
        ...(await videoEncodeArgs(codec, 16, '40M')).args, '-g', String(Math.round(fps)),
      ]);
      return { args: ['-stream_loop', '-1', '-i', out], filter: 'format=yuv420p' };
    }
    const out = path.join(workDir, `bg_${tag}.png`);
    if (!(await cached(out, src))) await writeCache(out, ['-i', src, '-vf', fit, '-frames:v', '1']);
    // Decode the still once and repeat it inside the graph (much cheaper than -loop 1).
    return { args: ['-framerate', String(fps), '-i', out], filter: `format=yuv420p,loop=loop=-1:size=1` };
  }
  if (!(await hasVideoStream(src))) throw new Error(`Background sem vídeo: ${src}`);
  const out = path.join(workDir, `bg_${tag}_${fps}.mp4`);
  if (!(await cached(out, src))) {
    console.log('• fundo: preparando o loop (só na primeira vez, leva alguns minutos)');
    const prepStart = Date.now(), clipSec = await duration(src);
    // AI-generated clips "boil": fine textures are redrawn every frame. A short weighted temporal
    // average calms static areas while slow motion (steam, water) survives. The clip is tripled
    // so the average wraps across the loop seam, then the middle copy is kept.
    // Generated loops rarely close perfectly: crossfade the end into the start so the seam
    // disappears (the loop gets `loopFade` seconds shorter).
    if (transition === 'crossfade' && loopFade > 0) {
      const d = await duration(src);
      const x = Math.min(loopFade, d / 3);
      const seamless = path.join(workDir, `bg_seamless_${sourceTag}_f${loopFade}.mp4`);
      if (!(await cached(seamless, src)))
        await writeCache(seamless, [
          '-i', src, '-i', src, '-an', '-filter_complex',
          `[0:v]settb=AVTB,setpts=PTS-STARTPTS[a];[1:v]settb=AVTB,setpts=PTS-STARTPTS[b];` +
            `[a][b]xfade=transition=fade:duration=${x}:offset=${(d - x).toFixed(3)},` +
            `trim=start=${x.toFixed(3)}:end=${d.toFixed(3)},setpts=PTS-STARTPTS[v]`,
          '-map', '[v]', '-c:v', 'libx264', '-crf', '12', '-preset', 'fast',
        ]);
      src = seamless;
    }
    let pre = '';
    let input = ['-i', src];
    if (smooth > 1) {
      const n = smooth | 1;
      const k = (n + 1) / 2;
      const weights = Array.from({ length: n }, (_, i) => k - Math.abs(i + 1 - k)).join(' ');
      const d = await duration(src);
      input = ['-stream_loop', '2', '-i', src];
      pre = `tmix=frames=${n}:weights='${weights}',trim=start=${d.toFixed(3)}:duration=${d.toFixed(3)},setpts=PTS-STARTPTS,`;
    }
    const d = transition === 'fade-black' && loopFade > 0 ? await duration(src) : 0;
    const fade = d > 0 ? Math.min(loopFade, d / 3) : 0;
    const seam = fade > 0 ? `,fade=t=in:st=0:d=${fade},fade=t=out:st=${Math.max(0, d - fade)}:d=${fade}` : '';
    await writeCache(out, [
      ...input, '-an', '-vf', `${pre}${fit},fps=${fps}${seam},format=yuv420p`,
      ...(await videoEncodeArgs(codec, 16, '40M')).args, '-g', String(Math.round(fps)),
    ]);
    recordSpeed({ kind: 'prep', rate: (Date.now() - prepStart) / 1000 / (clipSec * W * H / 1e6) });
  }
  return { args: ['-stream_loop', '-1', '-i', out], filter: 'format=yuv420p' };
}

// Draws each frame of a custom visualizer from the spectrum and streams it to ffmpeg as raw gray video.
async function streamShapes(stdin, { w, h, draw }, s, { master, start, len, fps }) {
  const bands = RADIAL_STYLES.includes(s.preset) || s.mirror ? Math.max(4, Math.round(s.bars / 2)) : s.bars;
  const opts = { start, length: len, fps, bands, minFreq: s.minFreq, maxFreq: s.maxFreq, tilt: s.tilt, attack: s.attack, release: s.release };
  for await (const levels of bandFrames(master, opts)) {
    const buf = Buffer.alloc(w * h);
    draw(buf, w, h, levels, s);
    if (!stdin.write(buf)) await once(stdin, 'drain');
    if (stdin.destroyed) return;
  }
  stdin.end();
}

// drawtext reads text from files (no escaping issues with quotes/colons) relative to workDir.
// Entrance/exit animation of something visible during [a, b]: 0 while fully shown, 1 at the
// edges, eased (smoothstep). `fd` = seconds of the in/out movement.
const ease = (p) => `(${p})*(${p})*(3-2*(${p}))`;
function animOffset(a, b, fd) {
  const pin = `clip((t-${a})/${fd},0,1)`;
  const pout = `clip((${b}-t)/${fd},0,1)`;
  return { off: `(2-${ease(pin)}-${ease(pout)})`, fade: `min(${pin},${pout})` };
}
// Animations: fade | slide-left | slide-right | rise | zoom | none (`anim` on the text block).
export const ANIMS = ['fade', 'slide-left', 'slide-right', 'rise', 'zoom', 'none'];

const glyphWarned = new Set();
function drawText(workDir, name, text, o, enable) {
  fs.writeFileSync(path.join(workDir, `${name}.txt`), text, 'utf8');
  const miss = missingGlyphs(o.font, text).filter((ch) => !glyphWarned.has(o.font + ch));
  miss.forEach((ch) => glyphWarned.add(o.font + ch));
  if (miss.length) console.log(`  ⚠ a fonte ${path.basename(o.font)} não tem ${miss.join(' ')} (sai como quadrado no vídeo)`);
  let size = String(o.size);
  let x = `${o.x}`;
  let y = `${o.y}`;
  let alpha = o.opacity != null ? String(o.opacity) : null;
  let on = null;
  if (enable) {
    const [a, b] = enable.map((v) => v.toFixed(2));
    const anim = ANIMS.includes(o.anim) ? o.anim : 'fade';
    const fd = Math.min(anim === 'fade' ? 1.5 : 0.9, (enable[1] - enable[0]) / 4).toFixed(2);
    const { off, fade } = animOffset(a, b, fd);
    on = `between(t,${a},${b})`;
    if (anim === 'slide-left') x = `(${o.x})-70*${off}`;
    if (anim === 'slide-right') x = `(${o.x})+70*${off}`;
    if (anim === 'rise') y = `(${o.y})+36*${off}`;
    if (anim === 'zoom') size = `${o.size}*(1-0.18*${off})`;
    alpha = anim === 'none' ? `${o.opacity ?? 1}` : `${fade}*${o.opacity ?? 1}`;
  }
  const parts = [
    `fontfile=font_${path.basename(o.font)}`,
    `textfile=${name}.txt`,
    `fontsize='${size}'`,
    `fontcolor=${o.color}`,
    `x='${x}'`,
    `y='${y}'`,
  ];
  if (o.shadow) parts.push(`shadowcolor=black@0.45:shadowx=2:shadowy=2`);
  if (on) parts.push(`enable='${on}'`);
  if (alpha != null) parts.push(`alpha='${alpha}'`);
  return `drawtext=${parts.join(':')}`;
}

// Layouts are designed on a 1920x1080 canvas. For 1440p/4K every pixel measure is multiplied, so
// the video looks identical, only sharper. Text positions are expressions ("w-text_w-60"): they
// are evaluated in 1080p units and scaled back.
export const RESOLUTIONS = { '1080p': [1920, 1080], '1440p': [2560, 1440], '4k': [3840, 2160] };
function scaleLayout(cfg) {
  const [W, H] = RESOLUTIONS[cfg.video.resolution] || [cfg.video.width, cfg.video.height];
  const k = H / 1080;
  const c = structuredClone(cfg);
  c.video = { ...c.video, width: W, height: H };
  if (k === 1) return c;
  const n = (v) => (typeof v === 'number' ? Math.round(v * k * 100) / 100 : v);
  const expr = (e) => `(${String(e).replace(/\b(text_w|text_h|tw|th|w|h)\b/g, '($1/' + k + ')')})*${k}`;
  const v = c.visualizer;
  for (const key of ['width', 'height', 'bottom', 'radius', 'ringGap', 'minBar']) v[key] = Math.round(v[key] * k);
  for (const key of ['lineWidth', 'glow']) v[key] = n(v[key]);
  if (c.bottomShade) c.bottomShade.height = n(c.bottomShade.height);
  if (c.overlay) for (const key of ['width', 'x', 'y']) c.overlay[key] = n(c.overlay[key]);
  const t = c.text || {};
  for (const block of [t.title, t.title?.subtitle, t.nowPlaying, t.nowPlaying?.label, t.trackProgress, t.cta, t.watermark]) {
    if (!block) continue;
    if (block.size) block.size = n(block.size);
    if (block.x != null) block.x = expr(block.x);
    if (block.y != null) block.y = expr(block.y);
  }
  if (t.trackProgress) {
    t.trackProgress.width = n(t.trackProgress.width);
    t.trackProgress.lineGap = n(t.trackProgress.lineGap);
  }
  // Higher resolution needs a higher bitrate ceiling.
  c.encode = { ...c.encode, maxrate: `${Math.round(parseInt(c.encode.maxrate) * k * k)}M` };
  return c;
}

/**
 * Renders background loop + visualizer + text over the mixed master audio.
 * `preview` = { start, length } renders only an excerpt (same look, fast to iterate).
 * `overlay` = solid color instead of the background, to composite the visualizer in an editor
 *   (black + "Screen" blend mode).
 */
export async function render({ cfg, workDir, master, tracks, total, out, preview, overlay }) {
  cfg = scaleLayout(cfg);
  // Match the background clip's frame rate so the loop doesn't judder from duplicated frames.
  const isImage = IMAGE_EXT.has(path.extname(cfg.background).toLowerCase());
  // 'auto' halves 50/60 fps clips to 25/30: twice the render time and file size buys nothing on a calm loop.
  let auto = isImage ? 30 : Math.round((await frameRate(cfg.background)) * 1000) / 1000;
  while (auto > 31) auto /= 2;
  const fps = cfg.video.fps === 'auto' ? auto : cfg.video.fps;
  const video = { ...cfg.video, fps };
  const { width: W, height: H } = video;
  const start = preview ? Math.max(0, Math.min(preview.start, total - 1)) : 0;
  const len = preview ? Math.min(preview.length, total - start) : total;

  const bg = overlay
    ? { args: ['-f', 'lavfi', '-i', `color=c=${overlay}:s=${W}x${H}:r=${fps}`], filter: 'format=yuv420p' }
    : await prepareBackground(cfg.background, workDir, video, cfg.backgroundDim, cfg.bottomShade, cfg.backgroundSmooth, cfg.loopFade, cfg.encode.codec, cfg.loopTransition, cfg.imageLoopSeconds);
  const inputs = [bg.args, [...(start ? ['-ss', String(start)] : []), '-i', master]];
  const intro = !overlay && cfg.backgroundAnim === 'fade' && start < 1 ? ',fade=t=in:st=0:d=1' : '';
  const f = [`[0:v]${bg.filter}${intro}[bg]`];
  let last = 'bg';

  // Channel intro (chroma key): only in real renders, and in a preview only if it starts inside the intro.
  const ic = cfg.intro;
  const introOn = !overlay && !!ic?.enabled && !!ic.file && fs.existsSync(ic.file) && start < (await duration(ic.file).catch(() => 0));
  const introAudio = introOn && Number(ic.volume) > 0 && (await hasAudioStream(ic.file).catch(() => false));
  let music = '1:a'; // the music as the audio mix sees it

  let feed;
  if (cfg.visualizer?.enabled !== false) {
    // ponytail: one copy of the music for the visualizer, one for the mix with the intro's sound
    const vizIn = introAudio ? '[1:a]asplit=2[amusic][avzin];[avzin]' : '[1:a]';
    const viz = await buildVisualizer({
      style: cfg.visualizer, audioLabel: 'avz', fps, W, H, workDir, firstInput: inputs.length,
    });
    inputs.push(...viz.inputs);
    if (viz.usesAudio) { f.push(`${vizIn}aformat=channel_layouts=stereo[avz]`); if (introAudio) music = 'amusic'; }
    f.push(...viz.filters);
    if (viz.pipe) feed = (stdin) => streamShapes(stdin, viz.pipe, cfg.visualizer, { master, start, len, fps });
    viz.layers.forEach((l, i) => {
      f.push(`[${last}][${l.label}]overlay=x='${l.x}':y='${l.y}':format=auto[layer${i}]`);
      last = `layer${i}`;
    });
  }

  // Channel reminder image ("like & subscribe"): PNG/JPG/WebP or animated GIF, shown for `duration`
  // seconds at `first`, then every `every` seconds, fading in/out.
  const ov = cfg.overlay;
  if (ov?.enabled && ov.image && fs.existsSync(ov.image)) {
    const times = [];
    for (let a = ov.first ?? 60; a + ov.duration <= total; a += ov.every > 0 ? ov.every : Infinity) times.push(a - start);
    const vis = times.filter((a) => a + ov.duration > 0 && a < len);
    if (vis.length) {
      const anim = ANIMS.includes(ov.anim) && ov.anim !== 'zoom' ? ov.anim : 'fade';
      const fd = Math.min(anim === 'fade' ? 0.6 : 0.9, ov.duration / 4);
      const env = anim === 'none' ? '1'
        : vis.map((a) => `clip((T-${a.toFixed(2)})/${fd},0,1)*clip((${(a + ov.duration).toFixed(2)}-T)/${fd},0,1)`).join('+');
      // slides: sum of each appearance's in/out offset (only one is active at a time)
      const off = vis.map((a) => `between(t,${a.toFixed(2)},${(a + ov.duration).toFixed(2)})*${animOffset(a.toFixed(2), (a + ov.duration).toFixed(2), fd).off}`).join('+');
      let ox = String(Math.round(ov.x));
      let oy = String(Math.round(ov.y));
      if (anim === 'slide-left') ox = `${ox}-90*(${off})`;
      if (anim === 'slide-right') ox = `${ox}+90*(${off})`;
      if (anim === 'rise') oy = `${oy}+45*(${off})`;
      const isGif = path.extname(ov.image).toLowerCase() === '.gif';
      // A still is decoded and scaled once, then repeated (much cheaper than -loop 1 for an hour).
      inputs.push(isGif ? ['-ignore_loop', '0', '-i', ov.image] : ['-framerate', String(fps), '-i', ov.image]);
      const idx = inputs.length - 1;
      const on = vis.map((a) => `between(t,${a.toFixed(2)},${(a + ov.duration).toFixed(2)})`).join('+');
      f.push(
        `[${idx}:v]${isGif ? `fps=${fps},` : ''}scale=${Math.round(ov.width)}:-1:flags=lanczos,format=yuva420p${isGif ? '' : ',loop=loop=-1:size=1'},` +
          // yuva420p = the overlay format, so nothing is converted per frame; per-pixel alpha only while
          // the image is on screen (both together doubled the render time).
          `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*min(1,${env})':enable='${on}'[ovimg]`,
        `[${last}][ovimg]overlay=x='${ox}':y='${oy}':format=auto:eof_action=repeat:enable='${on}'[withov]`,
      );
      last = 'withov';
    }
  }

  const texts = [];
  const t = cfg.text || {};
  // Optional extra lines inherit position/style from their parent block.
  const sub = t.title?.subtitle && { ...t.title, ...t.title.subtitle };
  const npLabel = t.nowPlaying?.label && { ...t.nowPlaying, ...t.nowPlaying.label };
  for (const o of [t.title, sub, t.nowPlaying, npLabel, t.trackProgress, t.cta, t.watermark]) {
    if (!o?.enabled || !o.font) continue;
    // System fonts are read-only; copy once (re-copying over a read-only file fails on Windows).
    const dst = path.join(workDir, `font_${path.basename(o.font)}`);
    if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(o.font).size) {
      if (fs.existsSync(dst)) fs.chmodSync(dst, 0o666);
      fs.copyFileSync(o.font, dst);
      fs.chmodSync(dst, 0o666);
    }
  }
  // Small channel mark that stays on screen the whole video.
  if (t.watermark?.enabled && t.watermark.text) texts.push(drawText(workDir, 'watermark', t.watermark.text, t.watermark,
    t.watermark.anim && t.watermark.anim !== 'none' ? [-start, total - start] : null));
  if (t.title?.enabled && t.title.text) {
    // `duration` > 0 shows the title only at the start of the video (fading out), like most top channels do.
    const d = t.title.duration > 0 ? [1 - start, t.title.duration - start] : null;
    if (!d || d[1] > 0) {
      const span = d; // real times (may extend past a preview), so animations match the full video
      texts.push(drawText(workDir, 'title', t.title.text, t.title, span));
      if (sub?.text) texts.push(drawText(workDir, 'subtitle', sub.text, sub, span));
    }
  }
  if (t.nowPlaying?.enabled) {
    const xf = cfg.audio.crossfade || 0;
    tracks.forEach((tr, i) => {
      // Appear once the crossfade into this track is done; `duration` limits how long it stays (0 = whole track).
      const a = tr.start + (i > 0 ? xf : 0) - start;
      const end = (tracks[i + 1]?.start ?? total) - start;
      const b = t.nowPlaying.duration > 0 ? Math.min(end, a + t.nowPlaying.duration) : end;
      if (b <= 0 || a >= len || b - a < 2) return;
      const span = [a, b];
      const name = (t.nowPlaying.prefix || '') + tr.title;
      texts.push(drawText(workDir, `np_${i}`, name, t.nowPlaying, span));
      if (npLabel?.text) texts.push(drawText(workDir, `npl_${i}`, npLabel.text, npLabel, span));
    });
  }
  if (t.trackProgress?.enabled && tracks.length) {
    const p = t.trackProgress;
    const xf = cfg.audio.crossfade || 0;
    const anim = ANIMS.includes(p.anim) ? p.anim : 'none';
    const spans = [];
    tracks.forEach((tr, i) => {
      // Switch to the next name when its crossfade has finished. The marker spans
      // exactly the interval in which this title is displayed.
      const from = tr.start + (i > 0 ? xf : 0);
      const to = i + 1 < tracks.length ? tracks[i + 1].start + xf : total;
      const a = from - start, b = to - start;
      if (b <= 0 || a >= len || b - a <= 0) return;
      spans.push([a, b]);
      // The chosen entrance plays when the bar first appears; later names just fade in.
      const nameStyle = { ...p, x: `(${p.x})+(${p.width}-text_w)/2`, anim: i === 0 || anim === 'none' ? anim : 'fade' };
      texts.push(drawText(workDir, `track_progress_name_${i}`, tr.title, nameStyle, [a, b]));
    });
    if (spans.length) {
      // Line and marker are drawn shapes (fonts like Minecraft have no "●" glyph), overlaid with the
      // same entrance as the name: overlay's own w/h mean the layer, so the canvas is W/H.
      const X = String(p.x).replace(/\bw\b/g, 'W').replace(/\bh\b/g, 'H');
      const Y = String(p.y).replace(/\bw\b/g, 'W').replace(/\bh\b/g, 'H');
      const fd = Math.max(0.05, Math.min(anim === 'fade' ? 1.5 : 0.9, (spans[0][1] - spans[0][0]) / 4));
      const off = `(1-${ease(`clip((t-${spans[0][0].toFixed(3)})/${fd.toFixed(2)},0,1)`)})`;
      const dx = anim === 'slide-left' ? `-70*${off}` : anim === 'slide-right' ? `+70*${off}` : '';
      const dy = anim === 'rise' ? `+36*${off}` : '';
      const fadeIn = anim === 'none' || spans[0][0] < 0 ? '' : `,fade=t=in:st=${spans[0][0].toFixed(3)}:d=${fd.toFixed(2)}:alpha=1`;
      const lineY = `(${Y})+${p.size}+${p.lineGap}`;
      const D = Math.max(10, Math.round(p.size * 0.36));
      const alpha = `colorchannelmixer=aa=${p.opacity ?? 1}${fadeIn}`;
      const pos = spans.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})*clip((t-${a.toFixed(3)})/${(b - a).toFixed(3)},0,1)`).join('+');
      const shape = p.dotShape === 'square' ? '' : `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(${D / 2}-hypot(X+0.5-${D / 2},Y+0.5-${D / 2}),0,1)'`;
      f.push(
        `color=c=${'0x' + (p.lineColor || p.color).replace('#', '')}:s=${Math.round(p.width)}x3:r=${fps},format=rgba,${alpha}[tpline]`,
        `[${last}][tpline]overlay=x='(${X})${dx}':y='${lineY}-1${dy}':format=auto[tpl]`,
        `color=c=${'0x' + (p.dotColor || p.color).replace('#', '')}:s=${D}x${D}:r=${fps},format=rgba${shape},${alpha}[tpdot]`,
        `[tpl][tpdot]overlay=x='(${X})+${p.width}*(${pos})-${D / 2}${dx}':y='${lineY}+0.5-${D / 2}${dy}':format=auto:enable='between(t,${spans[0][0].toFixed(3)},${spans.at(-1)[1].toFixed(3)})'[tpd]`,
      );
      last = 'tpd';
    }
  }
  if (t.cta?.enabled && t.cta.text) {
    const cta = t.cta;
    const every = cta.repeat === false ? Infinity : cta.every > 0 ? cta.every : Infinity;
    for (let at = Math.max(0, cta.first || 0), i = 0; at < total && i < 1000; at += every, i++) {
      const a = at - start, b = Math.min(at + Math.max(1, cta.duration || 8), total) - start;
      if (b > 0 && a < len) texts.push(drawText(workDir, `cta_${i}`, cta.text, cta, [a, b]));
    }
  }
  f.push(`[${last}]${texts.length ? texts.join(',') + ',' : ''}format=yuv420p[${introOn ? 'vtext' : 'vout'}]`);

  // Channel intro on top of everything: green (or any single color) keyed out, spill removed, centered.
  if (introOn) {
    inputs.push([...(start > 0 ? ['-ss', String(start)] : []), '-i', ic.file]);
    const ii = inputs.length - 1;
    const hex = String(ic.color || '#00FF00').replace('#', '').padStart(6, '0');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const w = Math.round((W * Math.min(100, Math.max(10, Number(ic.scale) || 100))) / 200) * 2;
    f.push(
      `[${ii}:v]fps=${fps},scale=${w}:-2:flags=lanczos,format=yuva444p,` +
        `chromakey=color=0x${hex}:similarity=${Number(ic.similarity) || 0.3}:blend=${Number(ic.blend) || 0},` +
        // despill only knows green/blue screens; other key colors skip it
        (g >= r && g >= b ? 'format=gbrap,despill=type=green,' : b >= r && b >= g ? 'format=gbrap,despill=type=blue,' : '') +
        `format=yuva420p[intro]`,
      `[vtext][intro]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:format=auto,format=yuv420p[vout]`,
    );
    if (introAudio) f.push(
      `[${ii}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${Number(ic.volume)}[aintro]`,
      // normalize=0: the music keeps its level, the intro's sound plays on top of it
      `[${music}][aintro]amix=inputs=2:duration=first:normalize=0[aout]`,
    );
  }

  const script = path.join(workDir, 'render.filter.txt');
  fs.writeFileSync(script, f.join(';\n'));

  // Write to a temp file and swap at the end, so an editor/player holding the old file can't corrupt it.
  const tmp = path.resolve(out).replace(/.mp4$/, '.tmp.mp4');
  const enc = cfg.encode;
  const venc = await videoEncodeArgs(enc.codec, enc.cq, enc.maxrate);
  console.log(`  encoder: ${venc.name}`);
  // Speed of the steady part of the encode (first to last progress report), for the time forecast.
  const printer = progressPrinter(len, preview ? 'renderizando preview' : 'renderizando vídeo');
  const encStart = Date.now();
  let p0 = null, p1 = null;
  const onProgress = (t, speed) => { p1 = [t, Date.now()]; p0 ??= p1; printer(t, speed); };
  await ffmpeg(
    [
      ...inputs.flat(),
      '-/filter_complex', script,
      '-map', '[vout]', '-map', introAudio ? '[aout]' : '1:a',
      ...(cfg.cleanMetadata ? ['-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1'] : []),
      '-t', len.toFixed(3),
      ...venc.args, '-g', String(Math.round(fps * 2)),
      '-c:a', 'aac', '-b:a', enc.audioBitrate, '-ar', '48000',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      tmp,
    ],
    { cwd: workDir, feed, onProgress },
  );
  if (!overlay && p0 && p1[0] - p0[0] >= 3) {
    const rate = ((p1[0] - p0[0]) * fps) / ((p1[1] - p0[1]) / 1000);
    recordSpeed({ kind: 'render', key: renderKey({ W, H, codec: enc.codec, preset: cfg.visualizer?.enabled === false ? 'off' : cfg.visualizer.preset, bgImage: isImage }),
      px: W * H, rate, startup: Math.max(0, (p0[1] - encStart) / 1000 - (p0[0] * fps) / rate), preview: !!preview });
  }
  process.stdout.write('\n');
  try {
    fs.rmSync(out, { force: true });
    fs.renameSync(tmp, out);
  } catch {
    throw new Error(`${path.basename(out)} está aberto em outro programa (CapCut/player). Feche-o — o render ficou salvo em ${tmp}`);
  }
  return { out, duration: await duration(out), fps };
}
