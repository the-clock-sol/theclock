# THE CLOCK · engine

The attack engine behind [theclock.wtf](https://theclock.wtf), and the tools to check its
results or join the attack from your own machine.

Two engines run against the keys that protect crypto wallets:

- **Brute force.** A parallel Pollard kangaroo over secp256k1 against a ladder of
  discrete-log challenges, one bit bigger each time. Every solution is re-verified with
  `d·G = P` before it counts.
- **AI agents.** Model-driven search over the reversible circuits a quantum computer would run
  to break a key. Every edit is verified exhaustively on all valid inputs; only strictly smaller
  circuits are kept.

Both numbers go through one public formula and out comes a date. This repository holds the
maths, the verifier, the clock model, and the clients. The coordinator and the site are not in
it: nothing here needs them to check a result.

## Check a result yourself

Any cracked key or accepted circuit published on the site can be re-checked with nothing but
this repository and a Node 22 install.

```
npm test                                                      # the library's own tests
node agent/verify.js --server https://theclock.wtf --challenge 7
node agent/verify.js --server https://theclock.wtf --experiment 42
node agent/verify.js --model modadd6p61 --circuit "ccx:0,6,12 cx:0,6 ..."
node agent/replay.js --server https://theclock.wtf --id 123   # re-run an experiment from its seed
```

`verify` recomputes `d·G` for a solved challenge and compares it with the published point, or
simulates a circuit on every valid input against the model's specification and re-scores it.
`replay` re-runs a house experiment from its public seed through the same operators and
confirms the server's verdict. The site's `/verify` page does the same in the browser.

## Join the attack

Claim a name on the site (or `POST /api/handle {"handle":"your_name"}`; the token comes back
once), then:

```
node worker/node-worker.js --server https://theclock.wtf --threads 8 --handle your_name --token TOKEN
node agent/run.js --server https://theclock.wtf --handle your_name --token TOKEN [--model modadd6p61] [--rate 20]
```

The worker runs one kangaroo herd per thread and reports distinguished points. The agent pulls
the current best circuit, mutates it with the operators in `lib/optimize.js`, verifies locally
and submits improvements; the coordinator re-verifies and re-scores everything it receives.
Write your own operators, or generate candidates any way you like and post them as circuit
text to `/api/quantum/submit`. Your name goes on every key you help crack and every cut that
is accepted.

## Layout

| path | what |
|---|---|
| `lib/secp.js` | secp256k1 in BigInt, the reference every key is verified against |
| `lib/challenge.js` | controlled challenges `d·G = P` with `d < 2^bits`, and verification |
| `lib/kangaroo.js` | parallel kangaroo walker, distinguished points, batch inversion |
| `lib/walker-loop.js` | the loop a worker thread runs |
| `lib/circuit.js` | reversible circuits over X / CNOT / Toffoli, exhaustive verification, scoring |
| `lib/models.js` | test models: textbook VBE adders and modular adders |
| `lib/optimize.js` | the mutation operators |
| `lib/runner.js` | one experiment, seed to verdict, deterministic |
| `lib/clock.js` | the clock model, version 1 |
| `worker/` | backend worker: thread body, client, CLI |
| `agent/` | your own agent, replay, verify |
| `data/published.json` | the published research figures, with sources |

## The clock model

Two gaps, each a fraction between 0 and 1:

- `P_c = B / 256`, where `B` is the biggest key cracked and verified, in bits.
- `P_q` is how far the quantum resource count has fallen from the reference, on a log scale,
  with the test-circuit gains added on the same scale.

`P = 0.5 · P_c + 0.5 · P_q`, and the date is `epoch + horizon · (1 − P)` days. Constants and
inputs are in `lib/clock.js` and on `/api/clock/model`.

## Data integrity

Every number carries one of four categories and they are never mixed: `PUBLISHED_RESEARCH`
(credited to its source), `EXPERIMENTAL_RESULT` (test circuits), `MEASURED_RESULT` (verified
keys), `ILLUSTRATIVE_DATA` (never shown as a result). A key the coordinator sets for itself is
not a wallet; cracking one proves that a k-bit interval of the curve can be searched, nothing
more.

## Public API

```
GET  /api/state                       everything the page shows
GET  /events                          SSE: `tick` every 2 s, `event` per event
GET  /api/events?type=&before=&limit= event log, /api/events/:id for one
GET  /api/clock  /api/clock/model     the reading and the model constants
GET  /api/published                   the published figures with sources
GET  /api/leaderboard                 handles by verified work
POST /api/handle                      claim a name, returns a token once
POST /api/classical/register          register a worker under a handle
GET  /api/classical/work?worker=      the current challenge and walker assignment
POST /api/classical/report            distinguished points; solutions are verified here
GET  /api/classical/challenges[/:id]  every challenge, with solutions and who cracked them
GET  /api/quantum/state  /best?model= /experiments[/:id]  /records
POST /api/quantum/submit              a circuit; verified on all inputs before it counts
```

Requires Node 22.13 or newer. No dependencies.
