import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from './ffmpeg.mjs';
import { STYLES, STYLE_ALIASES, RADIAL_STYLES } from './shapes.mjs';

// Visualizers are built as a grayscale "shape" stream that becomes the alpha channel of a
// solid/gradient color plane. That keeps color, glow and reflection independent of the preset.

const hex = (c) => '0x' + c.replace('#', '');

function writePgm(file, w, h, maxval, fill) {
  const bpp = maxval > 255 ? 2 : 1;
  const header = Buffer.from(`P5\n${w} ${h}\n${maxval}\n`, 'ascii');
  const data = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = fill(x, y);
      if (bpp === 2) data.writeUInt16BE(v, (y * w + x) * 2);
      else data[y * w + x] = v;
    }
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

// Spectrum bars as a gray strip (w x h), bars grow upward from the bottom row.
function barsShape(s, inLabel, out, maskInput, fps) {
  const n = s.bars;
  const pitch = Math.round(s.width / n);
  const w = n * pitch;
  const minBar = s.minBar > 0 ? `,drawbox=x=0:y=ih-${s.minBar}:w=iw:h=${s.minBar}:c=white:t=fill` : '';
  return {
    w,
    pitch,
    filters: [
      `[${inLabel}]showcqt=s=960x${s.height}:r=${fps}:sono_h=0:bar_h=${s.height}:axis=0` +
        `:bar_v='${s.sensitivity}*pow(f/250,${s.tilt ?? 0})':bar_g=${s.gamma}:tc=${s.smoothing}:basefreq=${s.minFreq}:endfreq=${s.maxFreq}` +
        `:cscheme=1|1|1|1|1|1,format=gray,lutyuv=y='clip((val-16)*1.86,0,255)',` +
        `scale=${n}:${s.height}:flags=area,scale=${w}:${s.height}:flags=neighbor${minBar}[${out}_raw]`,
      `[${out}_raw][${maskInput}]blend=all_mode=multiply:shortest=1[${out}]`,
    ],
  };
}

/**
 * @returns {Promise<{filters: string[], inputs: string[][], pipe: object|null, usesAudio: boolean,
 *   layers: {label: string, x: number, y: number}[]}>}
 *   `inputs` are extra ffmpeg input arg groups; their indexes start at `firstInput`.
 */
