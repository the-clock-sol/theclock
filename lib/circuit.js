// Reversible circuits over {X, CNOT, Toffoli}: the "small, safe test model" the quantum
// agents optimise. A Toffoli network is exactly the classical, non-Clifford skeleton that
// resource estimates like ECDSA.fail count (logical qubits × Toffoli gates), so the same
// metric applies to a tiny modular adder as to the full point-addition circuit. The
// simulation is exhaustive over the model's valid inputs, which is only possible because
// the models are small. That is the point: nothing here is a claim about the real attack.

export const X = 'x';
export const CX = 'cx';
export const CCX = 'ccx';

export const x = (t) => ({ t: X, q: [t] });
export const cx = (c, t) => ({ t: CX, q: [c, t] });
export const ccx = (c1, c2, t) => ({ t: CCX, q: [c1, c2, t] });

export function applyGate(g, s) {
  const q = g.q;
  switch (g.t) {
    case X: return s ^ (1 << q[0]);
    case CX: return (s >>> q[0]) & 1 ? s ^ (1 << q[1]) : s;
    case CCX: return ((s >>> q[0]) & 1) && ((s >>> q[1]) & 1) ? s ^ (1 << q[2]) : s;
    default: throw new Error('unknown gate ' + g.t);
  }
}

export function simulate(gates, s) {
  for (let i = 0; i < gates.length; i++) s = applyGate(gates[i], s);
  return s;
}

export const toffoliCount = (gates) => gates.reduce((n, g) => n + (g.t === CCX ? 1 : 0), 0);

export function usedWires(gates) {
  const set = new Set();
  for (const g of gates) for (const w of g.q) set.add(w);
  return set;
}

// Logical qubits = every wire the specification needs (inputs/outputs) plus every ancilla a
// gate still touches. Removing all gates from an ancilla frees the qubit.
export function qubitCount(model, gates) {
  const set = new Set(model.io);
  for (const w of usedWires(gates)) set.add(w);
  return set.size;
}

export function score(model, gates) {
  const qubits = qubitCount(model, gates);
  const toffoli = toffoliCount(gates);
  return { qubits, toffoli, gates: gates.length, score: qubits * toffoli };
}

// Exhaustive check against the specification. Returns the first failures for the record.
export function verify(model, gates, maxFailures = 3) {
  const failures = [];
  const inputs = model.inputs();
  for (const s of inputs) {
    const out = simulate(gates, s);
    const want = model.expect(s);
    if (out !== want) {
      failures.push({ input: s, got: out, want });
      if (failures.length >= maxFailures) break;
    }
  }
  return { ok: failures.length === 0, checked: inputs.length, failures };
}

// Wire-validity: every gate inside the model's wire count, distinct wires per gate.
export function wellFormed(model, gates) {
  if (!Array.isArray(gates)) return false;
  for (const g of gates) {
    if (!g || !Array.isArray(g.q)) return false;
    const arity = g.t === X ? 1 : g.t === CX ? 2 : g.t === CCX ? 3 : 0;
    if (arity === 0 || g.q.length !== arity) return false;
    if (new Set(g.q).size !== arity) return false;
    for (const w of g.q) if (!Number.isInteger(w) || w < 0 || w >= model.wires) return false;
  }
  return true;
}

export const serialize = (gates) => gates.map((g) => g.t + ':' + g.q.join(',')).join(' ');
export function parse(text) {
  if (typeof text !== 'string') throw new Error('circuit must be a string');
  const out = [];
  for (const tok of text.trim().split(/\s+/)) {
    if (!tok) continue;
    const m = /^(x|cx|ccx):(\d{1,3}(?:,\d{1,3}){0,2})$/.exec(tok);
    if (!m) throw new Error('bad gate token: ' + tok.slice(0, 24));
    out.push({ t: m[1], q: m[2].split(',').map(Number) });
  }
  return out;
}

// 64-bit identifier of the canonical text: a 32-bit FNV-1a lane plus a second mixed lane. Not a
// security primitive. Pure JS so the browser can compute the same hash the server stores.
export function hashCircuit(gates) {
  const s = serialize(gates);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x27d4eb2f) ^ (h2 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// States reachable before every gate position, as plain arrays (index i = before gate i).
export function trace(model, gates) {
  const inputs = model.inputs();
  const before = new Array(gates.length + 1);
  let cur = inputs.slice();
  before[0] = cur;
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i];
    const next = new Array(cur.length);
    for (let k = 0; k < cur.length; k++) next[k] = applyGate(g, cur[k]);
    cur = next;
    before[i + 1] = cur;
  }
  return before;
}
