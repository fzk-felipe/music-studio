import { spawn } from 'node:child_process';

// Runs ffmpeg/ffprobe and resolves with { stdout, stderr }. Rejects on non-zero exit.
// `feed(stdin)` (optional) streams data into the process, e.g. raw video frames.
export function run(bin, args, { cwd, onProgress, feed } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onProgress) {
        const m = s.match(/out_time_us=(\d+)/g);
        const sp = s.match(/speed=\s*([\d.]+)x/);
        if (m) onProgress(Number(m.at(-1).split('=')[1]) / 1e6, sp ? Number(sp[1]) : null);
      }
    });
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    if (feed) {
      p.stdin.on('error', () => {}); // ffmpeg may close stdin early; the exit code reports real errors
      feed(p.stdin).catch((e) => {
        p.kill();
        reject(e);
      });
    }
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} saiu com código ${code}${code === 4294967294 ? ' (arquivo não encontrado — uma música ou o fundo foi renomeado/apagado durante o processo?)' : ''}\n${stderr.split('\n').slice(-25).join('\n')}`));
    });
  });
}

export const ffmpeg = (args, opts) => run('ffmpeg', ['-hide_banner', '-y', ...args], opts);

export async function duration(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ]);
  return Number(stdout.trim());
}

export async function frameRate(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file,
  ]);
  const [n, d] = stdout.trim().split('/').map(Number);
  return d ? n / d : n;
}

export async function hasAudioStream(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
  return stdout.trim().length > 0;
}

export async function hasVideoStream(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_type,nb_frames', '-of', 'csv=p=0', file,
  ]);
  return stdout.trim().length > 0;
}

// Integrated loudness (LUFS) and true peak of a file, via loudnorm's analysis pass.
export async function measureLoudness(file) {
  const { stderr } = await ffmpeg([
    '-nostats', '-i', file, '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-',
  ]);
  const json = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
  return { lufs: Number(json.input_i), truePeak: Number(json.input_tp) };
}

export function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function progressPrinter(total, label) {
  let last = 0;
  return (t, speed) => {
    const now = Date.now();
    if (now - last < 2000 && t < total) return;
    last = now;
    const pct = Math.min(100, (t / total) * 100).toFixed(1);
    const eta = speed ? fmtTime((total - t) / speed) : '?';
    process.stdout.write(`\r  ${label}: ${pct}%  (${speed ?? '?'}x, restante ~${eta})      `);
  };
}

// ---- Video encoder selection -------------------------------------------------------------
// GPU encoders are much faster but depend on the machine; each candidate is test-encoded once
// with the exact arguments we use, so a listed-but-unusable encoder (no GPU/driver) is skipped.

const ENCODERS = {
  h264_nvenc: (q, maxrate) => ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-maxrate', maxrate, '-bufsize', maxrate, '-bf', '2'],
  h264_qsv: (q, maxrate) => ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(q), '-maxrate', maxrate, '-bufsize', maxrate],
  h264_amf: (q) => ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 2), '-qp_b', String(q + 4)],
  libx264: (q, maxrate) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q), '-maxrate', maxrate, '-bufsize', maxrate],
};
const AUTO_ORDER = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
let picked = null;

export async function pickEncoder(preference = 'auto') {
  if (picked && (preference === 'auto' || preference === picked)) return picked;
  const candidates = preference === 'auto' ? AUTO_ORDER : [preference];
  for (const name of candidates) {
    if (!ENCODERS[name]) throw new Error(`encoder desconhecido: ${name} (use auto, ${Object.keys(ENCODERS).join(', ')})`);
    try {
      await ffmpeg(['-f', 'lavfi', '-i', 'color=s=640x360:r=24:d=0.5', ...ENCODERS[name](23, '8M'), '-pix_fmt', 'yuv420p', '-f', 'null', '-']);
      picked = name;
      return name;
    } catch {
      /* not usable on this machine */
    }
  }
  throw new Error('nenhum encoder H.264 utilizável — o FFmpeg instalado não tem libx264?');
}

/** Encoder args for `quality` (lower = better; ~16 near-lossless, ~21 default, ~25 smaller files). */
export async function videoEncodeArgs(preference, quality, maxrate) {
  const name = await pickEncoder(preference);
  return { name, args: ENCODERS[name](quality, maxrate) };
}
