// Compiles the REAL action files with csc.exe against a fake CPH and runs them through
// test/scenarios.json, the same table the JS rules run. Windows only.
//
// /noconfig matters: it skips csc.rsp, so only mscorlib is referenced. Streamer.bot's
// default C# reference set is minimal too, and a type outside it (Regex, Stack<T>, Uri)
// compiles here only if it would also need an added reference there, which it must not.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStep } from './test/subset.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CSC = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';

let passed = 0, failed = 0;
function check(ok, name, detail) {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ' — ' + detail : ''}`);
}
function finish() {
  console.log(failed ? `${failed} of ${passed + failed} failed` : `all ${passed} passed`);
  process.exit(failed ? 1 : 0);
}

// 1. The pasteable files must be what the sources build.
const built = spawnSync(process.execPath, [join(ROOT, 'tools', 'build-actions.mjs'), '--check'], { encoding: 'utf8' });
check(built.status === 0, 'generated actions match actions/src', (built.stderr || built.stdout || built.error?.message || '').trim());
if (built.status !== 0) finish();

// 2. Nothing that would need an added reference in Streamer.bot.
const FILES = { Command: 'linescore-command.cs', Push: 'linescore-push.cs' };
const sources = Object.fromEntries(Object.entries(FILES).map(([ns, f]) => [ns, readFileSync(join(ROOT, 'actions', f), 'utf8')]));
for (const [ns, src] of Object.entries(sources)) {
  check(!/Newtonsoft|System\.Uri|\bUri\b/.test(src), `${FILES[ns]} uses no Newtonsoft or Uri`);
  check(src.includes('public class CPHInline'), `${FILES[ns]} declares CPHInline`);
}

// 3. Compile.
if (!existsSync(CSC)) { check(false, 'csc.exe is installed', CSC); finish(); }
const work = mkdtempSync(join(tmpdir(), 'frames-cs-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
const compileFiles = [];
for (const [ns, src] of Object.entries(sources)) {
  const file = join(work, FILES[ns]);
  writeFileSync(file, `namespace ${ns} {\n${src.replace('public class CPHInline', 'public partial class CPHInline')}\n}\n`, 'utf8');
  compileFiles.push(file);
}
compileFiles.push(resolve(ROOT, 'test/cs/FakeCph.cs'), resolve(ROOT, 'test/cs/Driver.cs'));
const exe = join(work, 'driver.exe');
const csc = spawnSync(CSC, ['/noconfig', '/nologo', '/codepage:65001', '/target:exe', `/out:${exe}`, '/warn:4', ...compileFiles], { encoding: 'utf8' });
check(csc.status === 0, 'compiles under C# 5 with mscorlib only', (csc.stdout || '').split('\n').filter((l) => /error/.test(l)).slice(0, 8).join('\n'));
const warnings = (csc.stdout || '').split('\n').filter((l) => /warning CS/.test(l));
check(warnings.length === 0, 'compiles with no warnings', warnings.slice(0, 8).join('\n'));
if (csc.status !== 0) finish();

// ── Driving the actions ──────────────────────────────────────────────────────
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const run = (args) => ['RUN', ...Object.entries(args).map(([k, v]) => `${b64(k)}:${b64(v)}`)].join('\t');
const seed = (k, v) => `SEED\t${b64(k)}\t${b64(v)}`;

function drive(lines) {
  const r = spawnSync(exe, [], { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`driver failed: ${r.stderr || r.stdout}`);
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const f = l.split('\t');
    return { json: unb64(f[1]), warns: Number(f[2]), ok: f[3] === 'True', broadcasts: Number(f[4]) };
  });
}

// 4. The scenario table.
const scenarios = JSON.parse(readFileSync(join(ROOT, 'test/scenarios.json'), 'utf8'));
for (const scenario of scenarios) {
  const lines = ['RESET', ...Object.entries(scenario.seed || {}).map(([k, v]) => seed(k, v)), 'PUSH'];
  for (const step of scenario.steps) {
    if (!step.cmd) { lines.push('PUSH'); continue; }
    const args = { command: step.cmd, value: step.value ?? '', ...(step.args || {}) };
    if (step.source) args.source = step.source;
    if (step.now !== undefined) args._now = step.now;
    lines.push(run(args));
  }
  let miss = null;
  try {
    const out = drive(lines);
    let previous = JSON.parse(out[0].json);
    scenario.steps.forEach((step, i) => {
      if (miss) return;
      let payload;
      try { payload = JSON.parse(out[i + 1].json); } catch (e) { miss = `step ${i}: invalid JSON: ${e.message}`; return; }
      const wrong = checkStep(step, payload, step.cmd ? out[i + 1].warns > 0 : false, previous);
      if (wrong) miss = `step ${i} (${step.cmd || 'no command'} ${step.value ?? ''}): ${wrong}`;
      previous = payload;
    });
  } catch (e) { miss = e.message; }
  check(!miss, `scenario ${scenario.name}`, miss);
}

// 5. The three calling styles reach the same result.
const styles = {
  'dispatch (!ls t1 3 20)': { command: '!ls', input0: 't1', rawInput: 't1 3 20' },
  'dedicated (!t1 3 20)': { command: '!t1', rawInput: '3 20' },
  'Stream Deck (command + value)': { command: 't1', value: '3 20' },
};
for (const [name, args] of Object.entries(styles)) {
  const [out] = drive(['RESET', run(args)]);
  check(JSON.parse(out.json).teams[0].scores[2] === 20, `calling style: ${name}`, out.json.slice(0, 200));
}
const [plus] = drive(['RESET', run({ command: '!t1+', rawInput: '' })]);
check(JSON.parse(plus.json).teams[0].scores[0] === 1, 'calling style: dedicated !t1+', plus.json.slice(0, 200));
const [dispatchName] = drive(['RESET', run({ command: '!ls', input0: 't1name', rawInput: 't1name Team East Coast' })]);
check(JSON.parse(dispatchName.json).teams[0].name === 'Team East Coast', 'calling style: dispatch keeps a multi-word value');

// 6. JSON round trip: awkward team names survive exactly (Review Focus).
for (const name of ['Team "East" \\ Coast', 'Line\nBreak', 'Tab\there', 'NFC | Phoxx', 'Ünï 🥊 名前', 'ends with \\']) {
  const [out] = drive(['RESET', run({ command: 'setmany', t1name: name })]);
  let got = null;
  try { got = JSON.parse(out.json).teams[0].name; } catch (e) { got = 'invalid JSON: ' + e.message; }
  check(got === name, `JSON round trip: ${JSON.stringify(name)}`, JSON.stringify(got));
}

// 7. A hand-edited global can't stop the board: a number in a string variable still reads,
//    and an unreadable one falls back to its default.
const [typed] = drive(['RESET', `SEEDINT\t${b64('ls.innings')}\t${b64('5')}`, 'PUSH']);
check(JSON.parse(typed.json).columns?.length === 5, 'a global stored as a number still reads', typed.json.slice(0, 120));
const [typedCmd] = drive(['RESET', `SEEDINT\t${b64('ls.innings')}\t${b64('5')}`, run({ command: 't1', value: '1 7' })]);
check(typedCmd.ok && JSON.parse(typedCmd.json).teams?.[0].scores[0] === 7, 'and a command still works alongside it', typedCmd.json.slice(0, 120));
const [unreadable] = drive(['RESET', 'THROW\t1', 'PUSH']);
check(JSON.parse(unreadable.json).columns?.length === 9 && unreadable.ok, 'an unreadable global falls back to its default', unreadable.json.slice(0, 120));

// 8. A failing push tells the overlays instead of going quiet.
const failing = drive(['RESET', 'FAILBROADCAST', 'PUSH']);
const failure = JSON.parse(failing[0].json);
check(failure.type === 'linescore:error' && typeof failure.message === 'string', 'a push failure broadcasts linescore:error', failing[0].json);
check(failing[0].ok === false && failing[0].warns === 1 && failing[0].broadcasts === 1, 'a push failure logs once and returns false', JSON.stringify(failing[0]));

finish();
