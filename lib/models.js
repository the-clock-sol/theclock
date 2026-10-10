// Test models: small arithmetic circuits built the textbook way (Vedral–Barenco–Ekert, 1996).
// The baseline is deliberately the plain construction, with nothing hand-optimised, so the
// agents are measured against a real published starting point and every gate they remove
// is a gate the textbook had. Modular addition is the inner loop of the elliptic-curve
// point addition that the real attack circuit is built from.

import { x, cx, ccx } from './circuit.js';

// CARRY(c, a, b, c') and SUM(c, a, b) exactly as in VBE.
const carry = (c, a, b, c2) => [ccx(a, b, c2), cx(a, b), ccx(c, b, c2)];
const carryDag = (c, a, b, c2) => [ccx(c, b, c2), cx(a, b), ccx(a, b, c2)];
const sum = (c, a, b) => [cx(a, b), cx(c, b)];

// (a, b, 0) -> (a, a+b) with the carry-out on z. a, b, c are arrays of n wires; c[0] must be 0.
export function vbeAdd(a, b, c, z) {
  const n = a.length;
  const g = [];
  const cw = [...c, z];
  for (let i = 0; i < n; i++) g.push(...carry(cw[i], a[i], b[i], cw[i + 1]));
  g.push(cx(a[n - 1], b[n - 1]));
  g.push(...sum(cw[n - 1], a[n - 1], b[n - 1]));
  for (let i = n - 2; i >= 0; i--) {
    g.push(...carryDag(cw[i], a[i], b[i], cw[i + 1]));
    g.push(...sum(cw[i], a[i], b[i]));
  }
  return g;
}

const reverse = (gates) => gates.slice().reverse(); // every gate here is self-inverse
export const vbeSub = (a, b, c, z) => reverse(vbeAdd(a, b, c, z));

const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
const bitsOf = (v, n) => range(0, n).filter((i) => (v >> i) & 1);

function pack(fields) {
  // fields: [[wires[], value], ...] -> state integer
  let s = 0;
  for (const [wires, value] of fields) wires.forEach((w, i) => { if ((value >> i) & 1) s |= 1 << w; });
  return s;
}
function unpack(s, wires) {
  let v = 0;
  wires.forEach((w, i) => { if ((s >>> w) & 1) v |= 1 << i; });
  return v;
}

// n-bit adder with carry-out: wires a[n] b[n] c[n] z.
export function adder(n) {
  if (3 * n + 1 > 31) throw new Error('state is a 32-bit integer: at most 31 wires');
  const a = range(0, n), b = range(n, n), c = range(2 * n, n), z = 3 * n;
  const inputs = () => {
    const out = [];
    for (let av = 0; av < 1 << n; av++) for (let bv = 0; bv < 1 << n; bv++) out.push(pack([[a, av], [b, bv]]));
    return out;
  };
  const expect = (s) => {
    const av = unpack(s, a), bv = unpack(s, b);
    const sum = av + bv;
    return pack([[a, av], [b, sum & ((1 << n) - 1)], [[z], sum >> n]]);
  };
  return {
    name: `add${n}`,
    title: `${n}-bit adder (VBE ripple-carry)`,
    description: `b := a + b with carry-out, inputs a, b < 2^${n}. Textbook VBE construction: n carry ancillas, 4n-2 Toffolis.`,
    wires: 3 * n + 1,
    io: [...a, ...b, z],
    inputs,
    expect,
    baseline: () => vbeAdd(a, b, c, z),
  };
}

// n-bit modular adder: b := (a + b) mod p for a, b < p. Wires: a[n] b[n] c[n] z t[n] f.
export function modAdder(n, p) {
  if (p >= 1 << n) throw new Error('p must fit in n bits');
  if (4 * n + 2 > 31) throw new Error('state is a 32-bit integer: at most 31 wires');
  const a = range(0, n), b = range(n, n), c = range(2 * n, n), z = 3 * n, t = range(3 * n + 1, n), f = 4 * n + 1;
  const pbits = bitsOf(p, n);
  const inputs = () => {
    const out = [];
    for (let av = 0; av < p; av++) for (let bv = 0; bv < p; bv++) out.push(pack([[a, av], [b, bv]]));
    return out;
  };
  const expect = (s) => {
    const av = unpack(s, a), bv = unpack(s, b);
    return pack([[a, av], [b, (av + bv) % p]]);
  };
  const baseline = () => {
    const g = [];
    g.push(...vbeAdd(a, b, c, z));                 // (b,z) = a+b
    for (const i of pbits) g.push(x(t[i]));         // t = p
    g.push(...vbeSub(t, b, c, z));                  // (b,z) = a+b-p ; z=1 iff a+b < p
    g.push(cx(z, f));                               // f = (a+b < p)
    for (const i of pbits) g.push(x(t[i]));         // t = 0
    for (const i of pbits) g.push(cx(f, t[i]));     // t = f ? p : 0
    g.push(...vbeAdd(t, b, c, z));                  // add p back when needed; z returns to 0
    for (const i of pbits) g.push(cx(f, t[i]));     // t = 0
    g.push(...vbeSub(a, b, c, z));                  // (b,z) = result - a ; z=1 iff result < a iff f=0
    g.push(x(z), cx(z, f), x(z));                   // clear f
    g.push(...vbeAdd(a, b, c, z));                  // restore result
    return g;
  };
  return {
    name: `modadd${n}p${p}`,
    title: `${n}-bit modular adder, p = ${p}`,
    description: `b := (a + b) mod ${p} for a, b < ${p}. Four textbook VBE adders, a constant register and one flag qubit, nothing hand-optimised.`,
    wires: 4 * n + 2,
    io: [...a, ...b],
    inputs,
    expect,
    baseline,
  };
}

export const MODELS = {};
for (const m of [adder(3), adder(4), adder(6), modAdder(3, 7), modAdder(4, 13), modAdder(5, 29), modAdder(6, 61), modAdder(7, 127)]) MODELS[m.name] = m;

export const DEFAULT_MODEL = 'modadd6p61';
export const getModel = (name) => (typeof name === 'string' && Object.hasOwn(MODELS, name) ? MODELS[name] : undefined);
