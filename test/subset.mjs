// Shared by verify-rules.mjs (the JS rules) and verify-cs.mjs (the real C#), so both
// judge the scenario table the same way.

// Deep subset: null when `actual` holds everything in `expected`, else where it differs.
// Arrays match by index, so an expected array may be shorter than the actual one.
export function subset(actual, expected, path = '') {
  if (expected === null || typeof expected !== 'object') {
    return actual === expected ? null : `${path || 'value'}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`;
  }
  if (actual === null || typeof actual !== 'object') return `${path || 'value'}: got ${JSON.stringify(actual)}, want an object`;
  for (const key of Object.keys(expected)) {
    const miss = subset(actual[key], expected[key], path ? `${path}.${key}` : key);
    if (miss) return miss;
  }
  return null;
}

// Judges one step's outcome. Returns null, or a description of the first mismatch.
export function checkStep(step, payload, warned, previous) {
  if (step.warn !== undefined && step.warn !== warned) return `warn: got ${warned}, want ${step.warn}`;
  if (step.unchanged && JSON.stringify(payload) !== JSON.stringify(previous)) return 'the payload changed, and it should not have';
  if (step.columns !== undefined && payload.columns.length !== step.columns) return `columns: got ${payload.columns.length}, want ${step.columns}`;
  if (step.live !== undefined) {
    const at = payload.columns.findIndex((c) => c.state === 'live');
    const got = at < 0 ? null : at;
    if (got !== step.live) return `live: got ${got}, want ${step.live}`;
  }
  return step.expect ? subset(payload, step.expect) : null;
}
