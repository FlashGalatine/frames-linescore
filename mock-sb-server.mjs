// A mock of Streamer.bot: lets the whole line score run with NO Streamer.bot install, for
// theme development and the verify suites. It mimics the two surfaces Frames depends on:
//
//   HTTP Server on :7474  Path->Folder file serving: /frames-shared/* and /frames-themes/*,
//                         a panel index at /, and these test routes:
//       /mock/cmd?command=&value=&source=  applies a command and re-broadcasts (400 if rejected)
//       /mock/log                          every Linescore Command's args, in order
//       /mock/state                        the current payload
//       /mock/raw?json=                    broadcasts arbitrary custom data
//       /mock/drop                         closes every WebSocket client
//   WebSocket Server on :8080  speaks SB's envelope. It acks Subscribe, and DoAction both
//                              acks and broadcasts, the way the C# actions do.
//
// Keys (when attached to a TTY): q/a team 1 +/-, w/s team 2 +/-, n next, 1/2 win, z undo,
// r reset. The real thing uses Streamer.bot itself with the same wire shapes.

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, applyCommand, buildPayload } from './rules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = resolve(__dirname, 'frames-themes');
const SHARED_DIR = resolve(__dirname, 'frames-shared');

const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7474;
const WS_PORT = Number(process.env.SB_WS_PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

const state = createState();
const commandLog = [];

// SB's General.Custom envelope for a WebsocketBroadcastJson payload.
const customEvent = (data) => JSON.stringify({
  timeStamp: '1970-01-01T00:00:00.0000000',
  event: { source: 'General', type: 'Custom' },
  data,
});

function safeResolve(base, rel) {
  const file = resolve(base, '.' + rel);
  return file === base || file.startsWith(base + '\\') || file.startsWith(base + '/') ? file : null;
}

async function serveFile(res, file) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

async function landingHtml() {
  const sections = [];
  try {
    const themes = (await readdir(THEMES_DIR, { withFileTypes: true })).filter((d) => d.isDirectory());
    for (const t of themes) {
      let mani;
      try { mani = JSON.parse(await readFile(resolve(THEMES_DIR, t.name, 'manifest.json'), 'utf8')); } catch { continue; }
      const links = (mani.panels || []).map((p) =>
        `<li><a href="/frames-themes/${t.name}/${p.file}?sbport=${WS_PORT}" target="_blank">${p.label || p.file}</a> ${p.width}×${p.height}</li>`).join('');
      sections.push(`<h2>${mani.displayName || t.name}</h2><ul>${links}</ul>`);
    }
  } catch { /* no themes yet */ }
  return `<!doctype html><meta charset="utf-8"><title>Frames: mock Streamer.bot</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#e6e6e6;background:#141414}a{color:#9ad}code{background:#222;padding:.1em .4em;border-radius:4px}</style>
<h1>Frames: mock Streamer.bot</h1>
<p><a href="/frames-shared/control.html?sbport=${WS_PORT}" target="_blank">Control panel</a></p>
<p>Keys in the mock's console: <code>q/a</code> team 1 ±, <code>w/s</code> team 2 ±, <code>n</code> next, <code>1/2</code> win, <code>z</code> undo, <code>r</code> reset. Or <code>/mock/cmd?command=preset&amp;value=sfl</code>.</p>
${sections.join('\n')}`;
}

const http = createServer(async (req, res) => {
  const url = req.url || '/';
  let path;
  try { path = decodeURIComponent(url.split('?')[0]); } catch { path = '/'; }
  const query = new URLSearchParams(url.split('?')[1] || '');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  if (path === '/mock/cmd') {
    const args = Object.fromEntries(query);
    delete args.command;
    delete args.value;
    if (!args.source) delete args.source;
    const r = run(query.get('command'), query.get('value') ?? '', args);
    return json(r.ok ? 200 : 400, { ...r, state: buildPayload(state) });
  }
  if (path === '/mock/log') return json(200, commandLog);
  if (path === '/mock/state') return json(200, buildPayload(state));
  if (path === '/mock/raw') {
    let data;
    try { data = JSON.parse(query.get('json') || 'null'); } catch { return json(400, { ok: false }); }
    send(customEvent(data));
    return json(200, { ok: true });
  }
  if (path === '/mock/drop') {
    for (const ws of clients) ws.terminate();
    return json(200, { ok: true });
  }
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await landingHtml());
    return;
  }
  let file = null;
  if (path.startsWith('/frames-themes/')) file = safeResolve(THEMES_DIR, path.slice('/frames-themes'.length));
  else if (path.startsWith('/frames-shared/')) file = safeResolve(SHARED_DIR, path.slice('/frames-shared'.length));
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Map /frames-themes/ and /frames-shared/.');
    return;
  }
  return serveFile(res, file);
});

http.on('error', (err) => { console.error('[mock] HTTP error:', err.message); process.exit(1); });
http.listen(HTTP_PORT, '127.0.0.1', () => console.log(`[mock] HTTP  http://127.0.0.1:${HTTP_PORT}/`));

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });
const clients = new Set();

wss.on('error', (err) => { console.error('[mock] WS error:', err.message); process.exit(1); });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.subscribedCustom = false; // only a correctly-subscribed client receives broadcasts
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.request === 'Subscribe') {
      // Real Streamer.bot uses a LOWERCASE source key in Subscribe. Enforce it here, so a
      // wrong-case subscribe gets nothing, exactly as it does for real.
      const gen = m.events && m.events.general;
      ws.subscribedCustom = Array.isArray(gen) && gen.includes('Custom');
      ws.send(JSON.stringify({ id: m.id, status: 'ok', result: { events: m.events } }));
    } else if (m.request === 'DoAction') {
      ws.send(JSON.stringify({ id: m.id, status: 'ok' }));
      const name = m.action && m.action.name;
      if (name === 'Linescore Command') {
        const { command, value, ...args } = m.args || {};
        run(command, value ?? '', args);
      } else if (name === 'Linescore Push') {
        broadcast();
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});
wss.on('listening', () => console.log(`[mock] WS    ws://127.0.0.1:${WS_PORT}`));

function send(msg) {
  for (const ws of clients) { if (ws.subscribedCustom) { try { ws.send(msg); } catch {} } }
}
function broadcast() { send(customEvent(buildPayload(state))); }

// One Linescore Command: like the C#, a rejected command broadcasts nothing.
function run(command, value, args) {
  commandLog.push({ command, value, ...args });
  const r = applyCommand(state, command, value, args);
  if (r.warn) console.log(`[mock] warning on ${command} ${value}`);
  if (r.ok) broadcast();
  return r;
}

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  console.log('[mock] keys: q/a team 1 +/-, w/s team 2 +/-, n next, 1/2 win, z undo, r reset, Ctrl+C quit');
  process.stdin.on('data', (k) => {
    if (k.charCodeAt(0) === 3) process.exit(0);
    const map = { q: 't1+', a: 't1-', w: 't2+', s: 't2-', n: 'next', 1: 't1win', 2: 't2win', z: 'undo', r: 'reset' };
    if (map[k]) run(map[k], '', { source: 'panel' });
  });
}
