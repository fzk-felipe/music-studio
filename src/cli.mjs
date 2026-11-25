#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadProject, merge } from './lib/config.mjs';
import { buildMix, listTracks, tracklistText } from './lib/audio.mjs';
import { render } from './lib/render.mjs';
import { fmtTime, run, pickEncoder } from './lib/ffmpeg.mjs';
import { ROOT } from './lib/config.mjs';
import { writeRenderState } from './lib/project-state.mjs';

const USAGE = `
Uso:
  msc app                            abre o app visual no navegador
  msc app --janela                   abre o app em janela própria (o que o atalho "Music Studio" usa)
  msc verificar                      confere se este PC tem tudo para rodar
  msc novo <nome> [canal]            cria projects/<nome> (padrão: primeiro canal configurado)
  msc preview <nome> [inicio] [dur]  trecho rápido p/ ajustar o visual (padrão: 60 20 segundos)
  msc build <nome>                   vídeo completo + descrição com tracklist
  msc overlay <nome>                 só o visualizer sobre fundo preto, p/ o CapCut (modo "Tela")
  msc compare <nome> [inicio] [dur]  gera duas prévias A/B a partir das configurações guardadas no app
`;

// Rebuild the mix only when tracks or audio settings change.
async function getMix(cfg, workDir) {
  const files = listTracks(cfg.tracks);
  const key = JSON.stringify({
    files: files.map((f) => [path.basename(f), fs.statSync(f).size, fs.statSync(f).mtimeMs]),
    audio: cfg.audio,
    ambienceFile: cfg.audio?.ambience?.file && fs.existsSync(cfg.audio.ambience.file)
      ? [fs.statSync(cfg.audio.ambience.file).size, fs.statSync(cfg.audio.ambience.file).mtimeMs] : null,
  });
  const stateFile = path.join(workDir, 'mix.json');
  const master = path.join(workDir, 'master.flac');
  if (fs.existsSync(stateFile) && fs.existsSync(master)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.key === key) {
      console.log('• áudio: reutilizando mix existente');
      return state;
    }
  }
  console.log(`• áudio: ${files.length} faixas → nivelando em ${cfg.audio.targetLufs} LUFS, crossfade ${cfg.audio.crossfade}s`);
  const mix = await buildMix({ tracksDir: cfg.tracks, workDir, audio: cfg.audio });
  const state = { key, ...mix };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return state;
}

function writeDescription(cfg, tracks, outDir) {
  const tracklist = tracklistText(tracks);
  const desc = cfg.description.template.replaceAll('{title}', cfg.title || '').replaceAll('{tracklist}', tracklist);
  const file = path.join(outDir, 'description.txt');
  const tags = cfg.description.tags?.length ? `\n\n---\nTAGS: ${cfg.description.tags.join(', ')}\n` : '';
  fs.writeFileSync(file, `TÍTULO: ${cfg.title || ''}\n\n${desc}${tags}`, 'utf8');
  return file;
}

// Checks Node, FFmpeg version, the filters this pipeline uses and which encoder will be used.
async function doctor() {
  let ok = true;
  const line = (good, msg) => {
    console.log(`  ${good ? '✔' : '✖'} ${msg}`);
    if (!good) ok = false;
  };
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20, `Node ${process.versions.node}${major >= 20 ? '' : ' — precisa da versão 20 ou mais nova'}`);
  let filters = '';
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-version']);
    const v = stdout.match(/ffmpeg version (\S+)/)?.[1] ?? '?';
    const m = Number(v.match(/^n?(\d+)\./)?.[1]);
    line(!m || m >= 7, `FFmpeg ${v}${m && m < 7 ? ' — precisa da versão 7 ou mais nova' : ''}`);
    await run('ffprobe', ['-version']);
    filters = (await run('ffmpeg', ['-hide_banner', '-filters'])).stdout;
  } catch {
    line(false, 'FFmpeg/ffprobe não encontrados no PATH — rode instalar.cmd');
    process.exit(1);
  }
  const need = ['showcqt', 'showwaves', 'remap', 'xfade', 'tmix', 'loudnorm', 'alimiter', 'acrossfade', 'amix',
    'drawtext', 'gblur', 'alphamerge', 'gradients', 'geq', 'colorchannelmixer', 'lutyuv'];
  const missing = need.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters));
  line(!missing.length, missing.length ? `filtros ausentes no FFmpeg: ${missing.join(', ')} (instale a build "full")` : 'todos os filtros necessários');
  try {
    const enc = await pickEncoder('auto');
    const gpu = enc !== 'libx264';
    line(true, `encoder de vídeo: ${enc}${gpu ? ' (GPU)' : ' (CPU — funciona, mas o render fica mais lento)'}`);
  } catch (e) {
    line(false, e.message);
  }
  const channels = availableChannels();
  line(channels.length > 0, `canais: ${channels.join(', ') || 'nenhum'}`);
  console.log(ok ? '\nTudo pronto.' : '\nCorrija os itens marcados com ✖.');
  process.exit(ok ? 0 : 1);
}

