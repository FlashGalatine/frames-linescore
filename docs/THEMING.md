# Make your own theme

The stock Ballpark board is one look. Any HTML page can be a panel, with no library and no build step: this guide covers the contract, a complete theme from scratch, and the two CSS-only reskins that ship with Ballpark.

## The contract

A panel is a static HTML file served by Streamer.bot's HTTP Server under `/frames-themes/<your-theme>/…`. It does two things:

1. Listens for one `window` CustomEvent, `linescore:update`, and paints `event.detail`.
2. Loads `/frames-shared/panel-core.js` by that absolute path. That's the transport: it connects to Streamer.bot's WebSocket, subscribes, and asks for the current state, so a panel added mid-match paints at once.

Add the listener before loading panel-core, or you can miss the first event.

### The payload

```json
{
  "type": "linescore:update",
  "title": "TEAM BATTLE",
  "totalLabel": "TOTAL",
  "mode": "fixed",
  "hidden": false,
  "columns": [
    { "label": "SET 1", "worth": 10, "state": "done", "extra": false },
    { "label": "SET 2", "worth": 10, "state": "live", "extra": false },
    { "label": "SET 3", "worth": 20, "state": "open", "extra": false }
  ],
  "teams": [
    { "name": "Team East Coast", "scores": [10, null, null], "total": 10 },
    { "name": "Team West Coast", "scores": [0, null, null], "total": 0 }
  ],
  "lead": 0,
  "over": false,
  "labels": [
    { "key": "ball", "name": "Ball", "value": 2, "on": false },
    { "key": "strike", "name": "Strike", "value": 1, "on": false },
    { "key": "out", "name": "Out", "value": 0, "on": false }
  ],
  "settings": { "innings": 3, "worth": [10, 10, 20], "extraWorth": 5, "extraOn": true, "colLabel": "SET", "extraLabel": "EXTRA" }
}
```

| Field | Meaning |
|---|---|
| `title` | The board's title. Often empty: collapse it |
| `totalLabel` | The total column's heading |
| `mode` | `fixed` (points per inning) or `free` (any number) |
| `hidden` | The operator hid the board. **Every theme must paint nothing while this is true** |
| `columns[].label` | The column's heading, ready to show |
| `columns[].worth` | What the inning is worth in fixed mode, `null` in free mode |
| `columns[].state` | `done` (both teams recorded), `live`, or `open` |
| `columns[].extra` | True for a column past the regular innings |
| `teams[].name` | Exactly as typed. Set it with `textContent`, because chat can set it |
| `teams[].scores[]` | One per column. `null` means not recorded, which isn't the same as `0` |
| `teams[].total` | Already added up |
| `lead` | `0`, `1`, or `null` for a tie |
| `over` | The match is finished. `over` with `lead: null` is a draw |
| `labels[]` | The three counts, with their current names. Show the ones with `on: true` |
| `settings` | For the control panel. Themes don't need it |

**A theme never computes rules.** Columns, totals, who leads and whether the match is over all arrive worked out, so every theme and the panel always agree. A new column can appear at any time, so build from `columns.length` on every update.

`panel-core` also toggles the class `offline` on `<body>` when the connection to Streamer.bot drops. A frozen score asserts a stale fact, so dim the board.

## A complete theme from scratch

