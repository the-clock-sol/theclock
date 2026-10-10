// One experiment: seed -> a short sequence of mutation operators applied to the current best
// circuit -> exhaustive verification -> score -> ACCEPTED / NEUTRAL / REJECTED / INVALID.
// Pure and deterministic: the same (model, parent circuit, seed) always gives the same result,
// which is what lets anyone replay an experiment from its public record.

import { rng } from './prng.js';
import { verify, score, wellFormed, hashCircuit } from './circuit.js';
import { OPERATORS, OPERATOR_NAMES } from './optimize.js';

export const STATUS = { ACCEPTED: 'ACCEPTED', NEUTRAL: 'NEUTRAL', REJECTED: 'REJECTED', INVALID: 'INVALID' };

// Compare a candidate against the incumbent on the public metric, then on gate count.
export function compare(model, candidate, incumbent) {
  const c = score(model, candidate), b = score(model, incumbent);
  if (c.score < b.score) return STATUS.ACCEPTED;
  if (c.score === b.score && c.gates < b.gates) return STATUS.NEUTRAL;
  return STATUS.REJECTED;
}

export function runExperiment({ model, parent, seed, maxOps = 3 }) {
  const t0 = Date.now();
  const r = rng('exp:' + seed);
  const nOps = 1 + r.int(maxOps);
  let gates = parent;
  const ops = [];
  for (let k = 0; k < nOps; k++) {
    const name = r.pick(OPERATOR_NAMES);
    const res = OPERATORS[name](gates, r, model);
    if (!res) { ops.push({ op: name, result: 'nothing to do' }); continue; }
    const { gates: g, ...info } = res;
    ops.push(info);
    gates = g;
  }
  const changed = gates !== parent;
  if (!changed) {
    return { seed, ops, status: STATUS.REJECTED, reason: 'no change', ms: Date.now() - t0, parentHash: hashCircuit(parent) };
  }
  return judge({ model, parent, candidate: gates, seed, ops, t0 });
}

// Shared by the house runner and external submissions: the server never trusts a score it
// did not compute itself.
export function judge({ model, parent, candidate, seed = null, ops = [], t0 = Date.now() }) {
  const base = { seed, ops, parentHash: hashCircuit(parent) };
  if (!wellFormed(model, candidate)) return { ...base, status: STATUS.INVALID, reason: 'malformed circuit', ms: Date.now() - t0 };
  const maxGates = Math.max(64, 4 * parent.length);
  if (candidate.length > maxGates) return { ...base, status: STATUS.INVALID, reason: 'candidate has ' + candidate.length + ' gates, limit ' + maxGates, ms: Date.now() - t0 };
  const v = verify(model, candidate);
  const sc = score(model, candidate);
  if (!v.ok) return { ...base, status: STATUS.INVALID, reason: `fails specification on ${v.failures.length}+ of ${v.checked} inputs`, failures: v.failures, ...sc, checked: v.checked, ms: Date.now() - t0 };
  const status = compare(model, candidate, parent);
  return { ...base, status, ...sc, checked: v.checked, candidate, hash: hashCircuit(candidate), ms: Date.now() - t0 };
}
