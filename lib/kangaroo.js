// Parallel Pollard kangaroo walker: the compute a worker actually does.
//
// Each walker runs a herd of kangaroos on secp256k1. Tame kangaroos start at a known scalar
// b·G, wild ones at P + r·G with a known r. All jump by a pseudo-random power of two chosen
// from the x-coordinate, so two kangaroos that ever land on the same point walk the same path
// forever. A point whose x has dpBits low zero bits is "distinguished" and gets reported;
// when a tame and a wild report the same distinguished point, the coordinator subtracts
// positions and has d. Starting positions derive from the assignment seed, so two workers
// never do the same work. Runs unchanged in a browser Web Worker and in Node.
//
// Cost per step is one affine addition; the field inversion is shared across the whole herd
// (Montgomery's trick), which is where almost all the speed comes from.

import { mod, inv, mul, add, hex, big, order } from './secp.js';
import { rng } from './prng.js';

export class Walker {
  // pub: challenge public data; assignment: { seed, count }
  constructor(pub, assignment) {
    this.pub = pub;
    this.bits = pub.bits;
    this.P = { x: big(pub.x), y: big(pub.y) };
    this.dpMask = (1n << BigInt(pub.dpBits)) - 1n;
    if (!assignment || typeof assignment.seed !== 'string' || !Number.isInteger(assignment.count) || assignment.count < 2 || assignment.count > 4096) throw new Error('bad assignment: need a seed and 2..4096 kangaroos');
    if (!pub || !Number.isInteger(pub.bits) || !Number.isInteger(pub.dpBits) || !Number.isInteger(pub.jumpCount) || pub.jumpCount < 1 || pub.jumpCount > 256) throw new Error('bad challenge');
    this.seed = assignment.seed;
    this.count = assignment.count;
    this.jumpSizes = [];
    this.jumpPoints = [];
    for (let i = 0; i < pub.jumpCount; i++) {
      const s = 1n << BigInt(i);
      this.jumpSizes.push(s);
      this.jumpPoints.push(mul(s));
    }
    this.gen = new Array(this.count).fill(0);
    this.kind = new Array(this.count);
    this.start = new Array(this.count); // b for tame, r for wild
    this.dist = new Array(this.count);
    this.x = new Array(this.count);
    this.y = new Array(this.count);
    this.steps = 0;
    for (let i = 0; i < this.count; i++) this.reseed(i);
  }

  reseed(i) {
    this.gen[i]++;
    const r = rng(`${this.seed}:${i}:${this.gen[i]}`);
    const tame = i % 2 === 0;
    this.kind[i] = tame ? 't' : 'w';
    let pt;
    if (tame) {
      let b = mod(r.big(this.bits), order); // anywhere in [1, order)
      if (b === 0n) b = 1n;
      this.start[i] = b;
      pt = mul(b);
    } else {
      const off = 1n + r.big(Math.max(1, Math.floor(this.bits / 2))); // small known offset
      this.start[i] = off;
      pt = add(this.P, mul(off));
    }
    this.dist[i] = 0n;
    this.x[i] = pt.x;
    this.y[i] = pt.y;
  }

  // Runs `rounds` herd steps. Returns the distinguished points found.
  run(rounds) {
    const n = this.count;
    const dps = [];
    const idx = new Array(n);
    const dx = new Array(n);
    const pre = new Array(n);
    const J = this.jumpSizes.length;
    for (let round = 0; round < rounds; round++) {
      let acc = 1n;
      for (let i = 0; i < n; i++) {
        let j = Number(this.x[i] & 0xffffffffn) % J;
        let d = mod(this.jumpPoints[j].x - this.x[i]);
        for (let tries = 0; d === 0n && tries < 8; tries++) { // landed on a jump point: degenerate, restart this kangaroo
          this.reseed(i);
          j = Number(this.x[i] & 0xffffffffn) % J;
          d = mod(this.jumpPoints[j].x - this.x[i]);
        }
        if (d === 0n) throw new Error('kangaroo could not be reseeded');
        idx[i] = j;
        dx[i] = d;
        pre[i] = acc;
        acc = mod(acc * d);
      }
      let invAcc = inv(acc);
      for (let i = n - 1; i >= 0; i--) {
        const di = mod(invAcc * pre[i]);
        invAcc = mod(invAcc * dx[i]);
        const Q = this.jumpPoints[idx[i]];
        const l = mod((Q.y - this.y[i]) * di);
        const x3 = mod(l * l - this.x[i] - Q.x);
        const y3 = mod(l * (this.x[i] - x3) - this.y[i]);
        this.x[i] = x3;
        this.y[i] = y3;
        this.dist[i] += this.jumpSizes[idx[i]];
        if ((x3 & this.dpMask) === 0n) {
          dps.push({ k: i, kind: this.kind[i], x: hex(x3), pos: hex(this.start[i] + this.dist[i]) });
        }
      }
      this.steps += n;
    }
    return dps;
  }
}
