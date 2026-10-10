#!/usr/bin/env node
// Run your own research agent against THE CLOCK and put your handle on the record.
//
//   node agent/run.js --server http://localhost:8787 --handle your_name --token <token> [--model modadd6p61] [--rate 20]
//
// It pulls the current best circuit for the model, runs the same mutation operators the
// house agents use at full local speed (`--rate` experiments per second), and submits every
// strict improvement it finds. The server re-verifies and re-scores every submission; your
// local score is only a hint. Swap in your own operators in lib/optimize.js, or generate
// candidates any way you like and POST them to /api/quantum/submit as circuit text.

import { MODELS } from '../lib/models.js';
import { parse, serialize, score } from '../lib/circuit.js';
import { runExperiment, STATUS } from '../lib/runner.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : [])).filter((x) => x.length));
const server = args.server || process.env.CLOCK_SERVER || 'http://localhost:8787';
const handle = args.handle, token = args.token;
if (!handle || !token) { console.error('need --handle and --token (claim one at POST /api/handle)'); process.exit(1); }
const rate = Number(args.rate || 20);
const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

const get = async (p) => { const r = await fetch(server + p); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
const post = async (p, b) => { const r = await fetch(server + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };

const modelName = args.model || (await get('/api/quantum/state')).model.name;
const model = MODELS[modelName];
if (!model) { console.error('unknown model ' + modelName + '; known: ' + Object.keys(MODELS).join(', ')); process.exit(1); }

let remote = await get('/api/quantum/best?model=' + modelName);
let best = parse(remote.circuit);
log(`${handle} on ${modelName}: server best ${remote.score} (${remote.qubits}q × ${remote.toffoli}T), ${rate} experiments/s locally`);

let n = 0, lastSync = Date.now();
while (true) {
  const seed = `${handle}:${Date.now()}:${n++}`;
  const r = runExperiment({ model, parent: best, seed });
  if (r.status === STATUS.ACCEPTED || r.status === STATUS.NEUTRAL) {
    best = r.candidate;
    if (r.status === STATUS.ACCEPTED) {
      try {
        const res = await post('/api/quantum/submit', { model: modelName, circuit: serialize(best), handle, token, note: r.ops.map((o) => o.op).join('+') });
        log(`submitted score ${r.score} → server says ${res.status}${res.reason ? ' (' + res.reason + ')' : ''}`);
      } catch (e) { log('submit failed: ' + e.message); }
    }
  }
  if (Date.now() - lastSync > 15000) { // keep in step with other agents' wins
    try {
      const fresh = await get('/api/quantum/best?model=' + modelName);
      if (fresh.score < score(model, best).score) { best = parse(fresh.circuit); log(`synced: server best is now ${fresh.score}`); }
    } catch {}
    lastSync = Date.now();
  }
  await new Promise((done) => setTimeout(done, Math.max(0, 1000 / rate - r.ms)));
}
