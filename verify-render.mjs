// Real-browser verification: the control panel and the stock theme in Edge or Chrome,
// driven only by the mock and the real transport. verify.mjs deliberately skips pixels.
//
// Requires a Chromium channel on the machine (system Edge/Chrome):
//   npm install --no-save playwright-core
// It writes test-render*.png and control-render.png (gitignored).

import { spawn } from 'node:child_process';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7476;
const WS_PORT = Number(process.env.SB_WS_PORT) || 8082;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const CONTROL = `${BASE}/frames-shared/control.html?sbport=${WS_PORT}`;

let passed = 0, failed = 0;
const check = (n, ok, d) => { ok ? passed++ : failed++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d !== undefined ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function startMock() {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['mock-sb-server.mjs'], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) },
    });
    let out = '';
    const timer = setTimeout(() => rej(new Error('mock did not start in 8s\n' + out)), 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; if (out.includes('[mock] HTTP') && out.includes('[mock] WS')) { clearTimeout(timer); res(child); } });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { if (code) rej(new Error('mock exited ' + code + '\n' + out)); });
  });
}

async function launch() {
  for (const ch of ['msedge', 'chrome']) { try { return await chromium.launch({ channel: ch, headless: true }); } catch {} }
  return await chromium.launch({ headless: true });
}

const state = async () => (await fetch(`${BASE}/mock/state`)).json();
const log = async () => (await fetch(`${BASE}/mock/log`)).json();
const mockCmd = async (command, value = '', source = 'panel') => {
  await fetch(`${BASE}/mock/cmd?command=${encodeURIComponent(command)}&value=${encodeURIComponent(value)}&source=${encodeURIComponent(source)}`);
  await sleep(120);
};

