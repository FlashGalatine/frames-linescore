// Regenerates the README's screenshots from the real panel and theme, against the mock.
//   npm i --no-save playwright-core && npm run shots

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTTP_PORT = 7477, WS_PORT = 8083;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = spawn(process.execPath, ['mock-sb-server.mjs'], {
  cwd: ROOT, stdio: 'ignore',
  env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) },
});

try {
  await sleep(800);
  const cmd = async (command, value = '') => {
    await fetch(`${BASE}/mock/cmd?command=${encodeURIComponent(command)}&value=${encodeURIComponent(value)}&source=panel`);
    await sleep(60);
  };
  await cmd('preset', 'sfl');
  await cmd('t1name', 'Team East Coast');
  await cmd('t2name', 'Team West Coast');
  await cmd('t1win');
  await cmd('t1win');

  let browser;
  for (const channel of ['msedge', 'chrome']) { try { browser = await chromium.launch({ channel, headless: true }); break; } catch {} }
  if (!browser) browser = await chromium.launch({ headless: true });

  const board = `${BASE}/frames-themes/ballpark/panels/board-1200x260.html?sbport=${WS_PORT}`;
  for (const [skin, name] of [['', 'ballpark'], ['crosley', 'ballpark-crosley'], ['led', 'ballpark-led']]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 260 }, deviceScaleFactor: 1 });
    await page.goto(skin ? `${board}&skin=${skin}` : board, { waitUntil: 'load' });
    await page.waitForSelector('.bp-name');
    await sleep(200);
    await page.locator('#board').screenshot({ path: join(ROOT, 'docs', name + '.png') });
    await page.close();
  }

  const panel = await browser.newPage({ viewport: { width: 460, height: 1000 } });
  await panel.goto(`${BASE}/frames-shared/control.html?sbport=${WS_PORT}`, { waitUntil: 'load' });
  await panel.waitForFunction(() => document.getElementById('t1name')?.value === 'Team East Coast');
  await sleep(200);
  await panel.screenshot({ path: join(ROOT, 'docs', 'control-panel.png'), fullPage: true });
  await browser.close();
  console.log('wrote docs/ballpark.png, docs/ballpark-crosley.png, docs/ballpark-led.png, docs/control-panel.png');
} finally {
  mock.kill();
}
