import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rng } from '../lib/prng.js';
import { mul, G, eq, hex, big, onCurve } from '../lib/secp.js';
import { makeChallenge, verifySolution, solveFromCollision, dpBitsFor, jumpCountFor } from '../lib/challenge.js';
import { Walker } from '../lib/kangaroo.js';
import { createWalkerLoop } from '../lib/walker-loop.js';
import { simulate, verify, score, parse, serialize, hashCircuit, x, cx, ccx, trace, wellFormed } from '../lib/circuit.js';
import { MODELS, adder, modAdder } from '../lib/models.js';
import { constFold, cancelPair, windowResynth, commute, dropGate } from '../lib/optimize.js';
import { runExperiment, judge, compare, STATUS } from '../lib/runner.js';
import { compute, movedDays, MODEL } from '../lib/clock.js';

// ---------- prng ----------
test('prng is deterministic and seed-sensitive', () => {
  const a = rng('seed'), b = rng('seed'), c = rng('seed2');
  const sa = [a.u32(), a.u32(), a.int(10), a.hex(4), a.big(70).toString()];
  const sb = [b.u32(), b.u32(), b.int(10), b.hex(4), b.big(70).toString()];
  assert.deepEqual(sa, sb);
  assert.notEqual(c.u32(), sa[0]);
  for (let i = 0; i < 100; i++) { const v = rng('x' + i).big(40); assert.ok(v >= 0n && v < 1n << 40n); }
});

// ---------- secp reference ----------
test('secp256k1 reference: n·G = O and points stay on the curve', () => {
  assert.ok(onCurve(G));
  assert.ok(onCurve(mul(123456789n)));
  assert.equal(mul(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n), null);
  const nm1 = mul(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140n);
  assert.equal(nm1.x, G.x); assert.equal(nm1.y, (2n ** 256n - 2n ** 32n - 977n) - G.y);
});

// ---------- challenge generation + verification ----------
test('challenge generation is deterministic from the secret seed and stays in the interval', () => {
  const a = makeChallenge(24, 'secret'), b = makeChallenge(24, 'secret'), c = makeChallenge(24, 'other');
  assert.equal(a.d, b.d);
  assert.notEqual(a.d, c.d);
  assert.ok(a.d > 0n && a.d < 1n << 24n);
  assert.equal(a.public.compressed.length, 66);
  assert.ok(eq(mul(a.d), { x: big(a.public.x), y: big(a.public.y) }));
  assert.throws(() => makeChallenge(4, 's'));
});

test('verifySolution accepts the right key and rejects wrong, out-of-range and garbage', () => {
  const ch = makeChallenge(20, 's1');
  assert.equal(verifySolution(ch.public, hex(ch.d)).ok, true);
  assert.equal(verifySolution(ch.public, hex(ch.d + 1n)).ok, false);
  assert.equal(verifySolution(ch.public, hex(ch.d + (1n << 20n))).reason, 'out of interval');
  assert.equal(verifySolution(ch.public, 'zz').ok, false);
  assert.equal(verifySolution(ch.public, '00').reason, 'out of interval');
});

test('collision arithmetic recovers d from a tame and a wild position', () => {
  const ch = makeChallenge(22, 's2');
  const b = 1000n, Dt = 5000n, r = 7n, Dw = 0n;
  // same point: b + Dt == d + r + Dw  =>  choose Dw accordingly
  const wildPos = b + Dt - ch.d; // r + Dw
  assert.equal(solveFromCollision(b + Dt, wildPos, ch.public), ch.d);
  assert.equal(solveFromCollision(b + Dt, wildPos + 1n, ch.public), null);
  assert.equal(solveFromCollision(5n, 10n, ch.public), null);
});

test('parameters scale with bits', () => {
  assert.equal(dpBitsFor(20), 4);
  assert.equal(dpBitsFor(40), 14);
  assert.equal(dpBitsFor(80), 18);
  assert.ok(jumpCountFor(40) > jumpCountFor(20));
});

// ---------- walker end-to-end ----------
function solveWith(bits, count = 64) {
  const ch = makeChallenge(bits, 'walk' + bits);
  const w = new Walker(ch.public, { seed: 'assign', count });
  const table = new Map();
  for (let i = 0; i < 20000; i++) {
    for (const dp of w.run(4)) {
      const prev = table.get(dp.x);
      if (prev && prev.kind !== dp.kind) {
        const [t, wl] = prev.kind === 't' ? [prev, dp] : [dp, prev];
        const d = solveFromCollision(big(t.pos), big(wl.pos), ch.public);
        if (d !== null) return { d, ch, steps: w.steps };
      } else if (!prev) table.set(dp.x, dp);
    }
  }
  return { d: null, ch, steps: w.steps };
}

