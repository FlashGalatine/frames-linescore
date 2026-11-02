// The scoring rules, in JS, for the mock server and the verify suites. The real rules
// live in actions/src/rules.cs and command.cs; test/scenarios.json runs against both,
// so a change here without the matching change there fails verify-cs.mjs.
//
// `state` is a flat map using the exact Streamer.bot global variable names. A missing
// key reads as its default, the way GetGlobalVar returning null does in the C#.

export const MAX_COLUMNS = 12;
export const CELL_MAX = 99;
export const UNDO_MAX = 20;
export const CHAT_WIN_GUARD_MS = 5000;

const LABEL_KEYS = ['ball', 'strike', 'out'];
const LABEL_NAMES = { ball: 'Ball', strike: 'Strike', out: 'Out' };

export const TOKENS = [
  't1win', 't2win', 'undo', 't1', 't2', 't1+', 't1-', 't2+', 't2-', 'next',
  't1name', 't2name', 'innings', 'worth', 'free', 'extra',
  'ball', 'strike', 'out', 'title', 'collabel', 'extralabel', 'totallabel',
  'preset', 'reset', 'hide', 'show', 'setmany',
];

export function createState(seed = {}) {
  return { ...seed };
}

function get(state, key, dflt) {
  const v = state[key];
  return v === undefined || v === null ? dflt : v;
}

// Only whole, plain numbers count, matching int.TryParse with AllowLeadingSign after a
// trim: "7" yes, "7x", "1.5" and anything past int's range no.
function parseIntStrict(s) {
  const t = String(s ?? '').trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  return Math.abs(n) > 2147483647 ? null : n;
}

