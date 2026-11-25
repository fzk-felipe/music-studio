// Anti-aliased shape drawing into an 8-bit grayscale buffer (the visualizer's alpha mask).
// Every primitive is a capsule (segment + radius) rendered by its signed distance, which gives
// round bar caps, dots and thick lines with smooth edges.

export function capsule(buf, W, H, x1, y1, x2, y2, r, alpha = 1) {
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - r - 1));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + r + 1));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - r - 1));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + r + 1));
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1e-9;
  const a255 = 255 * alpha;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5 - y1;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - x1;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const ex = px - t * dx;
      const ey = py - t * dy;
      const cov = r + 0.5 - Math.sqrt(ex * ex + ey * ey);
      if (cov <= 0) continue;
      const v = cov >= 1 ? a255 : cov * a255;
      const i = y * W + x;
      if (v > buf[i]) buf[i] = v;
    }
  }
}

// Bands laid out left->right; mirrored puts the bass in the middle and treble at both edges.
function layout(levels, mirror) {
  if (!mirror) return levels;
  const n = levels.length;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[n - 1 - i] = levels[i];
    out[n + i] = levels[i];
  }
  return out;
}

// Catmull-Rom sample of the level curve at fractional index.
function curveAt(v, x) {
  const i = Math.floor(x);
  const t = x - i;
  const p = (k) => v[Math.max(0, Math.min(v.length - 1, k))];
  const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
  return Math.max(0, 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t));
}

/** Rounded bars. anchor 'center' grows up and down from the middle line, 'bottom' grows upward. */
function capsules(buf, W, H, levels, s) {
  const v = layout(levels, s.mirror);
  const slot = W / v.length;
  const r = Math.max(1, (slot * (1 - s.gap)) / 2);
  const maxLen = s.anchor === 'center' ? H / 2 - r - 1 : H - 2 * r - 1;
  for (let i = 0; i < v.length; i++) {
    const cx = slot * (i + 0.5);
    const len = v[i] * maxLen;
    if (s.anchor === 'center') capsule(buf, W, H, cx, H / 2 - len, cx, H / 2 + len, r);
    else capsule(buf, W, H, cx, H - r - 1 - len, cx, H - r - 1, r);
  }
}

/** LED-style stacked dots; the top dot fades in for smooth motion. */
function dots(buf, W, H, levels, s) {
  const v = layout(levels, s.mirror);
  const slot = W / v.length;
  const r = Math.max(1, (slot * (1 - s.gap)) / 2);
  const step = 2 * r + Math.max(2, slot * s.gap);
  const maxDots = Math.floor((H - 2) / step);
  for (let i = 0; i < v.length; i++) {
    const cx = slot * (i + 0.5);
    const lit = 1 + v[i] * (maxDots - 1);
    for (let d = 0; d < Math.ceil(lit); d++) {
      const cy = H - 1 - r - d * step;
      capsule(buf, W, H, cx, cy, cx, cy, r, Math.min(1, lit - d));
    }
  }
}

/** Smooth flowing curve, mirrored vertically: soft translucent body + crisp outline. */
function silk(buf, W, H, levels, s) {
  const v = layout(levels, s.mirror);
  const mid = H / 2;
  const amp = mid - s.lineWidth - 2;
  const scale = (v.length - 1) / (W - 1);
  const fill = 255 * s.fillAlpha;
  // Taper the ends so the curve fades into the line instead of stopping abruptly.
  const taper = (x) => Math.min(1, Math.sin((Math.PI * x) / (W - 1)) * 1.6);
  const A = new Float32Array(W);
  for (let x = 0; x < W; x++) A[x] = curveAt(v, x * scale) * amp * taper(x) + 1;
  for (let x = 0; x < W; x++) {
    const a = A[x];
    const y0 = mid - a;
    const y1 = mid + a;
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++) {
      const cov = Math.max(0, Math.min(1, Math.min(y + 1 - y0, y1 - y)));
      const i = y * W + x;
      const val = cov * fill;
      if (val > buf[i]) buf[i] = val;
    }
  }
  const lw = s.lineWidth / 2;
  for (let x = 0; x < W - 4; x += 4) {
    const x2 = Math.min(W - 1, x + 4);
    capsule(buf, W, H, x, mid - A[x], x2, mid - A[x2], lw);
    capsule(buf, W, H, x, mid + A[x], x2, mid + A[x2], lw);
  }
}

