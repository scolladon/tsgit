# ADR-143: Workers is memory-adapter-only; Deno + Bun cover Node + Memory

## Status

Accepted (at `4911c0d`)

## Context

The Phase 19.8 runtime matrix introduces three new host runtimes (Deno,
Bun, Cloudflare Workers). Each runtime has different adapter support:

- **Deno + Bun.** Both ship Node-compat layers covering
  `node:fs/promises`, `node:crypto`, `node:zlib`, `node:path` — the
  full set tsgit's Node adapter relies on. They can host either the
  Node adapter (real fs) or the Memory adapter (in-process Map).
- **Cloudflare Workers.** `workerd` has no filesystem. The
  `nodejs_compat` flag enables a small subset (`node:buffer`,
  `node:events`, etc.) but does **not** include `node:fs`. The Node
  adapter cannot load there.

A separate question: should every runtime run every scenario, or should
some scenarios be subsetted out per runtime (e.g. "Workers only runs
read-only scenarios because writes are slow")?

The scenarios as written do not differentiate read/write — they all use
the same `repo.*` API. There is no scenario whose *contract* requires
filesystem access from outside the adapter; every input is materialised
through the adapter (`openRepository({ files })` for Memory, scratch
`mkdtemp` + `writeFile` for Node).

## Decision

- **Deno + Bun.** Run scenarios × Node adapter AND scenarios × Memory
  adapter. Both runtimes get two driver files (`parity-node.test.ts`,
  `parity-memory.test.ts`).
- **Workers.** Run scenarios × Memory adapter ONLY. One driver file
  (`parity-memory.test.ts`).
- **No scenario subsetting per runtime.** Whichever adapter a runtime
  supports, it runs the full `SCENARIOS` registry through that adapter.

The matrix is therefore:

|       | Node adapter | Memory adapter | Browser adapter |
|---|---|---|---|
| Node (Vitest) | ✓ | ✓ | — |
| Browser (Playwright) | — | — | ✓ |
| Deno | ✓ | ✓ | — |
| Bun | ✓ | ✓ | — |
| Workers | — | ✓ | — |

## Consequences

### Positive

- Workers users have a clear runtime story: "Memory adapter is the
  Workers story" — documented and CI-proven.
- No per-runtime divergence in scenario selection — the parity claim
  stays simple ("every supported adapter runs every scenario").
- Future scenarios automatically join the matrix on every runtime that
  can host them; no per-runtime opt-in maintenance.

### Negative

- A Workers user who wants to clone a repo to disk has no path today.
  Acceptable — that's a feature request for a Workers-targeted adapter
  (R2/KV-backed FS), not a parity-matrix scope decision.
- One scenario lands in Workers that's a near-pure write workload (the
  write-pipeline scenario) — slightly more CPU than read scenarios. The
  free Workers CI tier handles it; if not, the job can be moved to a
  paid tier later.

### Neutral

- If a future scenario genuinely needs a filesystem (e.g. tests a
  symlink edge case), it would skip Workers automatically. That
  skipping must be explicit (a `runtimeAdapters: ['node', 'memory',
  'browser']` field on the scenario, or similar) and would be its own
  ADR. Today, no such scenario exists.