function availableChannels() {
  const dir = path.join(ROOT, 'channels');
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'channel.json')))
    .map((e) => e.name) : [];
}

function newProject(name, channel = availableChannels()[0]) {
  if (!/^[\w.-]+$/.test(name)) throw new Error('use só letras, números, - e _ no nome do projeto');
  if (!availableChannels().includes(channel)) throw new Error(`canal não encontrado: ${channel || '(nenhum configurado)'}`);
  const dir = path.join(ROOT, 'projects', name);
  if (fs.existsSync(dir)) throw new Error(`já existe: ${dir}`);
  fs.mkdirSync(path.join(dir, 'tracks'), { recursive: true });
  const project = { channel, title: 'TÍTULO DO VÍDEO AQUI', background: 'background.mp4', tracks: 'tracks' };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  console.log(`✔ criado ${dir}
  1. coloque o vídeo de fundo como background.mp4 (ou .png e ajuste o project.json)
  2. coloque as músicas em tracks\\  ("01 - Nome.m4a", "02 - Nome.m4a", ...)
  3. edite o título em project.json
  4. msc preview ${name}   (trecho de teste)  →  msc build ${name}`);
}

async function main() {
  const [cmd, dir, a, b] = process.argv.slice(2);
  if (cmd === 'app') return (await import('./app/server.mjs')).startServer({ open: dir !== '--sem-navegador', window: dir === '--janela' });
  if (cmd === 'verificar') return doctor();
  if (cmd === 'novo' && dir) return newProject(dir, a);
  if (!['build', 'preview', 'overlay', 'compare'].includes(cmd) || !dir) {
    console.log(USAGE);
    process.exit(1);
  }
  const { cfg, projectDir } = loadProject(dir);
  const workDir = path.join(projectDir, '.work');
  const outDir = path.join(projectDir, 'output');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();

  const mix = await getMix(cfg, workDir);
  console.log(`  duração total: ${fmtTime(mix.total)} (${mix.tracks.length} faixas)`);
  if (mix.total < cfg.audio.minDurationMin * 60)
    console.warn(`  ⚠ abaixo do mínimo de ${cfg.audio.minDurationMin} min — faltam ~${fmtTime(cfg.audio.minDurationMin * 60 - mix.total)} de música`);

  if (cmd === 'compare') {
    const file = path.join(workDir, 'compare-settings.json');
    if (!fs.existsSync(file)) throw new Error('guarde as opções A e B no app antes de comparar');
    const variants = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!variants.a || !variants.b) throw new Error('guarde as opções A e B no app antes de comparar');
    const preview = { start: Number(a ?? 60), length: Number(b ?? 20) };
    for (const slot of ['a', 'b']) {
      console.log(`• comparando opção ${slot.toUpperCase()}`);
      const look = merge(cfg, variants[slot]);
      if (look.text?.title?.text) look.text.title.text = look.text.title.text.replace('{title}', look.title || '');
      await render({ cfg: look, workDir, master: mix.master, tracks: mix.tracks,
        total: mix.total, out: path.join(outDir, `compare-${slot}.mp4`), preview });
    }
    console.log('✔ comparação A/B pronta');
    return;
  }

  const preview = cmd === 'preview' ? { start: Number(a ?? 60), length: Number(b ?? 20) } : null;
  const overlay = cmd === 'overlay' ? 'black' : null;
  if (overlay && cfg.visualizer.enabled === false) throw new Error('visualizer desativado no config');
  const out = path.join(outDir, preview ? 'preview.mp4' : overlay ? 'visualizer_overlay.mp4' : 'video.mp4');
  console.log(`• vídeo: ${cfg.visualizer.enabled === false ? 'sem visualizer' : `visualizer "${cfg.visualizer.preset}"`}`);
  const res = await render({ cfg, workDir, master: mix.master, tracks: mix.tracks, total: mix.total, out, preview, overlay });

  if (!preview && !overlay) {
    writeRenderState(projectDir, cfg);
    console.log(`• descrição: ${writeDescription(cfg, mix.tracks, outDir)}`);
  }
  console.log(`✔ ${res.out}  (${fmtTime(res.duration)}, ${res.fps} fps) em ${fmtTime((Date.now() - t0) / 1000)}`);
}

main().catch((e) => {
  console.error('\n✖ ' + e.message);
  process.exit(1);
});
