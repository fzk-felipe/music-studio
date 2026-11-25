import { spawn } from 'node:child_process';

// Streaming spectrum analyzer: decodes the master to mono PCM and yields one Float32Array
// of band levels (0..1) per video frame. Levels are log-spaced bands with tilt (treble boost),
// automatic gain (so quiet and loud tracks both fill the visualizer) and attack/release smoothing.

const SR = 22050; // enough for bands up to ~10 kHz
const N = 4096;

function fftMag(re, im) {
  // In-place iterative radix-2 FFT.
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export async function* bandFrames(master, { start = 0, length, fps, bands, minFreq, maxFreq, tilt = 0, attack = 0.55, release = 0.12 }) {
  const ff = spawn('ffmpeg', [
    '-v', 'error', ...(start ? ['-ss', String(start)] : []), '-t', String(length), '-i', master,
    '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1',
  ], { windowsHide: true });

  const hann = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  // Band edges in FFT bins, log-spaced.
  const edges = Array.from({ length: bands + 1 }, (_, i) => (minFreq * Math.pow(maxFreq / minFreq, i / bands) * N) / SR);
  const centers = Array.from({ length: bands }, (_, i) => (Math.sqrt(edges[i] * edges[i + 1]) * SR) / N);
  const tiltGain = centers.map((f) => Math.pow(f / 250, tilt));

  const totalFrames = Math.round(length * fps);
  let buf = new Float32Array(0);
  let bufStart = 0; // absolute sample index of buf[0]
  let ended = false;
  let peak = 1e-4;
  const level = new Float32Array(bands);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let leftover = Buffer.alloc(0);

  const chunks = [];
  let wake = null;
  ff.stdout.on('data', (d) => {
    chunks.push(d);
    if (chunks.length > 64) ff.stdout.pause();
    wake?.();
  });
  ff.stdout.on('end', () => {
    ended = true;
    wake?.();
  });

  const pull = async () => {
    while (!chunks.length && !ended) await new Promise((r) => (wake = r));
    wake = null;
    if (!chunks.length) return false;
    let data = Buffer.concat([leftover, ...chunks.splice(0)]);
    ff.stdout.resume();
    const usable = data.length - (data.length % 4);
    leftover = data.subarray(usable);
    const f = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + usable));
    const merged = new Float32Array(buf.length + f.length);
    merged.set(buf);
    merged.set(f, buf.length);
    buf = merged;
    return true;
  };

  for (let fi = 0; fi < totalFrames; fi++) {
    const center = Math.round((fi * SR) / fps);
    const from = center - N / 2;
    while (bufStart + buf.length < from + N && (await pull()));
    for (let i = 0; i < N; i++) {
      const s = from + i - bufStart;
      re[i] = (s >= 0 && s < buf.length ? buf[s] : 0) * hann[i];
      im[i] = 0;
    }
    fftMag(re, im);

    // Band magnitude = max bin magnitude inside the band (interpolated for narrow low bands).
    const target = new Float32Array(bands);
    let framePeak = 0;
    for (let b = 0; b < bands; b++) {
      const lo = Math.floor(edges[b]);
      const hi = Math.max(lo, Math.ceil(edges[b + 1]) - 1);
      let m = 0;
      for (let k = lo; k <= hi && k < N / 2; k++) m = Math.max(m, Math.hypot(re[k], im[k]));
      m *= tiltGain[b];
      target[b] = m;
      framePeak = Math.max(framePeak, m);
    }
    // Automatic gain: follow the loudest band, rise fast, fall slowly (~8 s).
    peak = framePeak > peak ? framePeak : Math.max(1e-4, peak * Math.pow(0.5, 1 / (fps * 8)));
    for (let b = 0; b < bands; b++) {
      const db = 20 * Math.log10(target[b] / peak + 1e-9); // <= 0
      const v = Math.max(0, Math.min(1, (db + 42) / 42)); // 42 dB window
      const t = v * v; // emphasise peaks, keep quiet bands low
      level[b] += (t - level[b]) * (t > level[b] ? attack : release);
    }
    // Drop consumed samples.
    const keep = from - bufStart;
    if (keep > SR) {
      buf = buf.slice(keep);
      bufStart += keep;
    }
    yield level;
  }
  ff.kill();
}
