# ADR-142: Workers driver uses `@cloudflare/vitest-pool-workers`

## Status

Accepted (at `4911c0d`)

## Context

The Phase 19.8 backlog calls for "Cloudflare Workers via `wrangler dev`
+ Workers test harness (memory adapter + HTTP transport)". Cloudflare
ships two officially-supported test patterns:

1. **`@cloudflare/vitest-pool-workers`** — a Vitest pool that runs test
   files *inside* `workerd` (Cloudflare's runtime). Tests share Vitest's
   assertion library, reporter, and CLI surface with the rest of the
   project. Wrangler config is consumed via `vitest.config.ts`.
2. **Hand-rolled `wrangler dev` harness.** Spin up `wrangler dev` in
   the background, hit endpoints over HTTP, assert from the test
   process. Tests live outside `workerd`; the worker is the system
   under test, not the harness.

Pattern 1 is the official recommendation for unit/integration-style
testing of Worker code. Pattern 2 is for full HTTP-edge-to-origin
testing.

The parity scenarios are *library-level* (`Repository` operations against
the Memory adapter). There is no HTTP endpoint to hit, no Worker
fetch-handler under test — the test body simply imports
`openRepository`, runs scenarios, asserts results. Pattern 1 matches
that shape exactly; pattern 2 would require building a fetch-handler
wrapper, serializing inputs/results over HTTP, and reconstituting them
on the test side — pure ceremony with zero added signal.

## Decision

Use `@cloudflare/vitest-pool-workers` as the Workers test runner.
Configuration at `test/runtime-parity/workers/vitest.config.ts`; a
companion `wrangler.jsonc` declares the `nodejs_compat` flag (required
for `Date`/`Promise`/`Map` — already a workerd baseline but enabling
the compat surface explicitly is idiomatic).

The parity test files are plain Vitest tests that happen to execute
inside `workerd` instead of Node. The `expect`, `describe`, `it`
primitives are re-exported by the pool — driver code is unchanged from
the Node + Memory equivalents apart from the `openRepository` import
path.

## Consequences

### Positive

- Assertions read the same as every other parity driver. No
  out-of-band serialization shim to maintain.
- Tests execute inside the real `workerd`, not a Node simulation — so
  any Node-only API leakage in the dist is caught immediately.
- Officially supported by Cloudflare; long-term maintenance burden is
  Cloudflare's, not ours.
- Single CI step (`vitest run --config ...`) instead of a multi-step
  wrangler+curl orchestration.

### Negative

- Adds `@cloudflare/vitest-pool-workers` and (transitively) `wrangler`
  + `miniflare` to devDependencies. Heavy install footprint
  (~150 MB), but only on CI runners that execute the `parity-workers`
  job.
- Couples our runner choice to Cloudflare's tooling. If the pool is
  ever deprecated, we migrate. Acceptable risk — it's their flagship
  test integration.

### Neutral

- HTTP-transport scenarios, when they land, would still work inside
  the pool (workerd's `fetch` is the system fetch); no architecture
  change required.
