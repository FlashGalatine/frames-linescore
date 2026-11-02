// End-to-end check of the Streamer.bot seam, with no Streamer.bot: spawns the mock, runs
// the REAL frames-shared/panel-core.js under a minimal browser shim, and drives changes
// the way chat or a Stream Deck would. verify-render.mjs covers real browsers and pixels.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(__dirname, 'frames-shared', 'panel-core.js');
const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7475; // off the SB defaults so it coexists with a running SB
const WS_PORT = Number(process.env.SB_WS_PORT) || 8081;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function startMock() {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['mock-sb-server.mjs'], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) },
    });
    let out = '';
    const timer = setTimeout(() => rej(new Error('mock did not start in 8s\n' + out)), 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('[mock] HTTP') && out.includes('[mock] WS')) { clearTimeout(timer); res(child); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { if (code) rej(new Error('mock exited ' + code + '\n' + out)); });
  });
}

// Runs the real core under a minimal browser shim. `next()` yields each dispatched detail;
// `sent` records what the core sent; `offline` reports the body class.
async function runCore() {
  const q = [];
  let waiter = null;
  const push = (detail) => {
    q.push(detail);
    if (waiter) { clearTimeout(waiter.timer); const w = waiter; waiter = null; w.resolve(q.shift()); }
  };
  const next = (ms = 4000) => {
    if (q.length) return Promise.resolve(q.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiter = null; reject(new Error('timeout waiting for linescore:update')); }, ms);
      waiter = { resolve, timer };
    });
  };

  const listeners = {};
  const window = {
    __SB_WS_URL: `ws://127.0.0.1:${WS_PORT}/`,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(evt) { (listeners[evt.type] || []).forEach((fn) => fn(evt)); },
  };
  let offline = null;
  const document = {
    readyState: 'complete',
    body: { classList: { toggle(name, on) { if (name === 'offline') offline = on; } } },
    addEventListener: () => {},
  };
  const sent = [];
  class RecordingSocket extends WebSocket {
    send(data) { sent.push(JSON.parse(data)); super.send(data); }
  }
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }

  window.addEventListener('linescore:update', (e) => push(e.detail));
  const errors = [];
  window.addEventListener('linescore:error', (e) => errors.push(e.detail));
  const src = await readFile(CORE, 'utf8');
  const fn = new Function('window', 'document', 'location', 'WebSocket', 'CustomEvent', 'URLSearchParams', src);
  fn(window, document, { search: '' }, RecordingSocket, CustomEvent, URLSearchParams);
  return { next, sent, errors, pending: () => q.length, offline: () => offline };
}

// Which URL the core would dial for a given query, with no real connection made.
async function coreUrl(search) {
  const src = await readFile(CORE, 'utf8');
  let url = null;
  class FakeSocket { constructor(u) { url = u; } send() {} }
  const window = { addEventListener() {}, dispatchEvent() {} };
  const document = { readyState: 'complete', body: { classList: { toggle() {} } }, addEventListener() {} };
  new Function('window', 'document', 'location', 'WebSocket', 'CustomEvent', 'URLSearchParams', src)(window, document, { search }, FakeSocket, class {}, URLSearchParams);
  return url;
}

const cmd = (command, value = '', source = '') =>
  fetch(`${BASE}/mock/cmd?command=${encodeURIComponent(command)}&value=${encodeURIComponent(value)}&source=${encodeURIComponent(source)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('Frames: Streamer.bot seam verification\n');
  let mock;
  try {
    mock = await startMock();

    console.log('[1] transport');
    const a = await runCore();
    const sync = await a.next();
    const sub = a.sent.find((m) => m.request === 'Subscribe');
    const act = a.sent.find((m) => m.request === 'DoAction');
    check('subscribes with lowercase general', Array.isArray(sub?.events?.general) && sub.events.general.includes('Custom'), JSON.stringify(sub));
    check('fires Linescore Push on connect', act?.action?.name === 'Linescore Push', JSON.stringify(act));
    check('fresh sync carries defaults', sync.teams?.[0]?.name === 'Visitor' && sync.columns?.length === 9, JSON.stringify(sync).slice(0, 200));
    check('the connection clears offline', a.offline() === false);

    console.log('\n[2] live changes');
    await cmd('preset', 'sfl');
    await a.next();
    await cmd('t1win', '', 'panel');
    const u = await a.next();
    check('win reaches the panel', u.teams[0].scores[0] === 10 && u.lead === 0, JSON.stringify(u.teams));

    console.log('\n[3] mid-match connect');
    const late = await runCore();
    const lateSync = await late.next();
    check('a late panel paints at once', lateSync.teams[0].total === 10 && lateSync.title === 'TEAM BATTLE', JSON.stringify(lateSync).slice(0, 200));

    console.log('\n[4] other broadcasts');
    await sleep(150); // the late panel's sync broadcast reaches this one too; let it land first
    const before = a.pending();
    await fetch(`${BASE}/mock/raw?json=${encodeURIComponent(JSON.stringify({ type: 'scoreboard:update', player1: {} }))}`);
    await sleep(150);
    check('scoreboard:update is ignored', a.pending() === before);
    await fetch(`${BASE}/mock/raw?json=${encodeURIComponent(JSON.stringify({ type: 'linescore:error', message: 'push failed' }))}`);
    await sleep(150);
    check('linescore:error reaches the page as its own event', a.errors.at(-1)?.message === 'push failed', JSON.stringify(a.errors));
    check('and never as an update', a.pending() === before);

    console.log('\n[5] the port override');
    for (const [search, want] of [['?sbport=9090', 'ws://127.0.0.1:9090/'], ['?sbport=1@evil.example', 'ws://127.0.0.1:8080/'], ['?sbport=99999', 'ws://127.0.0.1:8080/'], ['', 'ws://127.0.0.1:8080/']]) {
      const got = await coreUrl(search);
      check(`${search || 'no query'} connects to ${want}`, got === want, got);
    }

    console.log('\n[6] test routes');
    const log = await (await fetch(`${BASE}/mock/log`)).json();
    check('/mock/log records commands in order', log.at(-1)?.command === 't1win' && log.at(-1)?.source === 'panel', JSON.stringify(log.slice(-2)));
    const state = await (await fetch(`${BASE}/mock/state`)).json();
    check('/mock/state returns the payload', state.type === 'linescore:update' && state.teams[0].total === 10);
    check('unknown command is a 400', (await fetch(`${BASE}/mock/cmd?command=nope`)).status === 400);
    await fetch(`${BASE}/mock/drop`);
    await sleep(150);
    check('/mock/drop takes panels offline', a.offline() === true);

    console.log('\n[7] serving');
    check('panel-core served 200', (await fetch(`${BASE}/frames-shared/panel-core.js`)).status === 200);
    check('control.html served 200', (await fetch(`${BASE}/frames-shared/control.html`)).status === 200);
    check('the index page lists panels', (await (await fetch(`${BASE}/`)).text()).includes('mock Streamer.bot'));
    check('path traversal is refused', (await fetch(`${BASE}/frames-shared/..%2f..%2fpackage.json`)).status === 404);
  } catch (err) {
    check('run completed', false, err.message);
  } finally {
    if (mock) mock.kill();
  }
  console.log(`\n${failed ? `${failed} of ${passed + failed} FAILED` : 'ALL GREEN'}`);
  process.exit(failed ? 1 : 0);
}

main();
