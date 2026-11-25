import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, duration, measureLoudness, fmtTime, progressPrinter } from './ffmpeg.mjs';
import { recordSpeed } from './speed.mjs';

const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus']);

// "03 - Noite em Ipanema.mp3" -> "Noite em Ipanema"
export function titleFromFile(file) {
  return path.parse(file).name.replace(/^\s*\d+\s*[-_.)]*\s*/, '').replace(/[_]+/g, ' ').trim();
}

// Songs are in the folder itself or one level down (each imported playlist gets its own folder,
// so a whole playlist can be removed at once). Numbering is shared, so the order is by file name
// across folders. Dot folders (.lixeira, .staging-…) are not songs.
export function listTracks(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Pasta de faixas não encontrada: ${dir}`);
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) files.push(path.join(dir, e.name));
    else if (e.isDirectory() && !e.name.startsWith('.')) for (const f of fs.readdirSync(path.join(dir, e.name))) files.push(path.join(dir, e.name, f));
  }
  return files
    .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
}

// Measures each track (cached by file size + mtime) so we can level them to the same loudness.
async function analyze(files, cacheFile) {
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const out = [];
  for (const [i, file] of files.entries()) {
    const st = fs.statSync(file);
    const key = `${path.basename(file)}|${st.size}|${st.mtimeMs}`;
    if (!cache[key]) {
      process.stdout.write(`\r  analisando faixa ${i + 1}/${files.length}...   `);
      const t0 = Date.now();
      cache[key] = { duration: await duration(file), ...(await measureLoudness(file)) };
      recordSpeed({ kind: 'analyze', rate: cache[key].duration / ((Date.now() - t0) / 1000) });
    }
    out.push({ file, title: titleFromFile(file), ...cache[key] });
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  process.stdout.write('\n');
  return out;
}

/**
 * Levels every track to `targetLufs`, chains them with crossfades and writes a single
 * 48 kHz FLAC master. Returns the tracklist with start times (for chapters / now-playing).
 */
export async function buildMix({ tracksDir, workDir, audio }) {
  const files = listTracks(tracksDir);
  if (files.length === 0) throw new Error(`Nenhuma faixa de áudio em ${tracksDir}`);
  const tracks = await analyze(files, path.join(workDir, 'loudness-cache.json'));

  const xf = files.length > 1 ? Math.max(0, Number(audio.crossfade) || 0) : 0;
  let t = 0;
  for (const tr of tracks) {
    tr.start = t;
    tr.gainDb = Number.isFinite(tr.lufs) ? audio.targetLufs - tr.lufs : 0;
    t += tr.duration - xf;
  }
  const total = t + xf;

  const inputs = files.flatMap((f) => ['-i', f]);
  const lines = tracks.map(
    (tr, i) =>
      `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${tr.gainDb.toFixed(2)}dB[a${i}];`,
  );
  let prev = 'a0';
  for (let i = 1; i < tracks.length; i++) {
    lines.push(xf > 0
      ? `[${prev}][a${i}]acrossfade=d=${xf}:c1=qsin:c2=qsin[x${i}];`
      : `[${prev}][a${i}]concat=n=2:v=0:a=1[x${i}];`);
    prev = `x${i}`;
  }
  // Optional ambience bed (rain, waves, café chatter) looped under the whole mix.
  if (audio.ambience?.file && audio.ambience.enabled !== false) {
    const ai = tracks.length;
    inputs.push('-stream_loop', '-1', '-i', audio.ambience.file);
    const volumeDb = Math.max(-60, Math.min(0, Number.isFinite(Number(audio.ambience.volumeDb)) ? Number(audio.ambience.volumeDb) : -22));
    const fadeIn = Math.max(0, Math.min(total, Number(audio.ambience.fadeIn) || 0));
    const fadeOut = Math.max(0, Math.min(total, Number(audio.ambience.fadeOut) || 0));
    const fades = [
      fadeIn > 0 ? `afade=t=in:st=0:d=${fadeIn}` : null,
      fadeOut > 0 ? `afade=t=out:st=${Math.max(0, total - fadeOut)}:d=${fadeOut}` : null,
    ].filter(Boolean);
    lines.push(
      `[${ai}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${volumeDb}dB${fades.length ? ',' + fades.join(',') : ''}[amb];`,
      `[${prev}][amb]amix=inputs=2:duration=first:normalize=0[withamb];`,
    );
    prev = 'withamb';
  }
  // Brickwall at -1 dBTP so leveled-up quiet tracks can't clip.
  lines.push(`[${prev}]alimiter=limit=0.89:level=false:attack=5:release=80[out]`);
  const script = path.join(workDir, 'mix.filter.txt');
  fs.writeFileSync(script, lines.join('\n'));

  const master = path.join(workDir, 'master.flac');
  const t0 = Date.now();
  await ffmpeg(
    [...inputs, '-/filter_complex', script, '-map', '[out]', '-c:a', 'flac', '-progress', 'pipe:1', '-nostats', master],
    { onProgress: progressPrinter(total, 'mixando áudio') },
  );
  recordSpeed({ kind: 'mix', rate: total / ((Date.now() - t0) / 1000) });
  process.stdout.write('\n');
  return { master, tracks, total: await duration(master) };
}

export function tracklistText(tracks) {
  return tracks.map((tr) => `${fmtTime(tr.start)} ${tr.title}`).join('\n');
}
