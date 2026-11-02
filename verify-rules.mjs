// Runs every scenario in test/scenarios.json through the JS rules (rules.mjs). The real
// C# actions run the same table in verify-cs.mjs, which is what keeps the two in step.

import { readFile } from 'node:fs/promises';
import { checkStep } from './test/subset.mjs';
import { createState, applyCommand, buildPayload } from './rules.mjs';

const scenarios = JSON.parse(await readFile(new URL('./test/scenarios.json', import.meta.url), 'utf8'));
let passed = 0, failed = 0;

for (const scenario of scenarios) {
  const state = createState(scenario.seed || {});
  let previous = buildPayload(state);
  let miss = null;
  scenario.steps.forEach((step, i) => {
    if (miss) return;
    let warned = false;
    if (step.cmd) {
      const args = { ...(step.args || {}) };
      if (step.source) args.source = step.source;
      if (step.now !== undefined) args._now = step.now;
      warned = applyCommand(state, step.cmd, step.value ?? '', args).warn;
    }
    const payload = buildPayload(state);
    const wrong = checkStep(step, payload, warned, previous);
    if (wrong) miss = `step ${i} (${step.cmd || 'no command'} ${step.value ?? ''}): ${wrong}`;
    previous = payload;
  });
  if (miss) { failed++; console.log(`FAIL ${scenario.name} — ${miss}`); }
  else { passed++; console.log(`PASS ${scenario.name}`); }
}

console.log(failed ? `${failed} of ${passed + failed} failed` : `all ${passed} passed`);
process.exit(failed ? 1 : 0);