/** Filled terrain with a bright, smooth crest. */
function mountains(buf, W, H, levels, s) {
  const v = layout(levels, s.mirror);
  const scale = (v.length - 1) / Math.max(1, W - 1);
  const A = new Float32Array(W);
  const base = H - 2;
  const amp = Math.max(1, H - s.lineWidth - 5);
  const fill = 255 * s.fillAlpha;
  for (let x = 0; x < W; x++) A[x] = base - curveAt(v, x * scale) * amp;
  for (let x = 0; x < W; x++) {
    for (let y = Math.max(0, Math.floor(A[x])); y < H; y++) {
      const val = Math.min(1, y + 1 - A[x]) * fill;
      const i = y * W + x;
      if (val > buf[i]) buf[i] = val;
    }
  }
  for (let x = 0; x < W - 1; x += 4) {
    const x2 = Math.min(W - 1, x + 4);
    capsule(buf, W, H, x, A[x], x2, A[x2], s.lineWidth / 2);
  }
}

/** Sparse meter needles with a luminous point at each peak. */
function needles(buf, W, H, levels, s) {
  const v = layout(levels, s.mirror);
  const slot = W / v.length;
  const r = Math.max(0.8, Math.min(s.lineWidth / 2, slot * (1 - s.gap) / 4));
  const dot = Math.max(r * 1.6, Math.min(5, slot * (1 - s.gap) / 3));
  for (let i = 0; i < v.length; i++) {
    const x = slot * (i + 0.5);
    const top = H - 3 - v[i] * (H - 6 - dot);
    capsule(buf, W, H, x, top, x, H - 3, r, 0.65);
    capsule(buf, W, H, x, top, x, top, dot);
  }
}

/** Parallel flowing traces, giving the waveform depth without a filled body. */
function ribbon(buf, W, H, levels, s) {
  const v = layout(levels, s.mirror);
  const mid = H / 2;
  const amp = Math.max(1, mid - s.lineWidth - 3);
  const scale = (v.length - 1) / Math.max(1, W - 1);
  const A = new Float32Array(W);
  for (let x = 0; x < W; x++) A[x] = curveAt(v, x * scale) * amp * Math.min(1, Math.sin(Math.PI * x / Math.max(1, W - 1)) * 1.6);
  for (const [factor, alpha] of [[1, 1], [0.55, 0.65], [-0.55, 0.65], [-1, 1]]) {
    for (let x = 0; x < W - 1; x += 4) {
      const x2 = Math.min(W - 1, x + 4);
      capsule(buf, W, H, x, mid + A[x] * factor, x2, mid + A[x2] * factor, s.lineWidth / 2, alpha);
    }
  }
}

/** Radial rounded bars around a circle (bass at 12 o'clock, mirrored left/right). */
function ring(buf, W, H, levels, s) {
  const n = levels.length;
  const cx = W / 2;
  const cy = H / 2;
  const r0 = s.radius + s.ringGap;
  const maxLen = W / 2 - r0 - 3;
  const total = n * 2;
  const r = Math.max(1, ((2 * Math.PI * r0) / total) * (1 - s.gap) / 2);
  for (let i = 0; i < total; i++) {
    const band = i < n ? i : total - 1 - i;
    const th = ((i + 0.5) / total) * 2 * Math.PI;
    const dx = Math.sin(th);
    const dy = -Math.cos(th);
    const len = levels[band] * maxLen;
    capsule(buf, W, H, cx + dx * (r0 + r), cy + dy * (r0 + r), cx + dx * (r0 + r + len), cy + dy * (r0 + r + len), r);
  }
}