// ls.lastwin holds a millisecond clock, which is past int's range (long in the C#).
function parseMillis(s) {
  const t = String(s ?? '').trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function parseScores(csv) {
  const parts = String(csv ?? '').split(',').slice(0, MAX_COLUMNS);
  return parts.map((p) => {
    const n = parseIntStrict(p);
    return n === null ? null : clamp(n, 0, CELL_MAX);
  });
}

function joinScores(cells) {
  const out = cells.slice();
  while (out.length && (out[out.length - 1] === null || out[out.length - 1] === undefined)) out.pop();
  return out.map((c) => (c === null || c === undefined ? '' : String(c))).join(',');
}

function parseWorth(csv) {
  const t = String(csv ?? '').trim();
  if (!t) return [];
  return t.split(',').map((p) => {
    const n = parseIntStrict(p);
    return n === null ? 0 : clamp(n, 0, CELL_MAX);
  });
}

function derive(state) {
  const parsedInnings = parseIntStrict(get(state, 'ls.innings', '9'));
  const innings = clamp(parsedInnings === null ? 9 : parsedInnings, 1, MAX_COLUMNS);
  const fixed = get(state, 'ls.mode', 'free') === 'fixed';
  const worth = parseWorth(get(state, 'ls.worth', ''));
  const parsedExtra = parseIntStrict(get(state, 'ls.extraworth', '5'));
  const extraWorth = parsedExtra === null ? 5 : clamp(parsedExtra, 0, CELL_MAX);
  const extraOn = get(state, 'ls.extra', 'on') !== 'off';
  const cells = [parseScores(get(state, 'ls.t1scores', '')), parseScores(get(state, 'ls.t2scores', ''))];
  const cell = (t, i) => { const v = cells[t][i]; return v === undefined ? null : v; };
  const total = (t) => cells[t].reduce((sum, v) => sum + (v || 0), 0);
  const totals = [total(0), total(1)];

  let highest = -1;
  for (let i = 0; i < MAX_COLUMNS; i++) if (cell(0, i) !== null || cell(1, i) !== null) highest = i;
  let shown = Math.max(innings, highest + 1);

  const recorded = (i) => cell(0, i) !== null && cell(1, i) !== null;
  const allRecorded = (n) => { for (let i = 0; i < n; i++) if (!recorded(i)) return false; return true; };
  while (allRecorded(shown) && totals[0] === totals[1] && extraOn && shown < MAX_COLUMNS) shown++;

  const over = allRecorded(shown);
  const lead = totals[0] > totals[1] ? 0 : totals[1] > totals[0] ? 1 : null;
  let live = null;
  if (!over) {
    if (fixed) {
      for (let i = 0; i < shown; i++) if (!recorded(i)) { live = i; break; }
    } else {
      const stored = parseIntStrict(get(state, 'ls.live', '0'));
      live = clamp(stored === null ? 0 : stored, 0, shown - 1);
    }
  }
  const tiedAtCap = over && totals[0] === totals[1] && extraOn && shown === MAX_COLUMNS;
  return { innings, fixed, worth, extraWorth, extraOn, cells, cell, totals, shown, over, lead, live, recorded, tiedAtCap };
}

function columnWorth(d, i) {
  if (!d.fixed) return null;
  return i < d.innings && i < d.worth.length ? d.worth[i] : d.extraWorth;
}

function columnLabel(state, d, i) {
  if (i < d.innings) {
    const prefix = get(state, 'ls.collabel', '');
    return prefix ? `${prefix} ${i + 1}` : String(i + 1);
  }
  const extra = get(state, 'ls.extralabel', '');
  if (!extra) return String(i + 1);
  const ordinal = i - d.innings + 1;
  return ordinal === 1 ? extra : `${extra} ${ordinal}`;
}

export function buildPayload(state) {
  const d = derive(state);
  const columns = [];
  for (let i = 0; i < d.shown; i++) {
    columns.push({
      label: columnLabel(state, d, i),
      worth: columnWorth(d, i),
      state: i === d.live ? 'live' : d.recorded(i) ? 'done' : 'open',
      extra: i >= d.innings,
    });
  }
  const team = (t, nameKey, dflt) => {
    const scores = [];
    for (let i = 0; i < d.shown; i++) scores.push(d.cell(t, i));
    return { name: get(state, nameKey, dflt), scores, total: d.totals[t] };
  };
  const labels = LABEL_KEYS.map((key) => {
    const v = parseIntStrict(get(state, `ls.${key}.value`, '0'));
    return {
      key,
      name: get(state, `ls.${key}.name`, LABEL_NAMES[key]),
      value: v === null ? 0 : clamp(v, 0, CELL_MAX),
      on: get(state, `ls.${key}.on`, '1') !== '0',
    };
  });
  return {
    type: 'linescore:update',
    title: get(state, 'ls.title', ''),
    totalLabel: get(state, 'ls.totallabel', 'R'),
    mode: d.fixed ? 'fixed' : 'free',
    hidden: get(state, 'ls.hidden', '0') === '1',
    columns,
    teams: [team(0, 'ls.t1name', 'Visitor'), team(1, 'ls.t2name', 'Home')],
    lead: d.lead,
    over: d.over,
    labels,
    // For the control panel. Themes don't need this.
    settings: {
      innings: d.innings,
      worth: d.worth,
      extraWorth: d.extraWorth,
      extraOn: d.extraOn,
      colLabel: get(state, 'ls.collabel', ''),
      extraLabel: get(state, 'ls.extralabel', ''),
    },
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────

const snapshot = (state) => [get(state, 'ls.t1scores', ''), get(state, 'ls.t2scores', ''), get(state, 'ls.live', '0')].join('|');

function pushUndo(state, snap) {
  const lines = String(get(state, 'ls.undo', '')).split('\n').filter((l) => l.split('|').length === 3);
  lines.push(snap);
  state['ls.undo'] = lines.slice(-UNDO_MAX).join('\n');
}

function setCell(state, t, i, v) {
  const key = t === 0 ? 'ls.t1scores' : 'ls.t2scores';
  const cells = parseScores(get(state, key, ''));
  while (cells.length <= i) cells.push(null);
  cells[i] = v;
  state[key] = joinScores(cells);
}

function clearScores(state) {
  state['ls.t1scores'] = '';
  state['ls.t2scores'] = '';
  state['ls.live'] = '0';
  state['ls.undo'] = '';
  state['ls.lastwin'] = '';
}

function resetLabelValues(state) {
  for (const key of LABEL_KEYS) state[`ls.${key}.value`] = '0';
}

function applyPreset(state, which) {
  const sfl = which === 'sfl';
  state['ls.mode'] = sfl ? 'fixed' : 'free';
  state['ls.innings'] = sfl ? '3' : '9';
  state['ls.worth'] = sfl ? '10,10,20' : '';
  state['ls.extraworth'] = '5';
  state['ls.extra'] = 'on';
  state['ls.collabel'] = sfl ? 'SET' : '';
  state['ls.extralabel'] = sfl ? 'EXTRA' : '';
  state['ls.totallabel'] = sfl ? 'TOTAL' : 'R';
  state['ls.title'] = sfl ? 'TEAM BATTLE' : '';
  for (const key of LABEL_KEYS) {
    state[`ls.${key}.on`] = sfl ? '0' : '1';
    state[`ls.${key}.name`] = LABEL_NAMES[key];
  }
  resetLabelValues(state);
  clearScores(state);
}

const REJECT = { ok: false, warn: true };

export function applyCommand(state, tokenIn, valueIn = '', args = {}) {
  const token = String(tokenIn ?? '').trim().toLowerCase();
  const value = String(valueIn ?? '').trim();
  const before = derive(state);
  const result = run(state, token, value, args, before);
  if (result.ok && !before.tiedAtCap && derive(state).tiedAtCap) return { ok: true, warn: true };
  return result;
}

function run(state, token, value, args, d) {
  const scoring = (fn) => {
    const snap = snapshot(state);
    fn();
    if (snapshot(state) !== snap) pushUndo(state, snap);
    return { ok: true, warn: false };
  };

  const win = /^t([12])win$/.exec(token);
  if (win) {
    if (!d.fixed || d.live === null) return REJECT;
    const nowMs = args._now !== undefined ? Number(args._now) : Date.now();
    const last = parseMillis(get(state, 'ls.lastwin', ''));
    if (args.source !== 'panel' && last !== null && nowMs - last >= 0 && nowMs - last < CHAT_WIN_GUARD_MS) return REJECT;
    const winner = Number(win[1]) - 1;
    return scoring(() => {
      setCell(state, winner, d.live, columnWorth(d, d.live));
      setCell(state, 1 - winner, d.live, 0);
      state['ls.lastwin'] = String(nowMs);
    });
  }

  const step = /^t([12])([+-])$/.exec(token);
  if (step) {
    if (d.live === null) return REJECT;
    const t = Number(step[1]) - 1;
    const cur = d.cell(t, d.live) || 0;
    return scoring(() => setCell(state, t, d.live, clamp(cur + (step[2] === '+' ? 1 : -1), 0, CELL_MAX)));
  }

  const direct = /^t([12])$/.exec(token);
  if (direct) {
    const parts = value.split(/\s+/);
    if (parts.length !== 2) return REJECT;
    const n = parseIntStrict(parts[0]);
    if (n === null || n < 1 || n > MAX_COLUMNS) return REJECT;
    let v = null;
    if (parts[1] !== '-') {
      v = parseIntStrict(parts[1]);
      if (v === null) return REJECT;
      v = clamp(v, 0, CELL_MAX);
    }
    return scoring(() => setCell(state, Number(direct[1]) - 1, n - 1, v));
  }

  if (LABEL_KEYS.includes(token)) {
    if (!value) return REJECT;
    const lower = value.toLowerCase();
    if (lower === 'on' || lower === 'off') { state[`ls.${token}.on`] = lower === 'on' ? '1' : '0'; return { ok: true, warn: false }; }
    const named = /^name\s+(.+)$/i.exec(value);
    if (named) { state[`ls.${token}.name`] = named[1].trim(); return { ok: true, warn: false }; }
    const n = parseIntStrict(value);
    if (n === null) return REJECT;
    state[`ls.${token}.value`] = String(clamp(n, 0, CELL_MAX));
    return { ok: true, warn: false };
  }

  switch (token) {
    case 'undo': {
      const lines = String(get(state, 'ls.undo', '')).split('\n').filter((l) => l.split('|').length === 3);
      if (!lines.length) return REJECT;
      const [t1, t2, live] = lines.pop().split('|');
      state['ls.t1scores'] = t1;
      state['ls.t2scores'] = t2;
      state['ls.live'] = live;
      state['ls.undo'] = lines.join('\n');
      state['ls.lastwin'] = '';
      return { ok: true, warn: false };
    }
    case 'next':
      if (d.fixed || d.live === null) return REJECT;
      return scoring(() => {
        if (d.cell(0, d.live) === null) setCell(state, 0, d.live, 0);
        if (d.cell(1, d.live) === null) setCell(state, 1, d.live, 0);
        state['ls.live'] = String(d.live + 1);
      });
    case 't1name': state['ls.t1name'] = value; return { ok: true, warn: false };
    case 't2name': state['ls.t2name'] = value; return { ok: true, warn: false };
    case 'innings': {
      const n = parseIntStrict(value);
      if (n === null) return REJECT;
      const innings = clamp(n, 1, MAX_COLUMNS);
      state['ls.innings'] = String(innings);
      return { ok: true, warn: d.fixed && innings > d.worth.length };
    }
    case 'worth': {
      const parts = value ? value.split(/\s+/) : [];
      const list = [];
      let extra = null;
      for (const p of parts) {
        const x = /^x(.+)$/i.exec(p);
        const n = parseIntStrict(x ? x[1] : p);
        if (n === null) return REJECT;
        if (x) extra = clamp(n, 0, CELL_MAX); else list.push(clamp(n, 0, CELL_MAX));
      }
      if (!list.length || list.length > MAX_COLUMNS) return REJECT;
      state['ls.mode'] = 'fixed';
      state['ls.worth'] = list.join(',');
      state['ls.innings'] = String(list.length);
      if (extra !== null) state['ls.extraworth'] = String(extra);
      return { ok: true, warn: false };
    }
    case 'free':
      state['ls.live'] = String(d.live === null ? d.shown - 1 : d.live);
      state['ls.mode'] = 'free';
      return { ok: true, warn: false };
    case 'extra': {
      const lower = value.toLowerCase();
      if (lower !== 'on' && lower !== 'off') return REJECT;
      state['ls.extra'] = lower;
      return { ok: true, warn: false };
    }
    case 'title': state['ls.title'] = value; return { ok: true, warn: false };
    case 'collabel': state['ls.collabel'] = value; return { ok: true, warn: false };
    case 'extralabel': state['ls.extralabel'] = value; return { ok: true, warn: false };
    case 'totallabel': state['ls.totallabel'] = value; return { ok: true, warn: false };
    case 'preset': {
      const which = value.toLowerCase();
      if (which !== 'sfl' && which !== 'baseball') return REJECT;
      applyPreset(state, which);
      return { ok: true, warn: false };
    }
    case 'reset':
      clearScores(state);
      resetLabelValues(state);
      return { ok: true, warn: false };
    case 'hide': state['ls.hidden'] = '1'; return { ok: true, warn: false };
    case 'show': state['ls.hidden'] = '0'; return { ok: true, warn: false };
    case 'setmany': {
      let any = false;
      const text = { t1name: 'ls.t1name', t2name: 'ls.t2name', title: 'ls.title', collabel: 'ls.collabel', extralabel: 'ls.extralabel', totallabel: 'ls.totallabel', ballname: 'ls.ball.name', strikename: 'ls.strike.name', outname: 'ls.out.name' };
      for (const [arg, key] of Object.entries(text)) {
        if (args[arg] !== undefined && args[arg] !== null) { state[key] = String(args[arg]).trim(); any = true; }
      }
      return any ? { ok: true, warn: false } : REJECT;
    }
    default:
      return REJECT;
  }
}
