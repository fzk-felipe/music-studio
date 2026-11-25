import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

// YouTube Data API v3, no dependencies.
// - One Google Cloud OAuth client ("Desktop app") for the whole program: youtube/client_secret.json
// - One login per channel: channels/<id>/youtube-token.json (refresh token + which YouTube channel it is)
// Both stay out of git (.gitignore).

const CRED = path.join(ROOT, 'youtube', 'client_secret.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const tokenFile = (channel) => path.join(ROOT, 'channels', channel, 'youtube-token.json');

export function client() {
  if (!fs.existsSync(CRED)) return null;
  const j = JSON.parse(fs.readFileSync(CRED, 'utf8'));
  const c = j.installed || j.web;
  return c?.client_id && c?.client_secret ? c : null;
}

export function saveCredentials(buf) {
  let j;
  try { j = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { throw new Error('arquivo inválido — use o JSON baixado do Google Cloud (credenciais OAuth)'); }
  const c = j.installed || j.web;
  if (!c?.client_id || !c?.client_secret) throw new Error('esse JSON não é de credenciais OAuth (crie "ID do cliente OAuth" do tipo "App para computador")');
  if (!j.installed) throw new Error('o tipo do cliente OAuth precisa ser "App para computador" (Desktop app), não "Aplicativo da Web"');
  fs.mkdirSync(path.dirname(CRED), { recursive: true });
  fs.writeFileSync(CRED, JSON.stringify(j, null, 2));
}

export function status(channel) {
  const configured = !!client();
  const f = tokenFile(channel);
  const t = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  return { configured, connected: !!t?.refresh_token, ytChannel: t?.ytChannel || null };
}

export function authUrl(channel, redirectUri) {
  const c = client();
  if (!c) throw new Error('configure as credenciais do Google primeiro');
  const q = new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account', // always returns a refresh token and lets the user pick the channel
    state: channel,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params) {
  const c = client();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google recusou o login: ${j.error_description || j.error}`);
  return j;
}

/** OAuth callback: stores the login in the channel folder and records which YouTube channel it is. */
export async function finishConnect(channel, code, redirectUri) {
  const t = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (!t.refresh_token) throw new Error('o Google não devolveu acesso permanente — tente conectar de novo');
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { authorization: `Bearer ${t.access_token}` },
  });
  const j = await r.json();
  const ch = j.items?.[0];
  if (!ch) throw new Error('essa conta Google não tem canal no YouTube — escolha a conta/canal certo');
  const data = {
    refresh_token: t.refresh_token,
    access_token: t.access_token,
    expires_at: Date.now() + (t.expires_in - 60) * 1000,
    ytChannel: { id: ch.id, title: ch.snippet.title, thumb: ch.snippet.thumbnails?.default?.url },
    connectedAt: new Date().toISOString(),
  };
  fs.writeFileSync(tokenFile(channel), JSON.stringify(data, null, 2));
  return data.ytChannel;
}

export function disconnect(channel) {
  fs.rmSync(tokenFile(channel), { force: true });
}

async function accessToken(channel) {
  const f = tokenFile(channel);
  if (!fs.existsSync(f)) throw new Error('canal não conectado ao YouTube');
  const t = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (t.access_token && Date.now() < t.expires_at) return t.access_token;
  let n;
  try { n = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' }); }
  catch (e) { throw new Error(`o acesso ao YouTube expirou — conecte o canal de novo (${e.message})`); }
  Object.assign(t, { access_token: n.access_token, expires_at: Date.now() + (n.expires_in - 60) * 1000 });
  fs.writeFileSync(f, JSON.stringify(t, null, 2));
  return t.access_token;
}

// YouTube rejects "<" and ">" in titles/descriptions; titles max 100 chars, tags max 500 chars total.
const clean = (s) => String(s || '').replace(/</g, '‹').replace(/>/g, '›');
function fitTags(tags) {
  const out = [];
  let len = 0;
  for (const t of tags.map((x) => clean(x).trim()).filter(Boolean)) {
    const cost = t.length + (t.includes(' ') ? 2 : 0) + (out.length ? 1 : 0);
    if (len + cost > 490) break;
    out.push(t);
    len += cost;
  }
  return out;
}

const apiError = async (r) => {
  const j = await r.json().catch(() => ({}));
  const reason = j.error?.errors?.[0]?.reason || '';
  const msg = j.error?.message || `HTTP ${r.status}`;
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') return new Error('limite diário do YouTube atingido — tente amanhã');
  return new Error(`YouTube: ${msg}`);
};

/**
 * Resumable upload; survives connection drops (asks YouTube how much it got and continues).
 * meta: { title, description, tags[], privacy: private|unlisted|public, publishAt?: ISO }
 */
export async function uploadVideo(channel, file, meta, { onProgress, signal, resumeState, onSession } = {}) {
  const size = fs.statSync(file).size;
  const status = { privacyStatus: meta.publishAt ? 'private' : meta.privacy || 'private', selfDeclaredMadeForKids: false };
  if (meta.publishAt) status.publishAt = new Date(meta.publishAt).toISOString();
  const body = {
    snippet: { title: clean(meta.title).slice(0, 100), description: clean(meta.description).slice(0, 5000), tags: fitTags(meta.tags || []), categoryId: '10' },
    status,
  };
  let session = resumeState?.session;
  if (!session) {
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await accessToken(channel)}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        'x-upload-content-type': 'video/mp4',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!init.ok) throw await apiError(init);
    session = init.headers.get('location');
    if (!session) throw new Error('YouTube não forneceu URL para retomar o envio');
    onSession?.({ session, offset: 0 });
  }

  const CHUNK = 32 * 1024 * 1024; // multiple of 256 KiB
  const fd = fs.openSync(file, 'r');
  let offset = resumeState?.offset || 0;
  let failures = 0;
  try {
    if (resumeState) {
      const q = await fetch(session, { method: 'PUT', headers: { authorization: `Bearer ${await accessToken(channel)}`,
        'content-length': '0', 'content-range': `bytes */${size}` }, signal });
      if (q.status === 200 || q.status === 201) return (await q.json()).id;
      if (q.status === 404) throw new Error('A sessão de envio expirou. Descarte-a e inicie um novo envio.');
      if (q.status !== 308) throw await apiError(q);
      const range = q.headers.get('range');
      offset = range ? Number(range.split('-')[1]) + 1 : 0;
      onSession?.({ session, offset });
      onProgress?.(offset, size);
    }
    while (true) {
      if (signal?.aborted) throw new Error('envio cancelado');
      if (offset >= size) throw new Error('O YouTube recebeu todos os bytes, mas ainda não confirmou o vídeo. Retome a sessão para consultar o resultado.');
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      let r;
      try {
        r = await fetch(session, {
          method: 'PUT',
          headers: { authorization: `Bearer ${await accessToken(channel)}`, 'content-length': String(len), 'content-range': `bytes ${offset}-${offset + len - 1}/${size}` },
          body: buf,
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw new Error('envio cancelado');
        r = null; // network drop: ask where to resume
      }
      if (r && (r.status === 200 || r.status === 201)) {
        onProgress?.(size, size);
        return (await r.json()).id;
      }
      if (r && r.status === 308) {
        const range = r.headers.get('range');
        offset = range ? Number(range.split('-')[1]) + 1 : 0;
        onSession?.({ session, offset });
        failures = 0;
        onProgress?.(offset, size);
        continue;
      }
      if (r && r.status < 500 && r.status !== 429) throw await apiError(r);
      // 5xx / 429 / network: wait, then ask YouTube how much it already has
      if (++failures > 8) throw new Error('a conexão com o YouTube caiu várias vezes — tente enviar de novo');
      await new Promise((res) => setTimeout(res, Math.min(60, 2 ** failures) * 1000));
      const q = await fetch(session, {
        method: 'PUT',
        headers: { authorization: `Bearer ${await accessToken(channel)}`, 'content-length': '0', 'content-range': `bytes */${size}` },
        signal,
      }).catch(() => null);
      if (q?.status === 200 || q?.status === 201) return (await q.json()).id;
      if (q?.status === 308) {
        const range = q.headers.get('range');
        offset = range ? Number(range.split('-')[1]) + 1 : 0;
        onSession?.({ session, offset });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Custom thumbnail (jpg/png up to 2 MB; the channel must be verified on YouTube). */
export async function setThumbnail(channel, videoId, image) {
  const type = /\.png$/i.test(image) ? 'image/png' : 'image/jpeg';
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken(channel)}`, 'content-type': type },
    body: fs.readFileSync(image),
  });
  if (!r.ok) {
    const e = await apiError(r);
    if (r.status === 403) e.message = 'o YouTube recusou a thumbnail — o canal precisa estar verificado (youtube.com/verify)';
    throw e;
  }
}
