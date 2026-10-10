// Mutation operators the agents apply to a circuit. Each returns a candidate (new gate list)
// or null when it has nothing to propose. None of them is trusted: the runner re-verifies
// every candidate exhaustively before it can become a record.

import { X, CX, CCX, x, cx, ccx, trace, applyGate, toffoliCount } from './circuit.js';

const target = (g) => g.q[g.q.length - 1];
const controls = (g) => g.q.slice(0, -1);
const sameGate = (g, h) => g.t === h.t && g.q.length === h.q.length && g.q.every((w, i) => w === h.q[i]);

// Two gates commute when neither writes a wire the other reads or writes, or when both only
// XOR into the same target and neither target is a control of the other.
export function commute(g, h) {
  const tg = target(g), th = target(h);
  if (tg === th) return !controls(g).includes(th) && !controls(h).includes(tg);
  return !h.q.includes(tg) && !g.q.includes(th);
}

// 1. Drop a random gate. Finds gates whose effect is invisible on valid inputs.
export function dropGate(gates, r) {
  if (!gates.length) return null;
  const i = r.int(gates.length);
  return { op: 'drop_gate', at: i, gates: gates.slice(0, i).concat(gates.slice(i + 1)) };
}

// 2. Cancel a pair of identical gates separated only by gates they commute with.
export function cancelPair(gates, r) {
  const order = gates.map((_, i) => i);
  for (let k = order.length - 1; k > 0; k--) { const j = r.int(k + 1); [order[k], order[j]] = [order[j], order[k]]; }
  for (const i of order) {
    for (let j = i + 1; j < gates.length; j++) {
      if (sameGate(gates[i], gates[j])) {
        return { op: 'cancel_pair', at: i, with: j, gates: gates.filter((_, k) => k !== i && k !== j) };
      }
      if (!commute(gates[i], gates[j])) break;
    }
  }
  return null;
}

// 3. Constant folding by simulation: a control that is always 1 on every reachable state is
//    not a control; one that is always 0 kills the gate; two controls that always agree are one.
export function constFold(gates, r, model) {
  const before = trace(model, gates);
  const order = gates.map((_, i) => i);
  for (let k = order.length - 1; k > 0; k--) { const j = r.int(k + 1); [order[k], order[j]] = [order[j], order[k]]; }
  for (const i of order) {
    const g = gates[i];
    if (g.t === X) continue;
    const S = before[i];
    const cs = controls(g);
    const always = (w, v) => S.every((s) => ((s >>> w) & 1) === v);
    for (const c of cs) {
      if (always(c, 0)) return { op: 'const_fold', at: i, rule: `control ${c} is always 0, gate never fires`, gates: gates.filter((_, k) => k !== i) };
      if (always(c, 1)) {
        const rest = cs.filter((w) => w !== c);
        const ng = rest.length === 0 ? x(target(g)) : cx(rest[0], target(g));
        return { op: 'const_fold', at: i, rule: `control ${c} is always 1, dropped`, gates: gates.map((h, k) => (k === i ? ng : h)) };
      }
    }
    if (g.t === CCX) {
      const [c1, c2] = cs;
      if (S.every((s) => ((s >>> c1) & 1) === ((s >>> c2) & 1)))
        return { op: 'const_fold', at: i, rule: `controls ${c1} and ${c2} always agree`, gates: gates.map((h, k) => (k === i ? cx(c1, target(g)) : h)) };
      if (S.every((s) => !(((s >>> c1) & 1) && ((s >>> c2) & 1))))
        return { op: 'const_fold', at: i, rule: `controls ${c1} and ${c2} are never both 1`, gates: gates.filter((_, k) => k !== i) };
    }
  }
  return null;
}

// 4. Swap two adjacent commuting gates. Neutral on its own; it is what lets a later
//    cancellation or fold happen.
export function swapCommuting(gates, r) {
  if (gates.length < 2) return null;
  const start = r.int(gates.length - 1);
  for (let k = 0; k < gates.length - 1; k++) {
    const i = (start + k) % (gates.length - 1);
    if (commute(gates[i], gates[i + 1])) {
      const out = gates.slice();
      [out[i], out[i + 1]] = [out[i + 1], out[i]];
      return { op: 'swap', at: i, gates: out };
    }
  }
  return null;
}

