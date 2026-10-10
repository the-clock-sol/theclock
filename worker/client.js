// Drives N walker threads against a coordinator. The coordinator is reached through an
// `api` object with register / work / report, which is either the HTTP client below (a
// standalone backend worker) or the coordinator's own functions (the house worker that
// runs inside the server process). Same protocol either way.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function httpApi(base, fetchFn = fetch) {
  const call = async (path, body) => {
    const r = await fetchFn(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    const ct = String(r.headers.get('content-type') || '');
    if (!ct.includes('application/json')) throw new Error(`${r.status} from ${path}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  return {
    register: (o) => call('/api/classical/register', o),
    work: (workerId) => call('/api/classical/work?worker=' + encodeURIComponent(workerId)),
    report: (o) => call('/api/classical/report', o),
  };
}

export async function runWorkerClient({ api, threads = 1, handle = null, token = null, name = null, log = () => {}, kind = 'backend' }) {
  const reg = await api.register({ handle, token, kind, agent: `node-worker/${threads}t`, internalName: name });
  log(`registered as ${reg.handle} (${reg.workerId}) with ${threads} thread${threads === 1 ? '' : 's'}`);
  const workers = [];
  let current = null; // {challenge, assignment}
  let stopped = false;

  async function assignAll() {
    for (const w of workers) {
      const job = await api.work(reg.workerId);
      w.postMessage({ type: 'assign', challenge: job.challenge, assignment: job.assignment });
      current = job;
    }
  }

  let reporting = Promise.resolve();
  for (let i = 0; i < threads; i++) {
    const w = new Worker(join(here, 'thread.js'));
    w.on('message', (m) => {
      if (m.type !== 'progress' || stopped) return;
      reporting = reporting.then(async () => {
        try {
          const res = await api.report({ workerId: reg.workerId, challengeId: m.challengeId, steps: m.steps, dps: m.dps, rate: m.rate });
          if (res.reseed?.length) w.postMessage({ type: 'reseed', ks: res.reseed });
          if (res.solved) log(`challenge #${m.challengeId} solved by this worker`);
          if (res.challengeId !== m.challengeId) {
            const job = await api.work(reg.workerId);
            w.postMessage({ type: 'assign', challenge: job.challenge, assignment: job.assignment });
            log(`now on challenge #${job.challenge.id} (${job.challenge.bits} bits)`);
          }
        } catch (e) { log('report failed: ' + e.message); }
      });
    });
    w.on('error', (e) => log('thread error: ' + e.message));
    workers.push(w);
  }
  await assignAll();
  log(`working on challenge #${current.challenge.id} (${current.challenge.bits} bits)`);

  return {
    workerId: reg.workerId,
    handle: reg.handle,
    stop: async () => { stopped = true; for (const w of workers) { w.postMessage({ type: 'stop' }); await w.terminate(); } },
  };
}
