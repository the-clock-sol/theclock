// Node worker_thread body: one walker loop talking to its parent over parentPort.
import { parentPort } from 'node:worker_threads';
import { createWalkerLoop } from '../lib/walker-loop.js';

const loop = createWalkerLoop((m) => parentPort.postMessage(m), (fn) => setImmediate(fn));
parentPort.on('message', (m) => loop.handle(m));