test('the kangaroo walker actually solves 16- and 24-bit challenges', () => {
  for (const bits of [16, 24]) {
    const { d, ch, steps } = solveWith(bits);
    assert.equal(d, ch.d, `bits=${bits} after ${steps} steps`);
  }
});

test('two assignments never share starting positions', () => {
  const ch = makeChallenge(20, 'dj');
  const a = new Walker(ch.public, { seed: 'a', count: 8 }), b = new Walker(ch.public, { seed: 'b', count: 8 });
  for (let i = 0; i < 8; i++) assert.notEqual(a.start[i], b.start[i]);
  assert.ok(a.kind.includes('t') && a.kind.includes('w'));
});

test('walker loop posts measured progress and honours reseed/stop', async () => {
  const ch = makeChallenge(16, 'loop');
  const posts = [];
  const queue = [];
  const loop = createWalkerLoop((m) => posts.push(m), (fn) => queue.push(fn));
  loop.handle({ type: 'assign', challenge: { ...ch.public, id: 7 }, assignment: { seed: 's', count: 8 } });
  assert.equal(posts[0].type, 'ready');
  for (let i = 0; i < 12 && queue.length; i++) queue.shift()();
  loop.handle({ type: 'reseed', ks: [0, 1] });
  loop.handle({ type: 'stop' }); // stop flushes whatever was pending
  assert.ok(posts.some((m) => m.type === 'progress' && m.steps > 0 && m.challengeId === 7));
  assert.equal(loop.isRunning(), false);
  const n = posts.length;
  while (queue.length) queue.shift()(); // stale ticks must exit without posting
  assert.equal(posts.length, n);
  assert.throws(() => new Walker(ch.public, { seed: 's', count: 1 }), /bad assignment/);
});

// ---------- circuits ----------
test('gate simulation: x, cx, ccx', () => {
  assert.equal(simulate([x(0)], 0b000), 0b001);
  assert.equal(simulate([cx(0, 1)], 0b001), 0b011);
  assert.equal(simulate([cx(0, 1)], 0b000), 0b000);
  assert.equal(simulate([ccx(0, 1, 2)], 0b011), 0b111);
  assert.equal(simulate([ccx(0, 1, 2)], 0b001), 0b001);
});

test('every textbook baseline satisfies its specification', () => {
  for (const m of Object.values(MODELS)) {
    const v = verify(m, m.baseline());
    assert.equal(v.ok, true, m.name);
    assert.ok(v.checked > 0);
  }
  assert.equal(score(adder(4), adder(4).baseline()).toffoli, 14);
  assert.throws(() => modAdder(8, 251));
});

test('scoring is qubits × toffoli and frees untouched ancillas', () => {
  const m = adder(3);
  const base = m.baseline();
  const s = score(m, base);
  assert.equal(s.score, s.qubits * s.toffoli);
  assert.equal(s.qubits, 10);
  assert.equal(score(m, []).qubits, m.io.length);
});

test('serialize/parse/hash round-trip and well-formedness', () => {
  const g = [x(1), cx(0, 2), ccx(0, 1, 3)];
  const t = serialize(g);
  assert.deepEqual(parse(t), g);
  assert.equal(hashCircuit(g), hashCircuit(parse(t)));
  assert.equal(wellFormed(adder(3), g), true);
  assert.equal(wellFormed(adder(3), [ccx(0, 0, 1)]), false);
  assert.equal(wellFormed(adder(3), [cx(0, 99)]), false);
});

// ---------- optimizer ----------
test('constant folding finds the dead Toffoli on the zero carry-in', () => {
  const m = adder(4);
  const base = m.baseline();
  let found = null;
  for (let i = 0; i < 50 && !found; i++) found = constFold(base, rng('cf' + i), m);
  assert.ok(found, 'should find a foldable gate');
  assert.equal(verify(m, found.gates).ok, true);
  assert.ok(score(m, found.gates).toffoli <= score(m, base).toffoli);
});

