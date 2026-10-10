// The compute loop that runs inside a worker thread, in a browser Web Worker or a Node
// worker_thread alike. It owns one Walker, runs it in short slices so control messages get
// through, and posts measured progress (steps actually executed, distinguished points found).
//
// messages in:  { type: 'assign', challenge, assignment } | { type: 'reseed', ks } | { type: 'stop' }
// messages out: { type: 'progress', steps, dps, rate, challengeId } | { type: 'ready' }

import { Walker } from './kangaroo.js';

export function createWalkerLoop(post, schedule = (fn) => setTimeout(fn, 0)) {
  let walker = null;
  let challengeId = null;
  let running = false;
  let rounds = 4;
  let pending = { steps: 0, dps: [] };
  let lastPost = 0;
  let windowStart = 0, windowSteps = 0;
  let generation = 0; // bumped on every assign/stop so a stale tick chain exits

  function flush(now) {
    if (!pending.steps && !pending.dps.length) return;
    const rate = windowSteps / Math.max(1, now - windowStart) * 1000;
    post({ type: 'progress', steps: pending.steps, dps: pending.dps, rate, challengeId });
    pending = { steps: 0, dps: [] };
    lastPost = now; windowStart = now; windowSteps = 0;
  }

  function tick(gen) {
    if (gen !== generation || !running || !walker) return;
    const t0 = Date.now();
    let dps;
    try { dps = walker.run(rounds); } catch (e) { running = false; walker = null; post({ type: 'error', error: String((e && e.message) || e), challengeId }); return; }
    const did = rounds * walker.count;
    const ms = Date.now() - t0;
    // aim for ~250ms slices
    if (ms < 120) rounds = Math.min(rounds * 2, 4096); else if (ms > 400) rounds = Math.max(1, Math.floor(rounds / 2));
    pending.steps += did;
    windowSteps += did;
    if (dps.length) pending.dps.push(...dps);
    const now = Date.now();
    if (now - lastPost >= 1000 || pending.dps.length >= 2000) flush(now);
    schedule(() => tick(gen));
  }

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'assign') {
      flush(Date.now()); // do not lose the work done since the last post
      let next;
      try { next = new Walker(msg.challenge, msg.assignment); } catch (e) { post({ type: 'error', error: String((e && e.message) || e), challengeId }); return; }
      walker = next;
      challengeId = msg.challenge.id ?? null;
      rounds = 4;
      pending = { steps: 0, dps: [] };
      lastPost = windowStart = Date.now(); windowSteps = 0;
      generation++;
      running = true;
      const gen = generation;
      schedule(() => tick(gen));
      post({ type: 'ready', challengeId });
    } else if (msg.type === 'reseed' && walker) {
      for (const k of msg.ks || []) if (Number.isInteger(k) && k >= 0 && k < walker.count) walker.reseed(k);
    } else if (msg.type === 'stop') {
      flush(Date.now());
      generation++;
      running = false; walker = null;
    }
  }

  return { handle, isRunning: () => running };
}
