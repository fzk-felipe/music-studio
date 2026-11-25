import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Google Flow Music: public playlists list clip ids, /__api/clips resolves ids to titles and audio
// URLs. Songs are pages at /song/<id> and need no login either; playlists must be shared by link.
const API = 'https://www.flowmusic.app/__api';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function playlistId(url) {
  const m = String(url).match(new RegExp(`playlist/(${UUID})`, 'i')) || String(url).trim().match(new RegExp(`^(${UUID})$`, 'i'));
  if (!m) throw new Error('link inválido — use o link da playlist do Flow Music (…/playlist/<id>)');
  return m[1];
}

// "07 - Memory Card Slot" → num 7, title "Memory Card Slot" (the file gets its own number).
function toClip(c) {
  const raw = (c.title || 'Sem título').trim();
  const m = raw.match(/^\s*(\d{1,3})\s*[-_.):]+\s*(.+)$/);
  return { id: c.id, num: m ? Number(m[1]) : null, title: m ? m[2].trim() : raw, url: c.audio_url,
    duration: Number(c.duration?.value) || 0, created: c.created_at || '' };
}
async function clipsByIds(ids) {
  const r = await fetch(`${API}/clips`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clip_ids: ids }) });
  if (!r.ok) throw new Error(`Flow Music respondeu ${r.status} ao listar as faixas`);
  const byId = (await r.json()).clips || {};
  return ids.map((id) => byId[id]).filter((c) => c?.audio_url && !c.deleted_at).map(toClip);
}

/** { name, clips }: `name` is the playlist's title (null when Flow doesn't send one). */
export async function playlistClips(url) {
  const id = playlistId(url);
  const res = await fetch(`${API}/playlists/${id}`);
  if (!res.ok) throw new Error(`Flow Music respondeu ${res.status} — a playlist está pública/compartilhada?`);
  const playlist = await res.json();
  const name = [playlist.name, playlist.title, playlist.playlist?.name, playlist.playlist?.title].find((x) => typeof x === 'string' && x.trim()) || null;
  const items = playlist.clips;
  const ids = items.map((c) => c.clip_id);
  if (!ids.length) throw new Error('playlist vazia');
  const pos = Object.fromEntries(items.map((c, i) => [c.clip_id, c.sort_index ?? i]));
  // Order: the number in the title when there is one, otherwise the playlist's own order.
  const clips = (await clipsByIds(ids))
    .sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || pos[a.id] - pos[b.id] || a.created.localeCompare(b.created));
  return { name, clips };
}

/**
 * Everything Flow links in `text` point to: playlists (…/playlist/<id>) and single songs (…/song/<id>),
 * in the order pasted, without repeats. A bare id is taken as a playlist (older behavior).
 */
export async function resolveFlow(text) {
  const t = String(text || '');
  const lists = [...t.matchAll(new RegExp(`playlist/(${UUID})`, 'gi'))].map((m) => m[1]);
  const songs = [...t.matchAll(new RegExp(`song/(${UUID})`, 'gi'))].map((m) => m[1]);
  if (!lists.length && !songs.length && new RegExp(`^\\s*${UUID}\\s*$`, 'i').test(t)) lists.push(t.trim());
  if (!lists.length && !songs.length) throw new Error('cole o link de uma playlist ou de músicas do Flow Music (…/playlist/<id> ou …/song/<id>)');
  let name = null;
  const clips = [];
  for (const id of lists) { const p = await playlistClips(id); name ??= p.name; clips.push(...p.clips); }
  if (songs.length) {
    const found = await clipsByIds(songs);
    if (!found.length && !clips.length) throw new Error('nenhuma dessas músicas foi encontrada (o link está certo e a música é pública?)');
    clips.push(...found);
  }
  const seen = new Set();
  return { name, clips: clips.filter((c) => !seen.has(c.id) && seen.add(c.id)) };
}

// Characters Windows doesn't allow in file names.
export const safeName = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Faixa';

export async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download falhou (${res.status}): ${url}`);
  const tmp = file + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  return file;
}
