// Builds dist/msc-<date>.zip with everything needed to install on another PC:
// the program, channels, docs, installer and each project's settings (no media — tracks,
// backgrounds and renders can be several GB; copy those separately if needed).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/lib/config.mjs';

const withMedia = process.argv.includes('--com-midia');
const date = new Date().toISOString().slice(0, 10);
const dist = path.join(ROOT, 'dist');
const stage = path.join(dist, 'msc');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// YouTube logins/credentials are personal: never packaged.
const copy = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(stage, rel), {
  recursive: true,
  filter: (src) => path.basename(src) !== 'youtube-token.json' && path.basename(src) !== 'client_secret.json',
});
for (const rel of ['src', 'channels', 'fonts', 'docs', 'scripts', 'README.md', 'package.json', 'msc.cmd', 'abrir-app.cmd', 'instalar.cmd', 'instalar.ps1', '.gitignore'])
  if (fs.existsSync(path.join(ROOT, rel))) copy(rel);

// Projects: settings and notes always; tracks/background only with --com-midia. Never .work/output.
const projects = path.join(ROOT, 'projects');
for (const name of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
  if (name.startsWith('_')) continue; // scratch/test projects
  const dir = path.join(projects, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'output') continue; // .work cache, logs
    const isMedia = entry === 'tracks' || /\.(mp4|mov|webm|png|jpe?g|m4a|mp3|wav|flac)$/i.test(entry);
    if (isMedia && !withMedia) continue;
    copy(path.join('projects', name, entry));
  }
  fs.mkdirSync(path.join(stage, 'projects', name, 'tracks'), { recursive: true });
}

const zip = path.join(dist, `msc-${date}${withMedia ? '-com-midia' : ''}.zip`);
fs.rmSync(zip, { force: true });
const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
if (fs.existsSync(bsdtar)) execFileSync(bsdtar, ['-a', '-c', '-f', zip, '-C', dist, 'msc']);
else execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}' -DestinationPath '${zip}'`]);
fs.rmSync(stage, { recursive: true, force: true });

const mb = (fs.statSync(zip).size / 1e6).toFixed(1);
console.log(`✔ ${zip} (${mb} MB)`);
console.log('  No outro PC: extraia o zip, abra a pasta msc e dê dois cliques em instalar.cmd');