test('cancel_pair removes adjacent identical gates and keeps function', () => {
  const m = adder(3);
  const base = m.baseline();
  const padded = [...base.slice(0, 5), cx(0, 1), cx(0, 1), ...base.slice(5)];
  assert.equal(verify(m, padded).ok, true);
  const r = cancelPair(padded, rng('cp'));
  assert.ok(r);
  assert.equal(r.gates.length, base.length);
  assert.equal(verify(m, r.gates).ok, true);
});

test('window resynthesis never breaks the specification', () => {
  const m = MODELS.modadd4p13;
  let g = m.baseline();
  let hits = 0;
  for (let i = 0; i < 60; i++) {
    const r = windowResynth(g, rng('wr' + i), m);
    if (r) { hits++; assert.equal(verify(m, r.gates).ok, true, 'resynth at ' + r.at); g = r.gates; }
  }
  assert.ok(hits > 0, 'resynth should find at least one shorter window');
});

test('commute rule', () => {
  assert.equal(commute(cx(0, 1), cx(2, 3)), true);
  assert.equal(commute(cx(0, 1), cx(1, 2)), false);
  assert.equal(commute(x(0), ccx(0, 1, 2)), false);
});

// ---------- runner ----------
test('runner: accepts strict improvements, rejects regressions and invalid circuits, deterministic by seed', () => {
  const m = MODELS.modadd4p13;
  const base = m.baseline();
  const a = runExperiment({ model: m, parent: base, seed: 'z1' });
  const b = runExperiment({ model: m, parent: base, seed: 'z1' });
  assert.equal(a.status, b.status); assert.equal(a.score, b.score);
  // invalid: drop a load-bearing gate explicitly
  const broken = base.slice(1);
  assert.equal(judge({ model: m, parent: base, candidate: broken }).status, STATUS.INVALID);
  // regression: a correct circuit with an extra Toffoli pair is rejected, never accepted
  const padded = base.concat([ccx(0, 1, m.wires - 1), ccx(0, 1, m.wires - 1)]);
  assert.equal(judge({ model: m, parent: base, candidate: padded }).status, STATUS.REJECTED);
  assert.equal(compare(m, base, base), STATUS.REJECTED);
  const better = constFold(base, rng('r'), m)?.gates;
  assert.ok(better);
  const j = judge({ model: m, parent: base, candidate: better });
  assert.ok([STATUS.ACCEPTED, STATUS.NEUTRAL].includes(j.status));
  assert.ok(j.checked === m.inputs().length);
  // a run of experiments reaches a strictly better score
  let best = base, improved = false;
  for (let i = 0; i < 300 && !improved; i++) { const r = runExperiment({ model: m, parent: best, seed: 'run' + i }); if (r.status === STATUS.ACCEPTED) improved = true; }
  assert.equal(improved, true);
  assert.deepEqual(trace(m, base)[0], m.inputs());
});

// ---------- clock model ----------
test('clock model: deterministic, bounded, moves closer when inputs improve', () => {
  const pub = { Q_ref: 10753444395, Q_pub: 1495670403 };
  const a = compute({ classicalBits: 0, S_base: 2860, S_best: 2860, ...pub });
  const b = compute({ classicalBits: 0, S_base: 2860, S_best: 2860, ...pub });
  assert.equal(a.date, b.date);
  assert.ok(a.P > 0 && a.P < 1);
  assert.equal(a.P_c, 0);
  const c = compute({ classicalBits: 40, S_base: 2860, S_best: 2860, ...pub });
  assert.ok(movedDays(a, c) > 0, 'more bits => closer');
  const d = compute({ classicalBits: 40, S_base: 2860, S_best: 2000, ...pub });
  assert.ok(movedDays(c, d) > 0, 'smaller circuit => closer');
  const far = compute({ classicalBits: 0, S_base: 1, S_best: 1, Q_ref: 1e9, Q_pub: 1e9 });
  assert.equal(far.daysOut, MODEL.horizonDays);
  assert.equal(far.date, '2036-10-09');
  const done = compute({ classicalBits: 256, S_base: 1, S_best: 1, Q_ref: 1e9, Q_pub: 1e7 });
  assert.equal(done.daysOut, 0);
  assert.equal(done.date, MODEL.epoch);
  // a published figure already at or under the floor means the quantum gap is closed, not infinite
  const under = compute({ classicalBits: 0, S_base: 1, S_best: 1, Q_ref: 10, Q_pub: 10 });
  assert.equal(under.P_q, 1);
  assert.throws(() => compute({ classicalBits: NaN, ...pub }), /finite/);
  assert.throws(() => compute({ classicalBits: 1 }));
});
