// secp256k1 in plain BigInt. Slow and obviously correct: the reference the walker is tested
// against, and what the server uses to verify every cracked key.
// Runs unchanged in Node and in the browser.

export const p = 2n ** 256n - 2n ** 32n - 977n;
export const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

export const mod = (a, m = p) => ((a % m) + m) % m;

export function inv(a, m = p) {
  // Extended Euclid; fine for the volumes the server sees.
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error('not invertible');
  return mod(s0, m);
}

// Affine points; null is the point at infinity.
export function add(P, Q) {
  if (P === null) return Q;
  if (Q === null) return P;
  if (P.x === Q.x) {
    if (mod(P.y + Q.y) === 0n) return null;
    return dbl(P);
  }
  const l = mod((Q.y - P.y) * inv(Q.x - P.x));
  const x = mod(l * l - P.x - Q.x);
  return { x, y: mod(l * (P.x - x) - P.y) };
}

export function dbl(P) {
  if (P === null || P.y === 0n) return null;
  const l = mod(3n * P.x * P.x * inv(2n * P.y));
  const x = mod(l * l - 2n * P.x);
  return { x, y: mod(l * (P.x - x) - P.y) };
}

export const neg = (P) => (P === null ? null : { x: P.x, y: mod(-P.y) });

// Jacobian scalar multiplication: one inversion per call instead of one per step.
export function mul(k, P = G) {
  k = mod(k, order);
  let R = null; // Jacobian [X, Y, Z]
  const J = [P.x, P.y, 1n];
  for (let i = BigInt(k.toString(2).length) - 1n; i >= 0n; i--) {
    R = R && jdbl(R);
    if ((k >> i) & 1n) R = R ? jadd(R, J) : [...J];
  }
  if (!R || R[2] === 0n) return null;
  const zi = inv(R[2]);
  const zi2 = mod(zi * zi);
  return { x: mod(R[0] * zi2), y: mod(R[1] * zi2 * zi) };
}

function jdbl([X, Y, Z]) {
  if (Y === 0n) return [1n, 1n, 0n];
  const S = mod(4n * X * Y * Y);
  const M = mod(3n * X * X);
  const X3 = mod(M * M - 2n * S);
  return [X3, mod(M * (S - X3) - 8n * Y ** 4n), mod(2n * Y * Z)];
}

// Mixed add: R is Jacobian, Q is affine with Z=1.
function jadd([X1, Y1, Z1], [x2, y2]) {
  if (Z1 === 0n) return [x2, y2, 1n];
  const Z1Z1 = mod(Z1 * Z1);
  const U2 = mod(x2 * Z1Z1);
  const S2 = mod(y2 * Z1 * Z1Z1);
  const H = mod(U2 - X1);
  const r = mod(S2 - Y1);
  if (H === 0n) return r === 0n ? jdbl([X1, Y1, Z1]) : [1n, 1n, 0n];
  const HH = mod(H * H);
  const HHH = mod(H * HH);
  const V = mod(X1 * HH);
  const X3 = mod(r * r - HHH - 2n * V);
  return [X3, mod(r * (V - X3) - Y1 * HHH), mod(Z1 * H)];
}

export const onCurve = (P) => P !== null && mod(P.y * P.y - P.x ** 3n - 7n) === 0n;
export const eq = (P, Q) => (P === null || Q === null ? P === Q : P.x === Q.x && P.y === Q.y);

export const hex = (n, bytes = 32) => n.toString(16).padStart(bytes * 2, '0');
export const big = (h) => BigInt('0x' + h);

// Compressed SEC1 encoding — the form people paste into other tools to check our keys.
export const compress = (P) => (P.y & 1n ? '03' : '02') + hex(P.x);