// 5. Window resynthesis: take w consecutive gates on a handful of wires, record what they do
//    to every reachable pattern on those wires, and search exhaustively for a cheaper
//    sequence that does the same thing on those patterns. Unreachable patterns are free.
export function windowResynth(gates, r, model, opts = {}) {
  const maxWires = opts.maxWires ?? 5;
  const w = 2 + r.int(3); // window of 2..4 gates
  if (gates.length < w) return null;
  const i = r.int(gates.length - w + 1);
  const win = gates.slice(i, i + w);
  const wires = [...new Set(win.flatMap((g) => g.q))].sort((a, b) => a - b);
  if (wires.length > maxWires) return null;
  const before = trace(model, gates)[i];
  // project reachable states onto the window wires
  const idxOf = new Map(wires.map((wi, k) => [wi, k]));
  const local = win.map((g) => ({ t: g.t, q: g.q.map((q) => idxOf.get(q)) }));
  const seen = new Map();
  for (const s of before) {
    let pat = 0;
    wires.forEach((wi, k) => { if ((s >>> wi) & 1) pat |= 1 << k; });
    if (!seen.has(pat)) {
      let o = pat;
      for (const g of local) o = applyGate(g, o);
      seen.set(pat, o);
    }
  }
  const ins = [...seen.keys()], outs = ins.map((k) => seen.get(k));
  const alphabet = [];
  const m = wires.length;
  for (let a = 0; a < m; a++) alphabet.push(x(a));
  for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) if (a !== b) alphabet.push(cx(a, b));
  for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) for (let c = 0; c < m; c++) if (c !== a && c !== b) alphabet.push(ccx(a, b, c));
  const curT = toffoliCount(local);
  const maxLen = w - 1;
  const matches = (seq) => ins.every((pat, k) => { let o = pat; for (const g of seq) o = applyGate(g, o); return o === outs[k]; });
  // identity?
  if (matches([])) return { op: 'window_resynth', at: i, len: w, gates: gates.slice(0, i).concat(gates.slice(i + w)) };
  // Iterative deepening by length, so the first hit is the shortest sequence that works.
  // A hit only counts when it is cheaper: fewer Toffolis, or equal Toffolis and fewer gates.
  let best = null;
  for (let len = 1; len <= maxLen && !best; len++) {
    const walk = (seq, toff) => {
      if (best) return;
      if (seq.length === len) { if (matches(seq)) best = seq.slice(); return; }
      for (const g of alphabet) {
        const t2 = toff + (g.t === CCX ? 1 : 0);
        if (t2 > curT) continue;
        seq.push(g); walk(seq, t2); seq.pop();
        if (best) return;
      }
    };
    walk([], 0);
  }
  if (!best) return null;
  const lifted = best.map((g) => ({ t: g.t, q: g.q.map((k) => wires[k]) }));
  return { op: 'window_resynth', at: i, len: w, replaced: lifted.length, gates: gates.slice(0, i).concat(lifted, gates.slice(i + w)) };
}

// 6. Strip gates on wires that no longer matter: a gate whose target is an ancilla that
//    nothing reads afterwards and that the spec requires to be 0 still matters, so this just
//    tries dropping the last gate touching a non-io wire. Verification decides.
export function dropTail(gates, r, model) {
  const io = new Set(model.io);
  const cands = [];
  for (let i = gates.length - 1; i >= 0; i--) if (!io.has(target(gates[i]))) cands.push(i);
  if (!cands.length) return null;
  const i = cands[r.int(Math.min(cands.length, 8))];
  return { op: 'drop_tail', at: i, gates: gates.filter((_, k) => k !== i) };
}

export const OPERATORS = { drop_gate: dropGate, cancel_pair: cancelPair, const_fold: constFold, swap: swapCommuting, window_resynth: windowResynth, drop_tail: dropTail };
export const OPERATOR_NAMES = Object.keys(OPERATORS);
