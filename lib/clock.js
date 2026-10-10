// THE CLOCK model, version 1. Public, deterministic, and separate from the measurements.
//
// The date is a visualisation of two gaps closing, not a prophecy. It moves only when one
// of the inputs below changes, and anyone can recompute it from this file.
//
//   P_c  = B / 256                                   classical progress: verified bits over the key size
//   H    = log2(Q_ref / Q_floor)                     the quantum gap in halvings
//   P_q  = ( log2(Q_ref / Q_pub) + log2(S_base / S_best) ) / H    published halvings + our test-model halvings
//   P    = w_c · P_c + w_q · P_q                     clamp to [0, 1]
//   date = epoch + round( horizon · (1 − P) ) days
//
// Inputs that THE CLOCK measures itself: B (largest verified challenge, bits), S_base and
// S_best (baseline and best validated score on the active test model). Inputs that are
// published research: Q_ref and Q_pub (ECDSA.fail, see data/published.json). Everything
// else is an explicit assumption and says so.

export const MODEL = {
  version: 'v1',
  epoch: '2026-10-09',          // ASSUMPTION: the day THE CLOCK started. P = 1 lands here.
  horizonDays: 3653,            // ASSUMPTION: P = 0 lands ten years out (2036-10-09). The scale of the clock.
  keyBits: 256,                 // secp256k1 scalar size
  Q_floor: 1e7,                 // ASSUMPTION: a qubit×Toffoli score at which the attack counts as "within reach"
  weights: { classical: 0.5, quantum: 0.5 }, // ASSUMPTION: both engines count equally
  notes: [
    'Test-model halvings move the clock by the same log-fraction they achieved on the test model. That is a convention of this model, not a claim that the real attack got cheaper.',
    'Published figures are shown with their source and are never mixed into our own measurements.',
  ],
};

const DAY = 86400000;
export const epochMs = () => Date.parse(MODEL.epoch + 'T00:00:00Z');

export function compute({ classicalBits = 0, Q_ref, Q_pub, S_base = 1, S_best = 1 }) {
  if (!(Q_ref > 0) || !(Q_pub > 0)) throw new Error('published scores required');
  for (const [k, v] of Object.entries({ classicalBits, S_base, S_best })) if (!Number.isFinite(v)) throw new Error(k + ' must be a finite number');
  const P_c = Math.min(1, Math.max(0, classicalBits / MODEL.keyBits));
  const H = Math.log2(Q_ref / MODEL.Q_floor);
  const pubHalvings = Math.log2(Q_ref / Q_pub);
  const toyHalvings = S_best > 0 && S_base > 0 ? Math.log2(S_base / S_best) : 0;
  // If the published figure is already at or past the floor there is no gap left to close.
  const P_q = H > 0 ? Math.min(1, Math.max(0, (pubHalvings + toyHalvings) / H)) : 1;
  const P = Math.min(1, Math.max(0, MODEL.weights.classical * P_c + MODEL.weights.quantum * P_q));
  const daysOut = Math.round(MODEL.horizonDays * (1 - P));
  const dateMs = epochMs() + daysOut * DAY;
  return {
    version: MODEL.version,
    inputs: { classicalBits, Q_ref, Q_pub, S_base, S_best },
    P_c, P_q, P, H, pubHalvings, toyHalvings, daysOut,
    date: new Date(dateMs).toISOString().slice(0, 10),
    dateMs,
  };
}

// Positive = the clock moved closer (fewer days out).
export const movedDays = (prev, next) => prev.daysOut - next.daysOut;