async function verifyPanel(browser) {
  console.log('[panel]');
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 460, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket/.test(m.text())) errors.push(m.text()); });
  await page.goto(CONTROL, { waitUntil: 'load' });
  const input = (sel) => page.locator(sel).inputValue();
  const synced = await page.waitForFunction(() => document.getElementById('t1name')?.value === 'Visitor', null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('panel shows synced names', synced);
  check('panel says it is connected', /connected/.test(await page.locator('#status').textContent()));

  // One click, one command
  await page.click('[data-preset="sfl"]');
  await sleep(200);
  await page.click('[data-win="1"]');
  await sleep(250);
  let l = await log();
  check('one win sends one DoAction', l.at(-1).command === 't1win' && l.at(-1).source === 'panel' && l.filter((c) => c.command === 't1win').length === 1, JSON.stringify(l.slice(-2)));
  check('the grid reflects the win', await input('input[data-team="1"][data-col="0"]') === '10');

  // Double-click: one result (wait out the window from the single click above)
  await sleep(300);
  // Dispatched in the page, because a stall in the test driver can stretch a real double-click past the window.
  await page.evaluate(() => { const b = document.querySelector('[data-win="1"]'); b.click(); setTimeout(() => b.click(), 30); });
  await sleep(600);
  let s = await state();
  check('double-click awards once', s.teams[0].scores[1] === 10 && s.teams[0].scores[2] === null, JSON.stringify(s.teams[0].scores));

  // Burst across buttons: lands in click order, nothing lost or merged
  await page.click('#new-match'); await page.click('#new-match');
  await sleep(250);
  check('New match clears for the burst', (await state()).teams[0].total === 0);
  await page.click('[data-win="1"]');
  await sleep(50);
  await page.click('[data-win="2"]');
  await sleep(500);
  await page.click('[data-win="1"]');
  await sleep(700);
  s = await state();
  check('burst lands in click order', same(s.teams[0].scores, [10, 0, 20]) && same(s.teams[1].scores, [0, 10, 0]), JSON.stringify(s.teams));

  // A tie adds the extra column
  await page.click('#new-match'); await page.click('#new-match');
  await sleep(250);
  for (const b of ['1', '1', '2']) { await page.click(`[data-win="${b}"]`); await sleep(450); }
  check('tie adds an EXTRA cell', await page.locator('input[data-col="3"]').count() === 2);
  check('the winner buttons name the set in play', /EXTRA/.test(await page.locator('#award-hint').textContent()));

  // Undo
  await page.click('#undo');
  await sleep(250);
  check('Undo takes back the last result', await page.locator('input[data-col="3"]').count() === 0 && (await state()).teams[1].total === 0);

  // Typing in a cell
  await page.fill('input[data-team="1"][data-col="0"]', '20');
  await page.locator('input[data-team="1"][data-col="0"]').blur();
  await sleep(250);
  l = await log();
  check('cell edit sends t1 1 20', l.at(-1).command === 't1' && l.at(-1).value === '1 20', JSON.stringify(l.at(-1)));
  await page.fill('input[data-team="1"][data-col="0"]', '');
  await page.locator('input[data-team="1"][data-col="0"]').blur();
  await sleep(250);
  check('clearing a cell sends -', (await log()).at(-1).value === '1 -');
  await page.fill('input[data-team="1"][data-col="0"]', '10');
  await page.locator('input[data-team="1"][data-col="0"]').blur();
  await sleep(250);

  // A half-typed cell and a half-typed name both survive a broadcast
  await page.locator('#t1name').fill('Half typed');
  await mockCmd('t2win');
  check('a broadcast leaves unsaved text alone', await input('#t1name') === 'Half typed');
  await page.locator('input[data-team="2"][data-col="1"]').selectText();
  await page.keyboard.type('7');
  await mockCmd('title', 'Mid edit');
  check('a broadcast leaves a focused cell alone', await input('input[data-team="2"][data-col="1"]') === '7');
  await page.locator('#t1name').focus();
  await sleep(250);

  // Batched set
  await page.locator('#t2name').fill('West');
  const before = (await log()).length;
  await page.locator('[data-set]').first().click();
  await sleep(250);
  l = (await log()).slice(before);
  check('two dirty names send one setmany', l.length === 1 && l[0].command === 'setmany' && l[0].t1name === 'Half typed' && l[0].t2name === 'West', JSON.stringify(l));
  check('the names land', (await state()).teams[1].name === 'West');

  // Two-step clear
  const total = (await state()).teams[0].total;
  await page.click('#new-match');
  await sleep(150);
  check('first click clears nothing', total > 0 && (await state()).teams[0].total === total, `total ${total}`);
  check('first click asks for a second', /again/i.test(await page.locator('#new-match').textContent()));
  await page.click('#new-match');
  await sleep(250);
  check('second click clears', (await state()).teams[0].total === 0);
  check('names survive New match', (await state()).teams[1].name === 'West');

  // Formats
  await page.click('#innings-up');
  await sleep(250);
  check('innings stepper changes the count', (await state()).columns.length === 4 && (await log()).at(-1).command === 'innings');
  await page.fill('[data-worth="3"]', '40');
  await page.locator('[data-worth="3"]').blur();
  await sleep(250);
  check('a points box sends the whole list', (await log()).at(-1).command === 'worth' && (await log()).at(-1).value === '10 10 20 40 x5', JSON.stringify((await log()).at(-1)));
  await page.click('#mode-free');
  await sleep(250);
  check('free entry hides the winner buttons', !(await page.locator('[data-win="1"]').isVisible()));
  check('free entry shows Next', await page.locator('#next').isVisible());
  await page.click('#next');
  await sleep(250);
  check('Next sends next', (await log()).at(-1).command === 'next');
  await page.click('#extra');
  await sleep(250);
  check('the extras switch sends extra off', (await log()).at(-1).command === 'extra' && (await log()).at(-1).value === 'off');
  await page.click('#extra');
  await sleep(250);

  // Labels
  await page.click('[data-preset="sfl"]');
  await sleep(150);
  await page.click('[data-preset="sfl"]');
  await sleep(250);
  await page.click('[data-label-toggle="ball"]');
  await sleep(250);
  check('label toggle sends ball on', (await log()).at(-1).command === 'ball' && (await log()).at(-1).value === 'on', JSON.stringify((await log()).at(-1)));
  await page.fill('[data-label-value="ball"]', '2');
  await page.locator('[data-label-value="ball"]').blur();
  await sleep(250);
  check('label value sends ball 2', (await log()).at(-1).command === 'ball' && (await log()).at(-1).value === '2');
  await page.fill('[data-label-name="ball"]', 'Games');
  await page.locator('[data-set]').first().click();
  await sleep(250);
  check('a label rename lands', (await state()).labels[0].name === 'Games');

  // Hide
  await page.click('#hide');
  await sleep(250);
  check('hide sends hide', (await log()).at(-1).command === 'hide' && (await state()).hidden === true);
  check('the button flips to Show board', /show/i.test(await page.locator('#hide').textContent()));
  await page.click('#hide');
  await sleep(250);
  check('and back', (await state()).hidden === false);

  // Connection state
  await fetch(`${BASE}/mock/drop`);
  await sleep(200);
  check('a dropped connection shows', !/^connected/.test((await page.locator('#status').textContent()).trim()));
  await page.waitForFunction(() => /^connected/.test(document.getElementById('status').textContent.trim()), null, { timeout: 6000 }).catch(() => {});
  check('and it reconnects', /^connected/.test((await page.locator('#status').textContent()).trim()));

  await page.screenshot({ path: resolve(__dirname, 'control-render.png'), fullPage: true });
  check('no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// The panel's own port override, with the socket intercepted so nothing real is dialed.
async function verifyPanelPort(browser) {
  const page = await browser.newPage();
  const urls = [];
  await page.routeWebSocket(/.*/, (ws) => { urls.push(ws.url()); ws.close(); });
  await page.goto(`${BASE}/frames-shared/control.html?sbport=1@evil.example`, { waitUntil: 'load' });
  await sleep(200);
  check('a bad ?sbport falls back to the default', urls.length > 0 && urls.every((u) => u === 'ws://127.0.0.1:8080/'), JSON.stringify(urls));
  await page.close();
}

async function main() {
  console.log('Frames: real-browser verification\n');
  let mock, browser;
  try {
    mock = await startMock();
    browser = await launch();
    await verifyPanel(browser);
    await verifyPanelPort(browser);
  } catch (err) {
    check('run completed', false, err.stack || err.message);
  } finally {
    if (browser) await browser.close();
    if (mock) mock.kill();
  }
  console.log(`\n${failed ? `${failed} of ${passed + failed} FAILED` : 'ALL GREEN'} (${passed} passed)`);
  process.exit(failed ? 1 : 0);
}

main();
