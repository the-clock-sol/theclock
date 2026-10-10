#!/usr/bin/env node
// Standalone backend worker. Point it at a running coordinator:
//   node worker/node-worker.js --server http://localhost:8787 --threads 4 --handle your_name --token <token>
import { availableParallelism } from 'node:os';
import { httpApi, runWorkerClient } from './client.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : [])).filter((x) => x.length));
const server = args.server || process.env.CLOCK_SERVER || 'http://localhost:8787';
const threads = Number(args.threads || Math.max(1, availableParallelism() - 1));
const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

const client = await runWorkerClient({ api: httpApi(server), threads, handle: args.handle || null, token: args.token || null, log });
log(`connected to ${server} as ${client.handle}`);
process.on('SIGINT', async () => { await client.stop(); process.exit(0); });