/** Floating particles orbiting the photo, with quieter guide dots inside. */
function orbit(buf, W, H, levels, s) {
  const n = levels.length, total = n * 2, cx = W / 2, cy = H / 2;
  const r0 = s.radius + s.ringGap, maxLen = W / 2 - r0 - 10;
  for (let i = 0; i < total; i++) {
    const band = i < n ? i : total - 1 - i;
    const th = (i + 0.5) / total * 2 * Math.PI, dx = Math.sin(th), dy = -Math.cos(th);
    const v = levels[band], r = r0 + v * maxLen * 0.9;
    capsule(buf, W, H, cx + dx * r0, cy + dy * r0, cx + dx * r0, cy + dy * r0, 1.5, 0.3);
    capsule(buf, W, H, cx + dx * r, cy + dy * r, cx + dx * r, cy + dy * r, Math.max(2, Math.min(9, 2 + v * 7)));
  }
}

/** A continuous circular audio wave; lineWidth controls the contour. */
function halo(buf, W, H, levels, s) {
  const n = levels.length, total = n * 2, samples = Math.max(128, total * 5);
  const v = new Float32Array(total);
  for (let i = 0; i < total; i++) v[i] = levels[i < n ? i : total - 1 - i];
  const cx = W / 2, cy = H / 2, r0 = s.radius + s.ringGap, maxLen = W / 2 - r0 - 5;
  const point = (i, swell) => {
    const th = i / samples * 2 * Math.PI;
    const r = r0 + swell * curveAt(v, (i % samples) / samples * (total - 1)) * maxLen;
    return [cx + Math.sin(th) * r, cy - Math.cos(th) * r];
  };
  for (let i = 0; i < samples; i++) {
    const [x1, y1] = point(i, 1), [x2, y2] = point(i + 1, 1);
    capsule(buf, W, H, x1, y1, x2, y2, Math.max(1, s.lineWidth / 2));
    if (i % 2 === 0) {
      const a = i / samples * 2 * Math.PI, b = (i + 2) / samples * 2 * Math.PI;
      capsule(buf, W, H, cx + Math.sin(a) * r0, cy - Math.cos(a) * r0, cx + Math.sin(b) * r0, cy - Math.cos(b) * r0, 1, 0.35);
    }
  }
}

/** Thin radial rays with an illuminated endpoint. */
function sunburst(buf, W, H, levels, s) {
  const n = levels.length, total = n * 2, cx = W / 2, cy = H / 2;
  const r0 = s.radius + s.ringGap, maxLen = W / 2 - r0 - 7;
  const width = Math.max(0.8, Math.min(s.lineWidth / 2, Math.PI * r0 * (1 - s.gap) / total));
  for (let i = 0; i < total; i++) {
    const band = i < n ? i : total - 1 - i;
    const th = (i + 0.5) / total * 2 * Math.PI, dx = Math.sin(th), dy = -Math.cos(th);
    const end = r0 + levels[band] * maxLen;
    capsule(buf, W, H, cx + dx * r0, cy + dy * r0, cx + dx * end, cy + dy * end, width, 0.7);
    capsule(buf, W, H, cx + dx * end, cy + dy * end, cx + dx * end, cy + dy * end, width * 2);
  }
}

/** Square-ended equalizer bars. */
function blocks(buf, W, H, levels, s) {
  const v = layout(levels, s.mirror), slot = W / v.length, bw = Math.max(1, Math.floor(slot * (1 - s.gap)));
  for (let i = 0; i < v.length; i++) {
    const x0 = Math.floor(slot * (i + .5) - bw / 2), top = Math.floor((1 - v[i]) * (H - 2));
    for (let y = Math.max(0, top); y < H - 1; y++) for (let x = Math.max(0, x0); x < Math.min(W, x0 + bw); x++) buf[y * W + x] = 255;
  }
}

