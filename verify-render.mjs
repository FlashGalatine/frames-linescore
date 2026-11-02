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
import { TOKENS } from './rules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7476;
const WS_PORT = Number(process.env.SB_WS_PORT) || 8082;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const CONTROL = `${BASE}/frames-shared/control.html?sbport=${WS_PORT}`;

let passed = 0, failed = 0;
const check = (n, ok, d) => { ok ? passed++ : failed++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d !== undefined ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARM_PAUSE = 700; // past the panel's minimum gap between arming a two-step button and confirming it
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
  const clearMatch = async () => { await page.click('#new-match'); await sleep(ARM_PAUSE); await page.click('#new-match'); await sleep(250); };
  const synced = await page.waitForFunction(() => document.getElementById('t1name')?.value === 'Visitor', null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('panel shows synced names', synced);
  check('panel says it is connected', /connected/.test(await page.locator('#status').textContent()));

  // Some themes paint nothing on the default names, so Show board needs saying why
  const hint = () => page.locator('#names-hint').isVisible();
  check('a fresh install warns that some themes stay hidden', await hint() && /team names/.test(await page.locator('#names-hint').textContent()));
  await mockCmd('t1name', 'East');
  check('one real name is enough to clear the warning', !(await hint()));
  await mockCmd('t1name', 'Visitor');
  check('the warning comes back on the defaults', await hint());
  await page.locator('#t2name').fill('Typed, not set');
  await page.locator('#t1name').focus();
  await mockCmd('title', '');
  check('a name only counts once it is set', await hint());
  await page.locator('#t2name').fill('Home');
  await page.locator('[data-set]').first().click();
  await sleep(250);
  check('and the warning stays after setting them back', await hint());
  const raw = async (data) => { await fetch(`${BASE}/mock/raw?json=${encodeURIComponent(JSON.stringify(data))}`); await sleep(120); };
  const fresh = await state();
  await raw({ ...fresh, teams: fresh.teams.map((t) => ({ ...t, name: ' ' })) });
  check('blank names count as defaults', await hint());
  await raw({ ...fresh, teams: [{ ...fresh.teams[0], name: 'Home' }, fresh.teams[1]] });
  check('"Home" on the first team is a real name, as it is to the NFC skin', !(await hint()));
  await raw(fresh);

  // A push failure reaches the operator, as text, without taking the panel down
  const status = () => page.locator('#status').textContent();
  await raw({ type: 'linescore:error', message: 'Push <b>failed</b>' });
  check('linescore:error shows in the status line', (await status()).includes('Push <b>failed</b>'), await status());
  check('as text, never markup', await page.locator('#status b').count() === 0);
  check('and the panel stays connected', /^connected/.test((await status()).trim()) && !(await page.locator('#undo').isDisabled()));
  await mockCmd('title', '');
  check('the next good update clears it', !(await status()).includes('failed'), await status());

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

  // A real double-click: the browser's own count, so it can't depend on timing
  await clearMatch();
  await page.click('[data-win="1"]');
  await sleep(450);
  await page.dblclick('[data-win="1"]');
  await sleep(500);
  s = await state();
  check('a real double-click on a winner awards once', same(s.teams[0].scores, [10, 10, null]), JSON.stringify(s.teams[0].scores));
  const win2 = await page.locator('[data-win="2"]').boundingBox();
  await page.mouse.click(win2.x + 20, win2.y + 10);
  await sleep(450);
  await page.mouse.down({ clickCount: 2 }); // one press the browser counts as a double-click's second
  await page.mouse.up({ clickCount: 2 });
  await sleep(500);
  s = await state();
  check('a slow double-click, past the time window, still awards once', s.teams[1].scores[2] === 20 && s.columns.length === 4 && s.teams[1].scores[3] === null, JSON.stringify(s.teams[1].scores));
  await page.dblclick('#undo');
  await sleep(500);
  s = await state();
  check('a double-click on Undo takes back one result', s.teams[0].scores[1] === 10 && s.teams[1].scores[2] === null, JSON.stringify(s.teams));
  const before2 = JSON.stringify((await state()).teams);
  await page.dblclick('#new-match');
  await sleep(300);
  check('a double-click on New match clears nothing', JSON.stringify((await state()).teams) === before2);
  await sleep(3200); // let it disarm
  await page.dblclick('[data-preset="baseball"]');
  await sleep(300);
  check('a double-click on a preset changes nothing', (await state()).mode === 'fixed' && JSON.stringify((await state()).teams) === before2);
  await sleep(3200);
  await page.evaluate(() => { const b = document.getElementById('new-match'); b.click(); b.click(); });
  await sleep(300);
  check('two scripted clicks in a row clear nothing', JSON.stringify((await state()).teams) === before2);
  await sleep(3200);
  await clearMatch();
  await page.click('#undo');
  await sleep(300);
  check('Undo brings a cleared match back', (await state()).teams[0].total > 0, JSON.stringify((await state()).teams));
  await clearMatch();

  // Burst across buttons: lands in click order, nothing lost or merged
  await clearMatch();
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
  await clearMatch();
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

  // A half-typed cell or points box survives a broadcast that adds or removes a column
  await clearMatch();
  await mockCmd('t1win');
  await mockCmd('t1win');
  await page.locator('input[data-team="1"][data-col="0"]').selectText();
  await page.keyboard.type('7');
  let mark = (await log()).length;
  await mockCmd('t2win');
  s = await state();
  check('a tie arrives while a cell is half-typed', s.columns.length === 4);
  check('the half-typed cell keeps its text', await input('input[data-team="1"][data-col="0"]') === '7');
  check('and keeps focus', await page.evaluate(() => document.activeElement?.dataset?.col === '0'));
  check('and is not sent', (await log()).slice(mark).every((c) => c.command !== 't1') && s.teams[0].scores[0] === 10, JSON.stringify((await log()).slice(mark)));
  await page.keyboard.press('Control+a');
  await page.keyboard.type('10'); // back to its real value, so moving on commits nothing
  await page.locator('input[data-team="1"][data-col="3"]').selectText();
  await page.keyboard.type('9');
  mark = (await log()).length;
  await mockCmd('undo');
  s = await state();
  check('a half-typed cell in a column that goes away is not sent', s.columns.length === 3 && (await log()).slice(mark).every((c) => c.command !== 't1'), JSON.stringify((await log()).slice(mark)));
  await page.locator('[data-worth="1"]').selectText();
  await page.keyboard.type('33');
  mark = (await log()).length;
  await mockCmd('innings', '4');
  check('a half-typed points box keeps its text across a new inning', await input('[data-worth="1"]') === '33');
  check('and is not sent', (await log()).slice(mark).every((c) => c.command !== 'worth'), JSON.stringify((await log()).slice(mark)));
  await page.locator('#t1name').focus();
  await sleep(250);
  await mockCmd('worth', '10 10 20 x5');
  await clearMatch();

  // A focused cell catches up when it loses focus
  const cellA = 'input[data-team="1"][data-col="0"]';
  await mockCmd('t1', '1 10');
  await page.locator(cellA).focus();
  await mockCmd('t1', '1 30');
  check('a focused cell is left alone by a broadcast', await input(cellA) === '10');
  await page.locator('#t1name').focus();
  await sleep(50);
  check('and catches up when focus leaves', await input(cellA) === '30', await input(cellA));
  await mockCmd('t1', '1 10');

  // A rejected value doesn't stay on screen: the mock, like the C#, broadcasts nothing for it
  mark = (await log()).length;
  await page.fill(cellA, '1.5');
  await page.locator('#t1name').focus();
  await sleep(150);
  check('a rejected cell is sent', (await log()).slice(mark).some((c) => c.command === 't1' && c.value === '1 1.5'), JSON.stringify((await log()).slice(mark)));
  await sleep(450);
  check('and goes back to the last state when the command times out', await input(cellA) === '10', await input(cellA));
  await page.fill('[data-worth="0"]', '1.5');
  await page.locator('#t1name').focus();
  await sleep(600);
  check('so does a rejected points box', await input('[data-worth="0"]') === '10', await input('[data-worth="0"]'));

  // A value on its way doesn't flash back to the old one while it travels
  const flashes = await page.evaluate(async (sel) => {
    const box = document.querySelector(sel), seen = [];
    box.focus();
    box.value = '40';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    box.blur();
    for (let i = 0; i < 40; i++) { seen.push(box.value); await new Promise((r) => setTimeout(r, 2)); }
    return seen;
  }, cellA);
  check('a value on its way never flashes back', flashes.every((v) => v === '40'), flashes.join(' '));
  await sleep(200);
  await mockCmd('t1', '1 10');

  // Half-typed text survives losing focus, until it's Set
  await page.locator('#t2name').fill('Half typed too');
  await page.locator(cellA).focus();
  await sleep(50);
  check('focus leaving keeps unsaved text', await input('#t2name') === 'Half typed too');

  // Enter in a text field is Set. #t1name still holds its own half-typed text, which Set sends as well
  await page.locator('#t2name').fill('Enter Team');
  mark = (await log()).length;
  await page.keyboard.press('Enter');
  await sleep(250);
  let sentNow = (await log()).slice(mark);
  check('Enter in a name field sends one setmany', sentNow.length === 1 && sentNow[0].command === 'setmany' && sentNow[0].t2name === 'Enter Team' && sentNow[0].t1name === 'Half typed', JSON.stringify(sentNow));
  check('and the name lands', (await state()).teams[1].name === 'Enter Team');
  mark = (await log()).length;
  await page.keyboard.press('Enter');
  await sleep(200);
  check('Enter with nothing edited sends nothing', (await log()).length === mark, JSON.stringify((await log()).slice(mark)));
  await page.locator('#t2name').fill('名前');
  mark = (await log()).length;
  await page.evaluate(() => document.getElementById('t2name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await sleep(200);
  check('Enter that commits an IME character sends nothing', (await log()).length === mark, JSON.stringify((await log()).slice(mark)));
  await page.locator('#t1name').fill('Half typed');

  // Batched set
  await page.locator('#t2name').fill('West');
  const before = (await log()).length;
  await page.locator('[data-set]').first().click();
  await sleep(250);
  l = (await log()).slice(before);
  check('two dirty names send one setmany', l.length === 1 && l[0].command === 'setmany' && l[0].t1name === 'Half typed' && l[0].t2name === 'West', JSON.stringify(l));
  check('the names land', (await state()).teams[1].name === 'West');

  // Two-step clear
  await mockCmd('t1win');
  const total = (await state()).teams[0].total;
  await page.click('#new-match');
  await sleep(150);
  check('first click clears nothing', total > 0 && (await state()).teams[0].total === total, `total ${total}`);
  check('first click asks for a second', /again/i.test(await page.locator('#new-match').textContent()));
  await sleep(ARM_PAUSE);
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
  await sleep(ARM_PAUSE);
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
  await mockCmd('preset', 'sfl');
  const beforeDrop = JSON.stringify((await state()).teams);
  await fetch(`${BASE}/mock/drop`);
  await sleep(200);
  check('a dropped connection shows', !/^connected/.test((await page.locator('#status').textContent()).trim()));
  check('the buttons are disabled while it is down', await page.locator('[data-win="1"]').isDisabled() && await page.locator('#undo').isDisabled());
  // Past the buttons, straight at the handlers: nothing may queue up for the reconnect
  await page.evaluate(() => { for (const id of ['1', '2', '1']) { const b = document.querySelector('[data-win="' + id + '"]'); b.disabled = false; b.click(); b.disabled = true; } });
  await page.locator('#t1name').fill('Typed in the outage');
  await page.evaluate(() => { const b = document.querySelector('[data-set]'); b.disabled = false; b.click(); b.disabled = true; });
  await page.waitForFunction(() => /^connected/.test(document.getElementById('status').textContent.trim()), null, { timeout: 6000 }).catch(() => {});
  await sleep(600);
  check('and it reconnects', /^connected/.test((await page.locator('#status').textContent()).trim()));
  check('the buttons come back', !(await page.locator('[data-win="1"]').isDisabled()));
  check('clicks made in the outage are not replayed', JSON.stringify((await state()).teams) === beforeDrop, JSON.stringify((await state()).teams));
  check('a Set in the outage keeps the typed text', await input('#t1name') === 'Typed in the outage');
  await page.locator('[data-set]').first().click();
  await sleep(250);
  check('and it lands on the next Set', (await state()).teams[0].name === 'Typed in the outage');

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

async function verifyTheme(browser) {
  console.log('\n[theme: ballpark]');
  const url = `${BASE}/frames-themes/ballpark/panels/board-1200x260.html?sbport=${WS_PORT}`;

  // Nothing to show yet: no empty frame on air
  const noSb = await browser.newPage({ viewport: { width: 1200, height: 260 } });
  await noSb.goto(`${BASE}/frames-themes/ballpark/panels/board-1200x260.html?sbport=9`, { waitUntil: 'load' });
  await sleep(200);
  check('with Streamer.bot off, it paints nothing', !(await noSb.locator('#board').isVisible()));
  await noSb.close();
  const noState = await browser.newPage({ viewport: { width: 1200, height: 260 } });
  await noState.routeWebSocket(/.*/, () => {}); // connected, and no payload ever comes
  await noState.goto(url, { waitUntil: 'load' });
  await sleep(600);
  check('connected but before the first state, it paints nothing', !(await noState.locator('#board').isVisible()));
  await noState.close();

  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1200, height: 260 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket/.test(m.text())) errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  const text = (sel) => page.locator(sel).first().textContent();
  const count = (sel) => page.locator(sel).count();
  const visible = (sel) => page.locator(sel).first().isVisible();
  const panelColor = (p) => p.evaluate(() => getComputedStyle(document.getElementById('board')).backgroundColor);

  const painted = await page.waitForFunction(() => document.querySelector('.bp-name')?.textContent === 'Visitor', null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('fresh install paints', painted && await count('.bp-head') === 10 && await text('.bp-total') === '0', await count('.bp-head'));
  check('the first state shows the board', await visible('#board'));
  check('the counts row shows on a fresh install', await visible('.bp-labels') && (await text('.bp-label[data-key="ball"]')).includes('Ball'));

  await mockCmd('preset', 'sfl');
  await mockCmd('t1name', 'Team East Coast');
  await mockCmd('t2name', 'Team West Coast');
  await mockCmd('t1win');
  check('scores paint', await text('.bp-cell[data-team="1"][data-col="0"]') === '10' && await text('.bp-cell[data-team="2"][data-col="0"]') === '0');
  check('the live column shows its points', await text('.bp-cell[data-team="1"][data-col="1"]') === '+10');
  check('the leader is marked', await page.locator('.bp-total').nth(0).evaluate((n) => n.classList.contains('is-lead')));
  await mockCmd('t1win');
  await mockCmd('t2win');
  check('extra column appears on a tie', await count('.bp-head') === 5 && await page.locator('.bp-head').nth(3).textContent() === 'EXTRA');
  check('nobody is marked in a tie', await count('.bp-total.is-lead') === 0);
  check('labels off collapses the row', !(await visible('.bp-labels')));
  check('the title shows', await text('.bp-title') === 'TEAM BATTLE');
  await page.screenshot({ path: resolve(__dirname, 'test-render.png') });

  await mockCmd('ball', 'on');
  await mockCmd('ball', 'name Games');
  await mockCmd('ball', '2');
  check('renamed label paints', (await text('.bp-label[data-key="ball"]')).includes('Games') && (await text('.bp-label[data-key="ball"]')).includes('2'));
  check('labels that are off stay off', !(await page.locator('.bp-label[data-key="strike"]').isVisible()));

  await mockCmd('hide');
  check('hidden paints nothing', !(await visible('#board')));
  await mockCmd('show');
  check('show brings it back', await visible('#board'));

  // Worst case: 12 columns and long names
  const LONG = 'The Extremely Long Team Name Of The Year!';
  await mockCmd('preset', 'baseball');
  await mockCmd('innings', '12');
  await mockCmd('t1name', LONG);
  await mockCmd('t2name', 'Wé "quote" \\ <b>not bold</b> 名前');
  await mockCmd('title', 'A Title Too');
  for (const v of ['1 99', '2 88', '3 77']) await mockCmd('t1', v);
  check('names are exactly as typed', await page.locator('.bp-name').nth(0).textContent() === LONG && await page.locator('.bp-name').nth(1).textContent() === 'Wé "quote" \\ <b>not bold</b> 名前');
  check('names are text, never markup', await count('.bp-name b') === 0);
  const fit = await page.evaluate(() => [...document.querySelectorAll('.bp-name')].every((n) => n.scrollWidth <= n.clientWidth + 1 && parseFloat(getComputedStyle(n).fontSize) >= 14));
  check('long names fit the name cell', fit);
  const box = await page.evaluate(() => { const r = document.getElementById('board').getBoundingClientRect(); return { right: r.right, bottom: r.bottom }; });
  check('12 columns and every row stay inside the source', box.right <= 1200 && box.bottom <= 260, JSON.stringify(box));
  await page.screenshot({ path: resolve(__dirname, 'test-render-worst.png') });

  // CSS-only skins
  const base = await panelColor(page);
  for (const skin of ['crosley', 'led']) {
    const p = await browser.newPage({ viewport: { width: 1200, height: 260 } });
    await p.goto(`${url}&skin=${skin}`, { waitUntil: 'load' });
    await p.waitForSelector('.bp-name');
    await sleep(150);
    check(`the ${skin} skin changes colors by CSS alone`, await panelColor(p) !== base, await panelColor(p));
    await p.screenshot({ path: resolve(__dirname, `test-render-${skin}.png`) });
    await p.close();
  }
  const odd = await browser.newPage({ viewport: { width: 1200, height: 260 } });
  const asked = [];
  odd.on('request', (r) => asked.push(r.url()));
  await odd.goto(`${url}&skin=../../../evil`, { waitUntil: 'load' });
  check('a bad skin name loads nothing extra', !asked.some((u) => /evil[^&]*\.css/.test(u)) && !asked.some((u) => u.includes('/skins/')), asked.join(' '));
  await odd.close();

  await fetch(`${BASE}/mock/drop`);
  await sleep(200);
  check('offline dims', await page.evaluate(() => document.body.classList.contains('offline') && +getComputedStyle(document.getElementById('board')).opacity < 1));
  check('and keeps the last state on screen', await visible('#board'));
  check('no console errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// The docs can't rot quietly: THEMING.md's first example must actually run, and the README
// must mention every command.
async function verifyDocs(browser) {
  console.log('\n[docs]');
  const theming = await readFile(resolve(__dirname, 'docs/THEMING.md'), 'utf8');
  const example = /```html\r?\n([\s\S]*?)\r?\n```/.exec(theming);
  check('THEMING.md has a complete HTML example', !!example);
  const dir = resolve(__dirname, 'frames-themes/_doc-test');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'board.html'), example[1], 'utf8');
    await mockCmd('t1name', 'Doc Team');
    const page = await browser.newPage({ viewport: { width: 1000, height: 300 } });
    await page.goto(`${BASE}/frames-themes/_doc-test/board.html?sbport=${WS_PORT}`, { waitUntil: 'load' });
    const ran = await page.waitForFunction(() => document.getElementById('board')?.textContent.includes('Doc Team'), null, { timeout: 6000 }).then(() => true).catch(() => false);
    check('the example paints a team name', ran);
    const total = (await state()).teams[0].total;
    check('the example paints a total', (await page.locator('#board').textContent()).includes(String(total)));
    await page.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const readme = await readFile(resolve(__dirname, 'README.md'), 'utf8');
  const missing = TOKENS.filter((t) => !readme.includes('`' + t) && !readme.includes(' ' + t + '`'));
  check('the README mentions every command', missing.length === 0, missing.join(', '));
  check('the README says to restrict the chat command', /Moderators/.test(readme));
  check('the README covers keeping the WebSocket on loopback', /127\.0\.0\.1/.test(readme) && /authentication/i.test(readme));
}

async function main() {
  console.log('Frames: real-browser verification\n');
  let mock, browser;
  try {
    mock = await startMock();
    browser = await launch();
    await verifyPanel(browser);
    await verifyPanelPort(browser);
    mock.kill();                 // the theme checks start from a fresh install
    await sleep(400);
    mock = await startMock();
    await verifyTheme(browser);
    await verifyDocs(browser);
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
