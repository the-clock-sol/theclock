#!/usr/bin/env node
// Independently verify a stored circuit or a solved challenge, with nothing but this repo.
//
//   node agent/verify.js --server http://localhost:8787 --experiment 42
//   node agent/verify.js --server http://localhost:8787 --challenge 7
//   node agent/verify.js --model modadd6p61 --circuit "ccx:0,6,12 cx:0,6 ..."

import { MODELS } from '../lib/models.js';
import { parse, verify, score } from '../lib/circuit.js';
import { verifySolution } from '../lib/challenge.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : [])).filter((x) => x.length));
const server = args.server || process.env.CLOCK_SERVER || 'http://localhost:8787';
const get = async (p) => { const r = await fetch(server + p); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };

if (args.challenge) {
  const c = await get('/api/classical/challenges/' + args.challenge);
  if (c.status !== 'solved') { console.log(`challenge #${c.id} is not solved yet`); process.exit(0); }
  const v = verifySolution({ bits: c.bits, x: c.x, y: c.y }, c.d_hex);
  console.log(`challenge #${c.id}: ${c.bits} bits, P = ${c.compressed}, d = 0x${c.d_hex}`);
  console.log(v.ok ? 'VERIFIED: d·G == P' : 'FAILED: ' + v.reason);
  process.exit(v.ok ? 0 : 1);
}

let modelName = args.model, text = args.circuit, claimed = null;
if (args.experiment) {
  const e = await get('/api/quantum/experiments/' + args.experiment);
  if (!e.circuit) { console.log('that experiment stored no circuit (rejected or invalid candidates are not kept)'); process.exit(0); }
  modelName = e.model; text = e.circuit; claimed = e.score;
}
const model = MODELS[modelName];
if (!model || !text) { console.error('need --model and --circuit, or --experiment / --challenge'); process.exit(1); }
const gates = parse(text);
const v = verify(model, gates);
const s = score(model, gates);
console.log(`${modelName}: ${v.checked} inputs checked, ${v.ok ? 'CORRECT' : 'WRONG on ' + v.failures.length + '+ inputs'}; score ${s.score} = ${s.qubits} qubits × ${s.toffoli} Toffoli, ${s.gates} gates${claimed != null ? ' (server claimed ' + claimed + ')' : ''}`);
process.exit(v.ok ? 0 : 1);