export async function buildVisualizer({ style: s, audioLabel, fps, W, H, workDir, firstInput }) {
  const inputs = [];
  const f = [];
  const layers = [];
  // Still images are decoded once and repeated inside the graph (cheaper than -loop 1).
  const still = (file, fmt) => {
    inputs.push(["-framerate", String(fps), "-i", file]);
    const label = `still${inputs.length}`;
    f.push(`[${firstInput + inputs.length - 1}:v]format=${fmt},loop=loop=-1:size=1[${label}]`);
    return label;
  };
  const M = Math.ceil((s.glow || 0) * 3) + 2; // transparent margin so the glow isn't clipped
  const intro = ['fade', 'slide-left', 'slide-right', 'rise'].includes(s.anim) ? s.anim : 'none';
  const introDuration = Math.max(0.1, Number(s.animDuration) || 1);
  const introFade = intro === 'none' ? '' : `,fade=t=in:st=0:d=${introDuration}:alpha=1`;

  let shape; // gray label
  let sw, sh; // shape size
  let place; // (canvasW, canvasH) => {x, y}
  let pipe = null; // custom-drawn presets: frames are streamed from Node on stdin

  if (s.preset === 'bars' || s.preset === 'circle') {
    const n = s.bars;
    const pitch = Math.round(s.width / n);
    const barW = Math.max(1, Math.round(pitch * (1 - s.gap)));
    const maskFile = path.join(workDir, `mask_${n * pitch}x${s.height}_${pitch}_${barW}.pgm`);
    if (!fs.existsSync(maskFile))
      writePgm(maskFile, n * pitch, s.height, 255, (x) => (x % pitch < barW ? 255 : 0));
    const mi = still(maskFile, 'gray');
    const b = barsShape(s, audioLabel, 'vb', mi, fps);
    f.push(...b.filters);
    shape = 'vb';
    sw = b.w;
    sh = s.height;
    place = (cw, ch) => ({ x: Math.round((W - cw) / 2), y: H - s.bottom - (ch - M - (s.reflection > 0 ? sh : 0)) });
  } else if (s.preset === 'wave') {
    sw = s.width;
    sh = s.height;
    f.push(
      `[${audioLabel}]volume=${s.sensitivity},showwaves=s=${Math.round(sw / 3)}x${sh}:mode=cline:draw=full` +
        `:colors=white:rate=${fps}:scale=sqrt,format=gray,lutyuv=y='clip((val-16)*1.17,0,255)',scale=${sw}:${sh}:flags=bicubic,tmix=frames=3[vw]`,
    );
    shape = 'vw';
    place = (cw, ch) => ({ x: Math.round((W - cw) / 2), y: H - s.bottom - Math.round(ch / 2) });
  } else if (STYLES[s.preset]) {
    const isRing = RADIAL_STYLES.includes(s.preset);
    sw = Math.round(isRing ? 2 * (s.radius + s.ringGap + s.height) : s.width);
    sh = Math.round(isRing ? sw : s.height);
    inputs.push(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${sw}x${sh}`, '-framerate', String(fps), '-i', 'pipe:0']);
    f.push(`[${firstInput + inputs.length - 1}:v]format=gray[vp]`);
    shape = 'vp';
    pipe = { w: sw, h: sh, draw: STYLES[s.preset] };
    place = isRing
      ? (cw, ch) => ({ x: Math.round(W * s.center.x - cw / 2), y: Math.round(H * s.center.y - ch / 2) })
      : (cw, ch) => ({ x: Math.round((W - cw) / 2), y: H - s.bottom - (ch - M - (s.reflection > 0 && s.anchor === 'bottom' && ['capsules', 'dots'].includes(s.preset) ? sh : 0)) });
  } else {
    throw new Error(`Preset de visualizer desconhecido: ${s.preset} (use ${['bars', 'wave', 'circle', ...Object.keys(STYLES)].join(', ')})`);
  }

  if (s.preset === 'circle') {
    // Mirror the strip so the ring is symmetric, then bend it into a ring with a remap table.
    const stripW = sw * 2;
    const r0 = s.radius;
    const D = 2 * (r0 + sh) + 4;
    const tag = `${stripW}x${sh}_r${r0}`;
    const xmap = path.join(workDir, `polar_x_${tag}.pgm`);
    const ymap = path.join(workDir, `polar_y_${tag}.pgm`);
    if (!fs.existsSync(xmap) || !fs.existsSync(ymap)) {
      const c = D / 2;
      const polar = (x, y) => {
        const dx = x + 0.5 - c;
        const dy = y + 0.5 - c;
        const r = Math.hypot(dx, dy);
        if (r < r0 || r >= r0 + sh) return null;
        let th = Math.atan2(dx, -dy); // 0 at 12 o'clock, clockwise
        if (th < 0) th += 2 * Math.PI;
        return [Math.min(stripW - 1, Math.floor((th / (2 * Math.PI)) * stripW)), sh - 1 - Math.floor(r - r0)];
      };
      writePgm(xmap, D, D, 65535, (x, y) => polar(x, y)?.[0] ?? 65535);
      writePgm(ymap, D, D, 65535, (x, y) => polar(x, y)?.[1] ?? 65535);
    }
    const xi = still(xmap, 'gray16');
    const yi = still(ymap, 'gray16');
    f.push(
      `[vb]split[vbl][vbr];[vbr]hflip[vbrf];[vbl][vbrf]hstack,format=gray[strip]`,
      `[strip][${xi}][${yi}]remap=fill=black,lutyuv=y='if(lte(val,16),0,val)',gblur=sigma=0.6[vc]`,
    );
    shape = 'vc';
    sw = sh = D;
    place = (cw, ch) => ({
      x: Math.round(W * s.center.x - cw / 2),
      y: Math.round(H * s.center.y - ch / 2),
    });
  }

  // Color plane (solid or vertical gradient) + shape as alpha.
  const colorSrc = s.color2
    ? `gradients=s=${sw}x${sh}:c0=${hex(s.color2)}:c1=${hex(s.color)}:x0=0:y0=${sh}:x1=0:y1=0:speed=0:r=${fps},trim=end_frame=1,loop=loop=-1:size=1`
    : `color=c=${hex(s.color)}:s=${sw}x${sh}:r=${fps}`;
  const core = STYLE_ALIASES[s.preset] || s.preset;
  const reflect = s.reflection > 0 && (s.preset === 'bars' || ((core === 'capsules' || core === 'dots') && s.anchor === 'bottom'));
  const cw = sw + 2 * M;
  const ch = sh + M + (reflect ? sh : M);
  // Only split as many branches as are used: a dangling nullsink branch can stall the graph.
  const glow = s.glow > 0;
  const branches = 1 + glow + reflect;
  f.push(
    `${colorSrc},format=rgba[vcol]`,
    `[vcol][${shape}]alphamerge,format=rgba${branches > 1 ? `,split=${branches}[vs1]${glow ? '[vs2]' : ''}${reflect ? '[vs3]' : ''}` : '[vs1]'}`,
    `[vs1]pad=${cw}:${ch}:${M}:${M}:color=black@0[vbase]`,
    glow
      ? `[vs2]pad=${cw}:${ch}:${M}:${M}:color=black@0,gblur=sigma=${s.glow},colorchannelmixer=aa=${s.glowStrength}[vglow];[vglow][vbase]overlay=format=rgb[vlit]`
      : `[vbase]null[vlit]`,
    reflect
      ? `[vs3]vflip,colorchannelmixer=aa=${s.reflection},gblur=sigma=1.5[vrefl];[vlit][vrefl]overlay=${M}:${M + sh}:format=rgb[vall]`
      : `[vlit]null[vall]`,
  );

  // Optional rotating disc (cover art / vinyl) in the middle of the circle preset.
  if ((s.preset === 'circle' || RADIAL_STYLES.includes(s.preset)) && s.centerImage) {
    const d = Math.max(2, Math.round(Math.min(s.radius * 2 * Math.max(40, Math.min(900, Number(s.centerImageScale) || 90)) / 100, Math.hypot(W, H))));
    const disc = path.join(workDir, `center_${d}.png`);
    await ffmpeg([
      '-i', s.centerImage, '-vf', `scale=${d}:${d}:force_original_aspect_ratio=increase,crop=${d}:${d}`, '-frames:v', '1', disc,
    ]);
    const discMask = path.join(workDir, `disc_mask_${d}.pgm`);
    writePgm(discMask, d, d, 255, (x, y) => {
      const r = Math.hypot(x + 0.5 - d / 2, y + 0.5 - d / 2);
      return Math.round(255 * Math.max(0, Math.min(1, d / 2 - r))); // 1px anti-aliased edge
    });
    const di = still(disc, 'rgba');
    const dm = still(discMask, 'gray');
    const rot = s.rotation ? `,rotate=a=t*${((s.rotation * Math.PI) / 180).toFixed(5)}:c=none` : '';
    // Overlaid straight onto the background by render() (stacking alpha layers here loses opacity).
    f.push(`[${di}]null${rot}[vdisc0];[vdisc0][${dm}]alphamerge${introFade}[vdisc]`);
    const c = place(cw, ch);
    layers.push({ label: 'vdisc', x: c.x + Math.round((cw - d) / 2), y: c.y + Math.round((ch - d) / 2) });
  }

  f.push(`[vall]colorchannelmixer=aa=${s.opacity}${introFade}[viz]`);
  const withIntro = (layer) => {
    const off = `max(0,1-t/${introDuration})`;
    return { ...layer,
      x: intro === 'slide-left' ? `${layer.x}-90*${off}` : intro === 'slide-right' ? `${layer.x}+90*${off}` : layer.x,
      y: intro === 'rise' ? `${layer.y}+50*${off}` : layer.y };
  };
  return { filters: f, inputs, pipe, usesAudio: !pipe, layers: [{ label: 'viz', ...place(cw, ch) }, ...layers].map(withIntro) };
}