/** Angular waveform with straight segments rather than smoothed curves. */
function zigzag(buf, W, H, levels, s) {
  const v = layout(levels, s.mirror), mid = H / 2, amp = mid - 3;
  for (let i = 0; i < v.length - 1; i++) {
    const x1 = i * (W - 1) / (v.length - 1), x2 = (i + 1) * (W - 1) / (v.length - 1);
    capsule(buf, W, H, x1, mid - v[i] * amp, x2, mid - v[i + 1] * amp, s.lineWidth / 2);
    capsule(buf, W, H, x1, mid + v[i] * amp, x2, mid + v[i + 1] * amp, s.lineWidth / 2, .55);
  }
}

/** Petal-shaped radial lobes around the central photo. */
function petals(buf, W, H, levels, s) {
  const n = levels.length, total = n * 2, cx = W / 2, cy = H / 2, r0 = s.radius + s.ringGap, maxLen = W / 2 - r0 - 6;
  for (let i = 0; i < total; i++) {
    const band = i < n ? i : total - 1 - i, th = (i + .5) / total * Math.PI * 2;
    const dx = Math.sin(th), dy = -Math.cos(th), sideX = Math.cos(th), sideY = Math.sin(th);
    const len = Math.max(3, levels[band] * maxLen), half = Math.max(2, Math.min(13, r0 * Math.PI / total));
    const bx = cx + dx * r0, by = cy + dy * r0, tipX = bx + dx * len, tipY = by + dy * len;
    capsule(buf, W, H, bx + sideX * half, by + sideY * half, tipX, tipY, Math.max(1, s.lineWidth / 2), .8);
    capsule(buf, W, H, bx - sideX * half, by - sideY * half, tipX, tipY, Math.max(1, s.lineWidth / 2), .8);
  }
}

/** Concentric dotted rings, with the outer ring reacting to each band. */
function radialDots(buf, W, H, levels, s) {
  const n = levels.length, total = n * 2, cx = W / 2, cy = H / 2, r0 = s.radius + s.ringGap, maxLen = W / 2 - r0 - 8;
  for (let i = 0; i < total; i++) {
    const band = i < n ? i : total - 1 - i, th = (i + .5) / total * Math.PI * 2, dx = Math.sin(th), dy = -Math.cos(th);
    const power = levels[band];
    capsule(buf, W, H, cx + dx * r0, cy + dy * r0, cx + dx * r0, cy + dy * r0, 2, .4);
    const r = r0 + 4 + power * maxLen;
    capsule(buf, W, H, cx + dx * r, cy + dy * r, cx + dx * r, cy + dy * r, Math.max(2, Math.min(9, 2 + power * 6)));
  }
}

export const STYLE_ALIASES = {
  miniBars: 'capsules', bassBars: 'capsules', mirrorBars: 'capsules', softBars: 'capsules',
  pixelBlocks: 'blocks', wideBlocks: 'blocks',
  microDots: 'dots', ledWall: 'dots',
  fineNeedles: 'needles', lightPulses: 'needles',
  fineSilk: 'silk', vapor: 'silk',
  sharpPeaks: 'mountains', dunes: 'mountains',
  thinRibbon: 'ribbon', deepRibbon: 'ribbon',
  neonZigzag: 'zigzag',
  miniRing: 'ring', wideRing: 'ring',
  satellites: 'orbit', nebula: 'orbit',
  thinHalo: 'halo', thickHalo: 'halo',
  smallPetals: 'petals',
  beadRing: 'radialDots',
  thinRays: 'sunburst', solarFlare: 'sunburst',
};
export const RADIAL_STYLES = ['ring', 'orbit', 'halo', 'sunburst', 'petals', 'radialDots',
  ...Object.keys(STYLE_ALIASES).filter((id) => ['ring', 'orbit', 'halo', 'sunburst', 'petals', 'radialDots'].includes(STYLE_ALIASES[id]))];
const baseStyles = { capsules, dots, silk, mountains, needles, ribbon, blocks, zigzag, ring, orbit, halo, sunburst, petals, radialDots };
export const STYLES = { ...baseStyles, ...Object.fromEntries(Object.entries(STYLE_ALIASES).map(([id, base]) => [id, baseStyles[base]])) };
