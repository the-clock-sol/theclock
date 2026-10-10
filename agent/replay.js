#!/usr/bin/env node
// Replay a house experiment from its public record and confirm the server's verdict.
//   node agent/replay.js --server http://localhost:8787 --id 123
// Fetches the experiment, its parent circuit (the best circuit before it ran, by hash,
// found through the experiment that produced it), re-runs the same seed through the same
// operators, and prints whether the status and score match.

import { MODELS } from '../lib/models.js';
import { parse, hashCircuit } from '../lib/circuit.js';
import { runExperiment } from '../lib/runner.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : [])).filter((x) => x.length));
const server = args.server || process.env.CLOCK_SERVER || 'http://localhost:8787';
const get = async (p) => { const r = await fetch(server + p); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };

const exp = await get('/api/quantum/experiments/' + args.id);
if (!exp.seed) { console.log('experiment has no seed (baseline or external submission); use agent/verify.js on its circuit'); process.exit(0); }
const model = MODELS[exp.model];
// the parent is whichever stored circuit has the parent hash
const all = await get('/api/quantum/experiments?model=' + exp.model + '&limit=200&before=' + (exp.id + 1));
let parent = null;
for (const e of all) {
  if (e.hash === exp.parent_hash) { const full = await get('/api/quantum/experiments/' + e.id); if (full.circuit) { parent = parse(full.circuit); break; } }
}
if (!parent) { console.log('parent circuit not found among the last 200 experiments; replay needs it'); process.exit(1); }
console.log(`parent hash ${hashCircuit(parent)} matches: ${hashCircuit(parent) === exp.parent_hash}`);
const r = runExperiment({ model, parent, seed: exp.seed });
console.log(`server: ${exp.status} score ${exp.score}   replay: ${r.status} score ${r.score ?? '—'}   ops ${r.ops.map((o) => o.op).join('+')}`);
console.log(r.status === exp.status && (r.score ?? null) === (exp.score ?? null) ? 'MATCH' : 'MISMATCH');
