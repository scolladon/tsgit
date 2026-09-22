---
subjects:
  - src/adapters/node/node-file-system.ts
  - src/adapters/node/node-adapter.ts
  - src/index.node.ts
  - src/ports/file-system.ts
---
# 879 — The Node adapter serves cheap serial reads synchronously under a turn budget

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (Pre-decided, D1, D3) · **Supersedes/Refines:** refines ADR-047 (the injected `fs` surface) and ADR-721 (read containment is unchanged)

## Context

Every metadata call the Node adapter makes goes through `fs.promises`, which is one libuv
threadpool round-trip per call: `statSync` costs 0.9 µs where `fs.promises.stat` costs 9.8 µs, a
`pread` on a held handle 0.6 µs against 10 µs, and `fs.promises.readFile` is four hops (80 µs for
a 25-byte file). The CPU profiles of `cat-file` and `rev-parse` are 80–83 % idle. Opening a
repository is 13 serial calls, reading one packed blob 16 more. A throwaway patch that moved only
the metadata calls and the pack `FileHandle.read` to their sync twins measured `openRepository`
0.87 → 0.32 ms, `revParse` 0.29 → 0.11 ms, a 43-deep delta chain 0.73 → 0.30 ms and a warm
20k-file `status` 145 → 96 ms.

Sync loses on bulk independent reads: 1000 small files cost 14.5 µs per file through a 32-wide
pool against 37 µs serially. Git itself is synchronous; isomorphic-git's cold-read advantage is
fewer hops, not faster hops. The port contract is Promise-returning and application code must not
learn which arm served it.

## Options considered

1. **Default-on sync fast path for cheap serial primitives, budgeted, with an opt-out** — pros:
   the measured 2–3× on every small command and cold path, git's own I/O shape / cons: a
   synchronous stall bounded by the budget; a second adapter arm to keep refusal-identical.
   *The user's choice, 2026-09-10.*
2. **Opt-in sync mode, threadpool by default** — pros: zero behaviour change for existing
   consumers / cons: nobody who has not read the docs gets the win; the default stays the slow
   shape git never had.
3. **Stay on the threadpool and only reduce hop counts** — pros: no sync work on the loop /
   cons: the per-hop floor stays; the cold-read pipeline work alone recovers under half of the
   measured win.

## Decision

**Option 1, decided by the user on 2026-09-10 and ratified here** (user judgment; not re-opened
by the design). The rules future work applies:

- The sync arm covers exactly the cheap serial primitives: `stat`, `lstat`, `exists`, `lexists`,
  `readlink`, size-gated small reads (`read`, `readUtf8`, `readSlice` below the gate) and reads
  and `fstat` on a held read handle. `readdir`, every write, reads above the gate and the
  compound operations stay on the threadpool.
- Sync work runs under a per-event-loop-turn budget: once the budget is spent the arm awaits one
  `setImmediate` before the next sync call, so a long sweep holds the loop for one budget at a
  time. The budget and gate values are ADR-880's.
- The arm is default-on and switched off per repository through the `io` option (ADR-881) for
  network or cold filesystems.
- Sync calls live only in `src/adapters/node/`. The `FileSystem` port stays Promise-returning and
  a sync arm turns every errno into the same refusal code as its async twin through the same
  `mapErrno`; a throw is always surfaced as a rejection, never a synchronous exception.
- Read containment (ADR-721) is evaluated before either arm; the sync arm never widens what a
  path may reach.

## Consequences

- Every small command and every cold path stops paying the threadpool floor by default; the
  contract suite runs both arms so the refusal matrix stays identical.
- A consumer on a network or otherwise slow filesystem opts out per repository and gets today's
  behaviour unchanged.
- The bounded stall is documented as the budget times the number of concurrently active
  repositories (ADR-890 scopes the budget).
- Sync `readdir` (ADR-886), sync writes and a fully synchronous handle open (ADR-885) are
  explicitly outside this decision and need their own record if ever revisited.