Save this as `frames-themes/mytheme/board.html`. It's complete and runs as is:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>My Board</title>
<link rel="icon" href="data:,">
<style>
  html, body { margin: 0; background: transparent; font: 600 24px "Segoe UI", system-ui, sans-serif; color: #fff; }
  #board { border-collapse: separate; border-spacing: 3px; }
  #board.hidden { display: none; }
  body.offline #board { opacity: .35; }
  th, td { min-width: 44px; padding: 6px 10px; background: #101318; text-align: center; font-size: 18px; }
  td { font-size: 28px; }
  td.name { text-align: left; font-size: 22px; white-space: nowrap; }
  td.total { background: #3b82f6; }
  td.total.lead { background: #e0a100; color: #101318; }
  th.live { color: #e0a100; }
</style>
</head>
<body>
<table id="board"></table>
<script>
  var board = document.getElementById('board');

  function cell(tag, text, cls) {
    var n = document.createElement(tag);
    n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function render(s) {
    board.classList.toggle('hidden', s.hidden);
    board.textContent = '';

    var head = board.insertRow();
    head.appendChild(cell('th', s.title));
    s.columns.forEach(function (c) { head.appendChild(cell('th', c.label, c.state === 'live' ? 'live' : '')); });
    head.appendChild(cell('th', s.totalLabel));

    s.teams.forEach(function (team, t) {
      var row = board.insertRow();
      row.appendChild(cell('td', team.name, 'name'));
      team.scores.forEach(function (v) { row.appendChild(cell('td', v === null ? '' : v)); });
      row.appendChild(cell('td', team.total, 'total' + (s.lead === t ? ' lead' : '')));
    });
  }

  window.addEventListener('linescore:update', function (e) { render(e.detail); });
</script>
<script src="/frames-shared/panel-core.js"></script>
</body>
</html>
```

Add an OBS Browser Source at this URL. Size it to fit your board, and leave OBS's own CSS box empty.

```
http://127.0.0.1:7474/frames-themes/mytheme/board.html
```

For polish beyond this, such as shrinking long names to fit, read [`frames-themes/ballpark/theme.js`](../frames-themes/ballpark/theme.js).

## Reskin with CSS only

If you like Ballpark's layout, you don't need a new theme. Every color and font is a variable at the top of its `theme.css`, so a skin is a short file of overrides in `frames-themes/ballpark/skins/`, chosen with `?skin=<name>` in the source's URL. Skin names can use lowercase letters, digits and hyphens.

A hand-painted outfield board, [`skins/crosley.css`](../frames-themes/ballpark/skins/crosley.css), which also needs one override because its name cells are light:

```css
:root {
  --bp-panel: #c8102e;
  --bp-frame: #f2e9dc;
  --bp-cell: #f7f2e8;
  --bp-text: #fbf7ef;
  --bp-digit: #2a2a2e;
  --bp-zero: #8d8a84;
  --bp-lead: #c8102e;
  --bp-live: #ffe08a;
  --bp-font: Stencil, Impact, "Arial Narrow", sans-serif;
  --bp-digit-font: Stencil, Impact, "Arial Narrow", sans-serif;
  --bp-radius: 0;
}
.bp-name { color: #2a2a2e; font-weight: 400; }
```

A school-field electronic board, [`skins/led.css`](../frames-themes/ballpark/skins/led.css):

```css
:root {
  --bp-panel: #ef7d22;
  --bp-frame: #ffffff;
  --bp-cell: #0d0d0d;
  --bp-text: #ffffff;
  --bp-digit: #f0261a;
  --bp-zero: #7a1c16;
  --bp-lead: #ffb300;
  --bp-live: #ffb300;
  --bp-font: "Arial Black", Arial, sans-serif;
  --bp-digit-font: "Courier New", Consolas, monospace;
  --bp-radius: 0;
}
.bp-title, .bp-head, .bp-label { font-style: italic; }
.bp-cell, .bp-total, .bp-label b { font-weight: 700; font-style: normal; }
```

## The dev loop, with no Streamer.bot

```bash
npm install
```

```bash
npm start
```

That runs a mock of Streamer.bot's two servers. Open `http://127.0.0.1:7474/`: your theme appears in the index if you add a `manifest.json` beside it. It's optional, and only the index uses it:

```json
{
  "name": "mytheme",
  "displayName": "My Theme",
  "panels": [{ "file": "board.html", "label": "Board", "width": 1000, "height": 300 }]
}
```

Drive it with the mock's console keys (`q`/`a` team 1 ±, `w`/`s` team 2 ±, `n` next, `1`/`2` win, `z` undo, `r` reset), the control panel linked from the index, or any command over HTTP:

```
http://127.0.0.1:7474/mock/cmd?command=preset&value=sfl
http://127.0.0.1:7474/mock/cmd?command=t1win&source=panel
```

When it looks right, the same files work on the real Streamer.bot.

## OBS notes

- After editing panel JS or CSS, right-click the source and choose **Refresh cache of current page**, because CEF caches aggressively.
- Serve panels over `http://` as above, not as local files, unless you also vendor `panel-core.js` and load it by a relative path, as the NFC kit does.
- Web fonts work, but they fall back to system fonts when the machine is offline. Re-fit any measured text on `document.fonts.ready`.
