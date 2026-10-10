// Deterministic PRNG (sfc32) seeded from any string. Every experiment and every work
// assignment is replayable from its seed, which is what makes a result reproducible.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rng(seed) {
  const s = String(seed);
  let a = fnv1a(s + '#a'), b = fnv1a(s + '#b'), c = fnv1a(s + '#c'), d = fnv1a(s + '#d');
  const u32 = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) u32();
  return {
    u32,
    float: () => u32() / 4294967296,
    int: (n) => Math.floor((u32() / 4294967296) * n),
    pick: (arr) => arr[Math.floor((u32() / 4294967296) * arr.length)],
    // Uniform BigInt in [0, 2^bits).
    big: (bits) => {
      let v = 0n;
      let left = bits;
      while (left > 0) {
        const take = Math.min(32, left);
        v = (v << BigInt(take)) | BigInt(u32() >>> (32 - take));
        left -= take;
      }
      return v;
    },
    hex: (bytes) => {
      let s = '';
      for (let i = 0; i < bytes; i++) s += (u32() & 0xff).toString(16).padStart(2, '0');
      return s;
    },
  };
}
