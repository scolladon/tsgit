# Plan — Node I/O strategy and the cold read pipeline

> Source: design doc `docs/design/node-io-cold-read-pipeline.md` · ADRs 879–892 (all bind), plus
> ADR-047 (superseded for the constructor signature by ADR-883), ADR-719, ADR-720, ADR-721,
> ADR-722, ADR-735, ADR-773, ADR-850, ADR-859, ADR-873
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a path in backticks:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

### How this plan maps to the design's ten parts

The design's numbering is kept so the PR body maps one to one. Seven design parts exceed the
six-file ceiling or five RED→GREEN cycles, so they carry a letter suffix; one docs-only part is
added. 18 parts, one branch, one PR, ordered commits.

| Plan part | Design | Why it differs |
|---|---|---|
| 1 | P1 | The upgrade note and the regenerated API report move to Part 11 (the atomic migration already needs six edited files) |
| 2 | P2 | also gains `now` on `TurnBudget` and the shared `runWithinBudget` helper, so every sync arm times itself the same way |
| 3a, 3b | P3 | metadata arms and small-read/handle arms are two sets of five cycles |
| 4a, 4b | P4 | option plumbing and open-path batching touch disjoint logic; together they are twelve files |
| 5a, 5b | P5 | port + adapters + validator, then the callers; the browser arms move to Part 10a (it edits the same file) |
| 6a, 6b | P6 | the shared listing and fold, then the order swap with its interop pin; the `hasObject` rider moves to Part 9a |
| 7 | P7 | unchanged |
| 8a, 8b | P8 | the eager refusal of the two window keys, then the cache itself |
| 9a, 9b | P9 | application-layer riders, then adapter-layer riders |
| 10a, 10b | P10 | browser riders, then the profile-tool harness |
| 11 | (new) | docs-only: upgrade note, `io` docs, API report regenerated once for every public change |

### Order and parallelism

```
adapter chain:  1 ─┐
                2 ─┴─► 3a → 3b → 4a → 4b → 5a → 5b
registry chain: 6a → 6b → 7 → 8a → 8b
riders:         9a, 9b (independent of both chains)
browser/tools:  10a (after 5a and 8b) → 10b (after every src part; it regenerates the perf baseline)
docs:           11 (last; after 1, 4a, 5a, 6a, 6b, 8a)
```

Parts 1 and 2 share no file. The registry chain shares no file with the adapter chain, and
Parts 9a/9b share no file with either. Sequential parts share one working tree. Where two
parts edit one file (`node-file-system.ts` in 1/3a/3b/5a, `pack-registry.ts` in 6a/7/8b,
`index.node.ts` in 1/4a/4b) they are sequential by the order above.

## Shared context (every part inherits this; do not restate it per part)

### Repo rules

- **Tests:** `describe('Given …')` > `describe('When …')` > `it('Then …')` (the two-level
  `describe('Given …, When …')` shortcut only when one expectation lives under it); AAA body with
  `// Arrange` / `// Act` / `// Assert` comments; the system under test is always `sut`.
  100 % line/branch/function/statement coverage; 0 surviving mutants (an equivalent mutant is
  proven in prose in the hand-off report, never silenced). Error assertions read `.data` (code and
  payload) through try/catch, never a bare `toThrow(Class)`. Every operand of a guard gets its
  own isolated row (`isFile && size <= gate` needs a non-file-small row and a file-large row).
- **No suppression directives** of any flavour (`@ts-ignore`, `biome-ignore`, coverage or
  mutation ignores). **No provenance refs** (ADR numbers, part ids, backlog ids) in `src/` or
  `test/` — describe the mechanism instead.
- **Style:** functions under 20 lines, early returns, no boolean parameters, no magic values
  (named constants), immutable data, `unknown` + narrowing (no `any`), kebab-case file names.
- **Errors across module graphs:** classify on `errorDataCode(err)` (src/domain/error-data-code.ts),
  never `instanceof TsgitError`. Async adapter paths `return await` (workerd reports a
  handler-less rejection otherwise). No swallowed errors: handle, rethrow, or log with context.
- **Git-faithfulness (ADR-226):** object bytes, refusals and state files match git 2.55.0.
  Interop tests build repositories with real `git` (scrubbed `GIT_*` env through `runGit` /
  `runGitEnv` in test/integration/interop-helpers.ts, isolated `HOME`,
  `GIT_CONFIG_NOSYSTEM=1`, signing off, `mkdtemp` throwaways), reconstruct git's human output
  from tsgit's structured fields in the test, and give `beforeAll` an explicit 60 s timeout.
- **Integration tests may not use `vi.mock`, `vi.fn`, `vi.spyOn`, `vi.stubGlobal` or
  `vi.stubEnv`** (test-pyramid-budgets.json `overMockedIntegration`, threshold 0).
- **Structured output (ADR-249):** no new option steers rendered text.

### Public surface — decided up front

| Symbol | Where | Public? | Surface gates owed |
|---|---|---|---|
| `NodeFileSystemOptions` (type) | src/adapters/node/node-file-system.ts, re-exported from src/adapters/node/index.ts next to `NodeFileSystem` | **public** | barrel line (Part 1); `reports/api.json` (Part 11); upgrade note (Part 11) |
| `NodeFileSystemOptions.syncIo` | same | **internal member**: doc comment carries `@internal` (typedoc runs with `excludeInternal`) | none |
| `io?: 'sync-fast-path' \| 'threadpool'` on `OpenNodeRepositoryOptions` and `NodeAdapterOptions` | src/index.node.ts, src/adapters/node/node-adapter.ts | **public field** (inline literal union, no new named type) | `reports/api.json`, docs/get-started/node.md, docs/understand/performance.md (Part 11) |
| `FileSystem.tryLstat?`, `FileSystem.tryReadUtf8?` | src/ports/file-system.ts (barrelled through src/ports/index.ts) | **public optional port members** | `reports/api.json` (Part 11) |
| `ParsedConfig.core.packedGitWindowSize?`, `.packedGitLimit?` | src/application/primitives/config-read.ts (`ParsedConfig` is barrelled) | **public fields** | `reports/api.json` (Part 11) |
| `TurnBudget`, `SyncIoPolicy`, `createTurnBudget`, `createSyncIoPolicy`, `runWithinBudget`, `syncIoPolicyFor`, `SyncFsOperations`, `realSyncFsOps` | src/adapters/node/sync-io-budget.ts, src/adapters/node/fs-operations.ts | **internal** — never added to src/adapters/node/index.ts | none |
| `readRegularFileSync` | src/adapters/node/node-file-system.ts | **internal** (`@internal`, not barrelled) | none |
| `createPackWindowCache`, `packWindowBudgetFor`, `DEFAULT_PACK_WINDOW_BYTES`, `DEFAULT_PACK_WINDOW_LIMIT_BYTES` | src/application/primitives/internal/pack-window-cache.ts | **internal** (`internal/` is not barrelled) | none |
| `findFirstInvalidPackedGitBound` | src/application/primitives/config-read.ts | **internal** — NOT added to src/application/primitives/index.ts | none |
| `lstatIfPresent`, `readUtf8IfPresent` | src/application/primitives/internal/fs-probes.ts | **internal** | none |

No new error code, command, facade method or registry entry. `reports/api.json` staleness is a
**prepush** gate (`check:doc-typedoc`), not a `validate` gate, so it is regenerated once, in
Part 11, after every public change has landed (Decision candidate DC-6).

A new internal export that has no `src/` consumer until a later part trips `check:dead-code`
(knip) at the phase gate only; the part gates below do not run knip, and by the phase gate every
export has its consumer.

### Measurement harness (every probe step uses it)

- **bench:ab** — `npm run bench:ab -- main HEAD 3` (base ref, head ref, rounds); read the
  named rows, report both sides' absolute numbers. Local numbers only; CI absolutes are the PR's
  concern (design D10).
- **Fixtures** — `~/.cache/tsgit-bench/<name>/` (`single-pack-v3`, `many-pack-no-midx-v3`,
  `delta-chain-v3`, `loose-only-v3`, `medium-v3`); the repository is the working tree inside it
  (`d0` for `single-pack-v3` — confirm with `ls`); `meta.json` carries `firstBlobId` /
  `headCommitId`.
- **Trace shim** (DC-1, recommendation (a)): the 31.1/31.2 `fs-count.cjs` wraps only
  `fs.promises` and reports a false drop once sync arms exist. Write this preload into the part's
  scratchpad (never into the worktree), `npm run build:profile`, then run
  `node --require <scratch>/fs-trace.cjs <scratch>/probe.mjs`:

```js
// fs-trace.cjs — counts fs.promises, *Sync and FileHandle calls while started
'use strict';
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const log = [];
let root = null;
const rel = (p) => (typeof p === 'string' && root ? p.split(root).join('<R>') : '');
const wrap = (owner, name, label) => {
  const original = owner[name];
  if (typeof original !== 'function') return;
  owner[name] = function traced(...args) {
    if (root !== null) log.push(`${label} ${rel(args[0])}`.trim());
    return original.apply(this, args);
  };
};
for (const n of ['stat', 'lstat', 'readFile', 'readdir', 'readlink', 'realpath', 'open']) wrap(fs.promises, n, n);
for (const n of ['statSync', 'lstatSync', 'readlinkSync', 'openSync', 'fstatSync', 'readSync', 'closeSync']) wrap(fs, n, n);
wrap(fs.realpathSync, 'native', 'realpathSync.native');
syncBuiltinESMExports();
globalThis.__fsTrace = {
  ready: fs.promises.open(__filename).then(async (h) => {
    const proto = Object.getPrototypeOf(h);
    for (const n of ['read', 'stat', 'close']) wrap(proto, n, `FH.${n}`);
    await h.close();
  }),
  start: (r) => { log.length = 0; root = r; },
  stop: () => { root = null; return log.slice(); },
};
```

```js
// probe.mjs — second iteration is the recorded one; IO unset before Part 4a
import { openRepository } from '<worktree>/dist-profile/esm/index.node.js';
await globalThis.__fsTrace.ready;
const { FIXTURE: root, BLOB: blob, IO: io } = process.env;
for (let i = 0; i < 2; i += 1) {
  globalThis.__fsTrace.start(root);
  const repo = await openRepository(io ? { cwd: root, io } : { cwd: root });
  const open = globalThis.__fsTrace.stop();
  globalThis.__fsTrace.start(root);
  await repo.primitives.readBlob(blob);
  const read = globalThis.__fsTrace.stop();
  await repo.dispose();
  if (i === 1) console.log(JSON.stringify({ open, read }, null, 1));
}
```

  Baselines from the design (main 46ac2df5): open 13 calls; open + one packed blob on
  `single-pack-v3` 16 post-open calls; `revParse('HEAD')` warm 9 calls; many-pack cold 110
  calls; 43-deep delta leaf 59 calls, 44 of them `FH.read`. Record numbers in the hand-off report; the
  PR body collects them.

### Gate conventions

- Every gate command is **foreground** — never end a turn waiting on a background notification.
- `npm run check:types` and `npm run check:spelling` are wireit-cached and print
  `Ran 0 scripts and skipped 1` on a stale hit; every part therefore also runs the bare bypasses
  `npx tsc --noEmit -p tsconfig.json` and `npx cspell --no-progress <touched files>` (never pass
  cspell.json itself; reword instead of editing cspell.json).
- Parts that touch `src/adapters/**` or the pack registry run
  `npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun`
  (not in `validate`).
- Phase gate after Part 11: `npm run validate`.

## Decision candidates

Load-bearing choices the design and ADRs do not settle. Each part below is written against the
**recommendation**; a different settlement changes only the part named.

| # | Choice | Alternatives (≤3) | Recommendation | Why | Part |
|---|---|---|---|---|---|
| DC-1 | Where the trace shim lives | (a) embedded in this plan, written into each part's scratchpad, never committed; (b) committed `tooling/fs-trace.cjs` with a unit test; (c) a `--trace` mode in tooling/profile.ts | **(a)** | It is a measurement aid, not product: committing it drags it through biome, knip, coverage and mutation for no user value. The plan text makes regeneration zero-rediscovery. | all probes |
| DC-2 | `read-sparse-checkout.ts` conversion (ADR-884 lists it) | (a) leave it on its `FILE_NOT_FOUND` catch and record it with the cold sites in the PR (amend ADR-884's list); (b) `lstatIfPresent` as an absence gate, then today's `read` (one extra `lstat` when the file exists; the `read` keeps its catch for a dangling link); (c) `tryReadUtf8` + `TextEncoder` byte count for the cap | **(a)** | The function reads **bytes** (`ctx.fs.read`) and caps them before decoding; `tryReadUtf8` would decode first (breaking "an over-cap file never reaches the decoder") and (b) adds a call on every sparse repository to save one refusal per command. | 5b |
| DC-3 | Scope of the speculative open-probe batch | (a) speculate `commondir`/`objects`/`refs` only for the .git-directory candidate; the per-level bare-directory check stays serial; (b) speculate on every `layoutFor` call (the design's text); (c) batch only `readLink(HEAD)` + `stat(HEAD)` | **(a)** | `findLayout` calls `layoutFor` on **every** climbed level for the bare-directory check. (b) would add three stats per level for a cwd deep inside a worktree, which breaks the design's own "call count stays the same or falls". (a) keeps 8 → 3 rounds on the discovered repository and today's count on every climbed level. | 4b |
| DC-4 | Sync small read when the file grows between `fstat` and the EOF check | (a) any growth → hand the whole read to the async arm; (b) the design's loop: keep reading up to the gate, delegate only past it | **(a)** | One branch instead of a loop; ADR-880's invariant (never truncated, gate never exceeded) holds in both; growth mid-read is rare enough that the async cost is irrelevant. | 3b |
| DC-5 | Buffer for the sync `read`/`readUtf8` arm | (a) `Buffer.allocUnsafeSlow(size)` (not pooled, exact fit); (b) the design's `Buffer.allocUnsafe(size)` | **(a)** | The arm returns a **view** over its buffer. `allocUnsafe` below 4 KiB slices Node's shared 8 KiB pool, so the view's `.buffer` would expose unrelated bytes and could alias later allocations. (a) makes the view own its memory. | 3b |
| DC-6 | When `reports/api.json` and the upgrade note land | (a) once, in docs-only Part 11, after every public change; (b) in each part that changes the surface (1, 4a, 5a, 8a) | **(a)** | The API report is a prepush gate, not a part or validate gate, and each regeneration is a large typedoc-id diff; (b) also pushes the atomic Part 1 over the file ceiling. | 1, 11 |
| DC-7 | Validation of `io` | (a) one resolver `syncIoPolicyFor(io)` in the adapter layer throws `INVALID_OPTION` for any other value and serves both `openRepository` and `createNodeContext`; src/repository/validate-options.ts untouched; (b) the design: `validateIo` in validate-options.ts for `openRepository` only, `createNodeContext` unvalidated; (c) both | **(a)** | One rule for both entry points; adapters may import the domain's `invalidOption`; it still runs before any I/O. (b) leaves `createNodeContext({ io: 'thread-pool' })` silently on the fast path. | 4a |

## Part 1 — `NodeFileSystem` takes one options object

### Context

Mechanical, behaviour-free migration (ADR-883). **Atomic by necessity**: changing the constructor
turns every positional site red, so the constructor and all sites land in one commit — this is
why the part sits at the six-file ceiling. Probe: none at runtime (no behaviour change).

**Edited files:**

- `src/adapters/node/node-file-system.ts` — `NodeFileSystem` `constructor` at lines 524-548.
  Today: `constructor(rootDir: string | ReadonlyArray<string>, pathPolicy: PathPolicy = nativePolicy, fsOps: FsOperations = realFsOps, rootsArePreResolved = false, removeTreeConcurrency: number = REMOVE_TREE_CONCURRENCY)`.
  New: `constructor(rootDir: string | ReadonlyArray<string>, options: NodeFileSystemOptions = {})`
  destructuring `{ pathPolicy = nativePolicy, fsOps = realFsOps, rootsArePreResolved = false, removeTreeConcurrency = REMOVE_TREE_CONCURRENCY }`
  in the body; the empty-roots refusal (`unsupportedOperation('constructor', …)`) and the field
  assignments are unchanged. Add, exported and documented next to the class:
  `export interface NodeFileSystemOptions { readonly pathPolicy?: PathPolicy; readonly fsOps?: FsOperations; readonly rootsArePreResolved?: boolean; readonly removeTreeConcurrency?: number }`
  — **without** `syncIo` (Part 3a adds it). Unchanged: `FsOperations`, `realFsOps`, and the
  helpers taking an `fsOps` argument (`realpathNearestExisting(absolute, policy, fsOps)`, called
  from `canonicalizeRoots` ~line 591 and `realpathForCreation` ~line 1192 with
  `this.pathPolicy, this.fsOps`).
- `src/adapters/node/index.ts` — line `export { NodeFileSystem } from './node-file-system.js';`
  becomes `export { NodeFileSystem, type NodeFileSystemOptions } from './node-file-system.js';`
  (the `NodeAdapterOptions` line above is the pattern).
- `src/index.node.ts` — `openRepository` line 108
  `new NodeFileSystem(roots, nativePolicy, undefined, canonical)` →
  `new NodeFileSystem(roots, { pathPolicy: nativePolicy, rootsArePreResolved: canonical })`;
  delete the two comment lines 106-107 about the `undefined` third argument (keep the rest of
  the comment block above). `makeWorktreeFs` lines 144-149
  `new NodeFileSystem([...], nativePolicy)` → `new NodeFileSystem([...], { pathPolicy: nativePolicy })`;
  the comment above the array argument stays attached to it.
- `test/unit/adapters/node/node-file-system-injected.test.ts` — 117 sites:
  `new NodeFileSystem(root, policy, fakeFsOps(…))` → `new NodeFileSystem(root, { pathPolicy: policy, fsOps: fakeFsOps(…) })`;
  the 3 four-argument sites add `rootsArePreResolved`. The new option-default rows go here
  (describe `NodeFileSystem — options object (DI)` at the end of the file).
- `test/unit/adapters/node/node-file-system-rename-kinds.test.ts` — 35 three-argument sites, same
  rewrite.
- `test/unit/adapters/node/node-file-system.test.ts` — 13 sites: 6 migrate (`(root, policy)` ×3
  → `{ pathPolicy: policy }`; `(root, undefined, fsOps)` ×2 → `{ fsOps }`;
  `(root, undefined, fsOps, undefined, concurrency)` ×1 → `{ fsOps, removeTreeConcurrency: concurrency }`,
  near the `getMaxInFlight` helper ~line 50-62); 7 single-argument sites unchanged.

**Read-only / unchanged single-argument sites (verify they still compile):**
src/adapters/node/node-adapter.ts line 76 (`new NodeFileSystem(workDir)`), four files in
test/integration/posix-only/, two in test/integration/win-only/,
test/integration/sha256-object-format-interop.test.ts. test/unit/adapters/node/node-fs-fakes.ts
header comment says "third parameter" — it is **not** edited here (Part 3a edits that file and
rewords the comment).

**Pinned count:** `git grep -c 'new NodeFileSystem(' -- src test` totals 176 sites in 12 files
before; the same after.

### TDD steps

1. **RED** — in the new describe of `node-file-system-injected.test.ts`, write one row per option
   (each option absent → documented default; present → honoured), constructing through the new
   shape: `rootsArePreResolved` absent → `fsOps.realpath` is called on the first `exists`;
   present `true` → not called; `removeTreeConcurrency` absent → max in-flight `rm` of a
   16-entry tree is 8, present `2` → 2 (reuse the in-flight counting fake); `fsOps` present →
   the fake is reached; `pathPolicy` present (a Windows policy from
   src/adapters/node/path-policy.ts) → a backslash path resolves under it. Fails to compile:
   the constructor takes no options object.
2. **GREEN** — change the constructor and add `NodeFileSystemOptions`; the new rows pass, every
   old positional site is now a type error.
3. **GREEN** — migrate the sites cluster by cluster (src first, then the three test files) until
   `npx tsc --noEmit -p tsconfig.json` is clean. A scripted rewrite is fine; review the diff.
4. **REFACTOR** — re-export the type from `src/adapters/node/index.ts`; delete the stale comment
   in `index.node.ts`.
5. **Probe** — record `git grep -c 'new NodeFileSystem(' -- src test` before step 2 and after
   step 3; the totals must match (176).

### Gate

```
npx vitest run test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system-rename-kinds.test.ts test/unit/index.node.test.ts test/unit/adapters/node/node-adapter.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts src/adapters/node/index.ts src/index.node.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system-rename-kinds.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/adapters/node/node-file-system.ts src/index.node.ts test/unit/adapters/node/node-file-system-injected.test.ts \
  && npx vitest run --project posix-integration \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`refactor(node)!: take NodeFileSystem options in one object`

## Part 2 — `TurnBudget`, `SyncIoPolicy`, `SyncFsOperations`

### Context

New adapter state (design D1, D2; ADR-880, ADR-890). No consumer yet (Part 3a is the first).
Probe: a micro-bench of `admit()` + `charge()` overhead.

**Created: `src/adapters/node/sync-io-budget.ts`** (internal; never barrelled):

- `export interface TurnBudget { readonly admit: () => Promise<void> | undefined; readonly charge: (startedAt: number) => void; readonly now: () => number }`
  — `now` is added to the design's shape so every arm reads the budget's own injected clock for
  `startedAt` (tests inject one clock for both).
- `export interface SyncIoPolicy { readonly ops: SyncFsOperations; readonly budget: TurnBudget; readonly maxSyncReadBytes: number }`.
- Named constants `SYNC_TURN_BUDGET_MS = 1` and `MAX_SYNC_READ_BYTES = 64 * 1024` (ADR-880; not
  options).
- `export const createTurnBudget = (budgetMs: number, clock: () => number = performance.now.bind(performance), scheduleTurnEnd: (cb: () => void) => void = setImmediate): TurnBudget`.
  State: `spent`, `armed`, one pending deferred. Semantics (pin each in a row):
  - `charge(startedAt)` adds `clock() − startedAt` to `spent`; the first charge in a turn arms
    **one** `scheduleTurnEnd` marker.
  - the marker resets `spent` to 0, disarms, and resolves the shared pending promise (if any).
  - `admit()` returns `undefined` while `spent < budgetMs`; otherwise it returns the shared
    pending promise (created on first need; N callers get the same promise) and arms the marker
    if none is armed (so `createTurnBudget(0)` yields once per call instead of deadlocking).
  - `now()` returns `clock()`.
- `export const createSyncIoPolicy = (): SyncIoPolicy` →
  `{ ops: realSyncFsOps, budget: createTurnBudget(SYNC_TURN_BUDGET_MS), maxSyncReadBytes: MAX_SYNC_READ_BYTES }`.
- `export const runWithinBudget = async <T>(budget: TurnBudget, op: () => T): Promise<T>` —
  `const wait = budget.admit(); if (wait !== undefined) await wait;` then
  `const startedAt = budget.now(); try { return op(); } finally { budget.charge(startedAt); }`.
  Being `async`, a throw from `op` becomes a rejection (callers never see a synchronous throw).

**Edited: `src/adapters/node/fs-operations.ts`** — keep the module doc (`@internal`), add
`import * as fs from 'node:fs';` and
`export type SyncFsOperations = Pick<typeof fs, 'statSync' | 'lstatSync' | 'readlinkSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'> & { readonly realpathSync: { readonly native: typeof fs.realpathSync.native } };`
and `export const realSyncFsOps: SyncFsOperations = fs;`. `FsOperations` and `realFsOps` are
unchanged.

**Created: `test/unit/adapters/node/sync-io-budget.test.ts`** — inject a manual clock
(`let t = 0; const clock = () => t;`) and a collecting scheduler
(`const marks: Array<() => void> = []; const schedule = (cb) => { marks.push(cb); }`), fire
markers by hand.

### TDD steps

1. **RED** — `Given a fresh budget of 1 ms, When admit runs, Then it returns undefined` and
   `Given charges totalling 0.4 ms, …` (under budget). Fails: module missing.
2. **GREEN** — `createTurnBudget` with `admit`/`charge`/`now`.
3. **RED** — exactly-at-budget row (`spent === budgetMs` → a promise; kills `>=`→`>`); over
   budget → three callers get the **same** promise (`toBe`); one marker armed for two charges
   in a turn (`marks.length === 1`); marker fires → promise resolves and the next `admit` is
   `undefined`; `createTurnBudget(0)`: `admit` arms a marker and resolves after it fires. Fails
   until the pending/marker logic exists.
4. **GREEN** — deferred + marker logic.
5. **RED** — `runWithinBudget`: when admitted, `op` has already run by the time the call
   returns its promise (a flag set inside `op` is `true` before the first `await`), `charge`
   receives `now()`'s value and the promise resolves to `op`'s result; waits for the marker when
   over budget (op not called before firing); a throwing `op` rejects with the same error and
   still charges. `createSyncIoPolicy()` returns the 1 ms / 64 KiB constants and
   `realSyncFsOps` (`toBe(realSyncFsOps)`).
6. **GREEN** — `runWithinBudget`, `createSyncIoPolicy`, the fs-operations type and value.
7. **REFACTOR** — keep every function under 20 lines; constants named.
8. **Probe** — scratch script (not committed): 1 000 000 × (`admit()` + `charge(now())`) on a
   real `createTurnBudget(1)`; report ns/op. Expect ≤ 150 ns/op (design: 0.13 µs). If above,
   report and continue — the constant is a measurement, not a gate.

### Gate

```
npx vitest run test/unit/adapters/node/sync-io-budget.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/adapters/node/sync-io-budget.ts src/adapters/node/fs-operations.ts test/unit/adapters/node/sync-io-budget.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/adapters/node/sync-io-budget.ts src/adapters/node/fs-operations.ts test/unit/adapters/node/sync-io-budget.test.ts \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`feat(node): add the per-turn sync I/O budget and policy`

## Part 3a — `NodeFileSystem` metadata sync arms

### Context

Design D1 arm pattern, D3 rows `stat`/`lstat`/`exists`/`lexists`/`readlink` and root
canonicalisation (ADR-879, ADR-721, ADR-811–825 parity). After this part nothing is default-on
yet: only an adapter constructed with `syncIo` takes the arms (Part 4a wires the default).
Probe: a direct adapter micro-probe (benches cannot see this part yet).

**Edited: `src/adapters/node/node-file-system.ts`**

- `NodeFileSystemOptions` gains `/** @internal */ readonly syncIo?: SyncIoPolicy;` stored in a
  new `private readonly syncIo: SyncIoPolicy | undefined`. Absent → every method runs today's
  code path, byte for byte.
- New module-level helper `runSync<T>(budget: TurnBudget, op: () => T, path: string): Promise<T>`
  — `runWithinBudget(budget, op)` with the same catch shape as `runFs` (lines 288-295):
  `isErrnoException(err)` → `throw mapErrno(err, path)`, anything else rethrown untouched.
- Arms (each still `async`, still `resolveRead` first — ADR-721):
  - `stat` (line 752), `lstat` (758): sync → `mapStat(ops.statSync(real, { bigint: true }))` /
    `lstatSync`; async unchanged.
  - `exists` (733) / `lexists` (737) via `isPresent(path, probe)` (739-750): sync →
    `ops.statSync|lstatSync(real, { throwIfNoEntry: false }) !== undefined`; `ENOENT` is the
    only errno folded (by Node itself); `ENOTDIR` still throws → `NOT_A_DIRECTORY`. Extract the
    async catch into a shared module helper (it is reused by Part 5a's `tryX` async arms):
    `ENOENT` → absent, other errno → `mapErrno`, non-errno → rethrow. Do **not** reuse
    `orMissing` (line 167) — it also folds `ENOTDIR`.
  - `readlink` (975): sync → `ops.readlinkSync(real)` (string); callers normalise link text
    exactly as today (Windows backslashes are the caller's concern, unchanged).
  - `canonicalizeRoots` (576-605): under a policy, `ops.realpathSync.native(root)` replaces
    `this.fsOps.realpath(root)` inside the same `try` (run through `runWithinBudget`, raw errno
    kept — this site classifies raw `ENOENT` itself); the nearest-existing fallback stays async.
    `rootsArePreResolved` still skips it.
- Everything else (`read`, `readSlice`, `readUtf8`, `openWithNoFollow`, writes, `readdir`) is
  untouched here.

**Edited: `test/unit/adapters/node/node-fs-fakes.ts`** — add
`fakeSyncFsOps(overrides: Partial<SyncFsOperations> = {}): SyncFsOperations` (every member a
`vi.fn` throwing `enoent()` by default; `realpathSync: { native: vi.fn(() => { throw enoent(); }) }`)
and `fakeSyncIoPolicy(ops, budget?)` whose default budget always admits (`admit → undefined`,
`charge` a `vi.fn`, `now → 0`). Reword the header comment ("third parameter" → "the `fsOps` /
`syncIo` members of the options object").

**Edited: `test/unit/adapters/node/node-file-system.test.ts`** — line 64-102
`fileSystemContractTests(async () => { … new NodeFileSystem(rootDir) … })`: extract the env
builder into a local `buildContractEnv(options?: NodeFileSystemOptions)` and call
`fileSystemContractTests` a **second** time inside
`describe('NodeFileSystem with the sync fast path', …)` with
`{ syncIo: createSyncIoPolicy() }` (R5: both modes, every CI OS). Also here: the real-timer row
(a `setTimeout(…, 0)` scheduled before a 5000-`lstat` sweep through a policy-bearing adapter
fires before the sweep resolves — R4).

**Edited: `test/unit/adapters/node/node-file-system-injected.test.ts`** — one describe per arm
(`NodeFileSystem.<method> — sync arm (DI)`), constructed with
`{ pathPolicy, fsOps: fakeFsOps(), syncIo: fakeSyncIoPolicy(fakeSyncFsOps({ … })) }`.

Read-only references: src/adapters/node/sync-io-budget.ts (Part 2), test/unit/ports/file-system.contract.ts
(`fileSystemContractTests(createSut)` at line 206).

### TDD steps

1. **RED** — `lstat`/`stat` sync arm: the fake `lstatSync` is called with `(real, { bigint: true })`
   and the async `fsOps.lstat` is not; errno table rows (`ENOENT`→`FILE_NOT_FOUND`,
   `ENOTDIR`→`NOT_A_DIRECTORY`, `EACCES`/`EPERM`/`ELOOP`/`EISDIR`→`PERMISSION_DENIED`, unknown
   → `UNSUPPORTED_OPERATION`) asserted on `.data` and equal to the async arm's; a non-errno
   `TypeError` is rethrown as the same object. Fails: no `syncIo` option.
2. **GREEN** — option member, field, `runSync`, the two arms.
3. **RED** — `exists`/`lexists`: `undefined` from `statSync(…, { throwIfNoEntry: false })` →
   `false`; a stat object → `true`; `ENOTDIR` thrown → rejects `NOT_A_DIRECTORY`. **GREEN** —
   sync branch in `isPresent`, shared async catch helper extracted.
4. **RED** — `readlink` sync arm (called, async not; `EINVAL` → `UNSUPPORTED_OPERATION` as the
   async arm maps it). **GREEN**.
5. **RED** — budget: a `fakeSyncIoPolicy` whose `admit` returns a pending promise → the sync op
   is not called until the promise resolves; `charge` receives `now()`'s value. `canonicalizeRoots`:
   with a policy, the first `exists` calls `realpathSync.native` and not `fsOps.realpath`;
   `ENOENT` from it still takes the nearest-existing fallback. **GREEN**.
6. **RED → GREEN** — the dual-mode contract run and the real-timer row in
   `node-file-system.test.ts`: write them before step 2 (they fail to compile until the
   `syncIo` member exists) and they pass once the arms land.
7. **REFACTOR** — no arm over 20 lines; shared tail in `runSync`.
8. **Probe** — scratch script over the source build (`npx tsx` or a dist-profile rebuild): 10 000
   `lstat` of an existing file through `new NodeFileSystem(root)` vs
   `new NodeFileSystem(root, { syncIo: createSyncIoPolicy() })`; report µs/op both. Expect
   ≈ 10 µs async vs ≤ 3 µs sync.

### Gate

```
npx vitest run test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system-rename-kinds.test.ts test/unit/adapters/node/node-file-system.properties.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts test/unit/adapters/node/node-fs-fakes.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/adapters/node/node-file-system.ts test/unit/adapters/node/node-fs-fakes.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts \
  && npx vitest run --project posix-integration \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`perf(node): serve stat, lstat, exists and readlink synchronously under a sync policy`

## Part 3b — `NodeFileSystem` small-read and held-handle sync arms

### Context

Design D3 rows `read`/`readUtf8`/`readSlice`/`FileHandle.read`/`.stat`, the view rider, FIFO
safety (R6), ADR-880 read-time gate, ADR-885 (held handles open async, read sync through `fd`).
Probe: direct adapter micro-probe.

**Edited: `src/adapters/node/node-file-system.ts`**

- New exported (`@internal`, not barrelled — Part 4a's layout probe reuses it) module function
  `readRegularFileSync(ops: SyncFsOperations, real: string, maxBytes: number): Uint8Array | undefined`:
  `openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))` (Windows has no
  `O_NONBLOCK`), then in `try`/`finally closeSync(fd)`: `fstatSync(fd)`; not `isFile()` or
  `size > maxBytes` → `undefined`; else `Buffer.allocUnsafeSlow(size)` (DC-5) filled by
  `readSync(fd, buf, n, size − n, n)` until `n === size` or a 0-byte read (a shrunk file returns
  the shorter view); when `n === size`, one extra 1-byte `readSync` at position `size` — any byte
  means the file grew → `undefined` (DC-4). Returns
  `new Uint8Array(buf.buffer, buf.byteOffset, n)`. Open/fstat/read errno propagate raw (the arm
  maps them).
- `read` (634-638): sync → `runSync(budget, () => readRegularFileSync(ops, real, gate), path)`;
  `undefined` → today's async arm. Async arm rider: wrap `fsOps.readFile`'s Buffer as a view
  when `buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength`, copy otherwise
  (today it always copies).
- `readUtf8` (661-665): same arm, decode with `Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8')`
  (identical to `readFile(real, 'utf-8')`: neither strips a BOM).
- `readSlice` (640-659): keep the negative-offset/length refusal first. Sync arm when
  `length <= gate`: open/fstat guard as above (non-regular → async arm), then
  `readSync(fd, buf, 0, length, offset)` → `bytesRead` view (today's `allocUnsafe` shape is fine
  here: it matches the async arm's existing allocation); `length > gate` → async arm.
- `wrapNodeHandle` (353-370) → `wrapNodeHandle(handle, syncIo?: SyncIoPolicy)`: with a policy,
  `read` → `runWithinBudget(budget, () => ops.readSync(handle.fd, buffer, offset, length, position ?? null))`,
  `stat` → `mapStat(ops.fstatSync(handle.fd, { bigint: true }))` inside `runWithinBudget`.
  **No `mapErrno` here** — today's handle arms surface raw errors, and the sync arm keeps that.
  `write` and `close` unchanged. `openWithNoFollow` (1028-1068) passes `this.syncIo` only for
  `mode === 'read'`; the `open` itself stays `this.fsOps.open` (async, ADR-885).

**Edited: `test/unit/adapters/node/node-file-system-injected.test.ts`** — describes per arm:
sync taken; non-regular (fake `fstatSync` → `isFile() === false`) → async fallback **and**
`closeSync` called; above gate (`size = gate + 1`) → async fallback; at gate (`size = gate`) →
sync; growth (extra `readSync` returns 1) → async fallback; shrink → shorter view; `closeSync`
runs when `readSync` throws; `read` async arm view vs copy (a fake `readFile` returning an
exact-fit Buffer → same `ArrayBuffer`; a pooled slice → different); handle `read`/`stat` sync
with a policy, async for `'write'` handles and without a policy.

**Created: `test/integration/posix-only/node-fs-fifo-read.test.ts`** — a named pipe created by the POSIX FIFO-making command through
`execFileSync` (no Node API creates one); a policy-bearing adapter's `readUtf8(fifo)` stays pending while
a `setTimeout(…, 0)` timer fires, then a writer (`fs.promises.writeFile(fifo, 'x')`) lets it
resolve to `'x'`. No `vi.*` (integration rule). Same row for `read`.

Read-only: src/adapters/node/sync-io-budget.ts, test/unit/adapters/node/node-fs-fakes.ts
(Part 3a helpers), the contract suite (already dual-mode since Part 3a).

### TDD steps

1. **RED** — `readUtf8`/`read` small regular file: fake `openSync`/`fstatSync`/`readSync`/
   `closeSync` called in order, `fsOps.readFile` not called, bytes equal. Fails: no arm.
2. **GREEN** — `readRegularFileSync` + the two arms.
3. **RED** — the fallback rows (non-regular with close, above gate, at gate, growth, shrink,
   throw-then-close). **GREEN** — guard branches.
4. **RED** — `readSlice` sync (called with `(fd, buf, 0, length, offset)`), `length > gate` →
   async, non-regular → async. **GREEN**.
5. **RED** — handle arms (read-mode sync via `handle.fd`, write-mode async, raw error surfaced
   unchanged). **GREEN** — `wrapNodeHandle(handle, syncIo)`.
6. **RED** — async `read` view vs copy rows; the FIFO integration file. **GREEN**.
7. **REFACTOR** — `readRegularFileSync` under 20 lines (extract the fill loop and the EOF
   check).
8. **Probe** — scratch: 10 000 × `readUtf8` of a 25-byte file and 10 000 × held-handle
   `read(…, 12, 0)`, with vs without policy; expect ≈ 50 → ≈ 10 µs and ≈ 10 → ≤ 1 µs. Also
   `npm run check:size` (the Node facade limit is 60 kB gzip) — report the delta.

### Gate

```
npx vitest run test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system-rename-kinds.test.ts \
  && npx vitest run --project posix-integration test/integration/posix-only/node-fs-fifo-read.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts test/integration/posix-only/node-fs-fifo-read.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts test/integration/posix-only/node-fs-fifo-read.test.ts \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`perf(node): serve small regular-file reads and held-handle reads synchronously`

## Part 4a — The `io` option, default-on

### Context

ADR-881 (named mode), ADR-890 (one policy per repository), DC-7 (recommendation (a)). This is the
part where the fast path becomes the default, so it carries the headline bench probe and the R4
loop-delay probe.

**Edited: `src/adapters/node/sync-io-budget.ts`** — add
`export const syncIoPolicyFor = (io: 'sync-fast-path' | 'threadpool' | undefined): SyncIoPolicy | undefined`:
`undefined` or `'sync-fast-path'` → `createSyncIoPolicy()`; `'threadpool'` → `undefined`; any
other runtime value → `throw invalidOption('io', "must be 'sync-fast-path' or 'threadpool'")`
(`invalidOption` from src/domain/commands/error.ts; the `validateBareRepositories` wording in
src/repository/validate-options.ts is the pattern). Test rows in
`test/unit/adapters/node/sync-io-budget.test.ts`: each accepted operand, and one row per refused
operand (another string, `true`, `1`), asserting `data.code === 'INVALID_OPTION'` and the
option/reason data.

**Edited: `src/index.node.ts`**

- `OpenNodeRepositoryOptions` (line 51) gains a documented
  `readonly io?: 'sync-fast-path' | 'threadpool';` (doc: default `'sync-fast-path'`; pick
  `'threadpool'` on network or cold filesystems).
- `openRepository` (63): right after `validateOptions(opts)`,
  `const syncIo = syncIoPolicyFor(opts.io);` — one policy for the whole repository.
- `nodeLayoutProbe` (172-188, a const) → `createNodeLayoutProbe(syncIo: SyncIoPolicy | undefined): LayoutProbe`.
  Without a policy: today's body verbatim. With one: `stat` → `statSync(p, { throwIfNoEntry: false })`
  inside `runWithinBudget`, every other error still collapsed to `undefined` exactly as today's
  `.catch(() => undefined)`; `readUtf8` → `readRegularFileSync(ops, p, gate)` decoded, falling
  back to today's `readFile` when it returns `undefined` (non-regular or large), errors collapsed;
  `readLink` → `readlinkSync(p, 'utf8')` collapsed; `isOwnedByCaller`'s `ownerUid` stat likewise.
- `canonicalize` (197-203) → `createCanonicalize(syncIo)`: with a policy
  `ops.realpathSync.native(p)` inside `runWithinBudget`; the catch-all → `{ path: p, canonical: false }`
  is unchanged. `canonicalizeCeilings`, the trusted-directories canonicalising function and
  `resolveNodeLayout` take the created function/probe as parameters (no module-level state).
  `nodeLayoutCapabilities.realWorkTreePath` stays async (not in the R3 set).
- Both `NodeFileSystem` constructions pass `syncIo` in the options object (main adapter line
  108; `makeWorktreeFs` 144-149 — the worktree adapters share the repository's policy).
- The strip destructure (153-162) gains `io: _g`.

**Edited: `src/adapters/node/node-adapter.ts`** — `NodeAdapterOptions` (line ~27) gains the same
documented `io` field; `createNodeContext` line 76 →
`new NodeFileSystem(workDir, { syncIo: syncIoPolicyFor(options.io) })`.

**Created: `test/unit/index.node-io-strategy.test.ts`** — mocks
src/adapters/node/sync-io-budget.ts with
`vi.mock(path, async (importOriginal) => { const actual = await importOriginal(); return { ...actual, createSyncIoPolicy: vi.fn(() => ({ ...actual.createSyncIoPolicy(), ops: spyOps })) }; })`
where `spyOps` wraps each `realSyncFsOps` member in a pass-through `vi.fn`. Rows (real temp repo
built like test/unit/index.node.test.ts `makeGitDir`): `io` absent → `createSyncIoPolicy` called
exactly once per `openRepository`, and a `revParse('HEAD')` reaches `spyOps.lstatSync` or
`spyOps.openSync`; `io: 'sync-fast-path'` → same; `io: 'threadpool'` → `createSyncIoPolicy` not
called and no `spyOps` member called; invalid `io` → `INVALID_OPTION` before any fs call;
`createNodeContext({ workDir, io: 'threadpool' })` → not called; default → called once.

Read-only: test/unit/index.node.test.ts (fixture helpers to copy), src/repository/validate-options.ts
(untouched under DC-7 (a); under (b) it replaces sync-io-budget's validation and gains
`validateIo` + rows in test/unit/repository/validate-options.test.ts).

### TDD steps

1. **RED** — `syncIoPolicyFor` rows (accepted operands, three refused operands). Fails:
   missing export. **GREEN**.
2. **RED** — the new wiring test file's `threadpool` and default rows. Fails: no `io` option,
   no policy created. **GREEN** — option fields, `syncIo` threading through `openRepository`,
   `createNodeContext`, both constructions.
3. **RED** — sync layout probe: a unit row per probe member through the mocked ops (policy
   present → sync member used; absent → not); FIFO-safety: `readUtf8` of a FIFO path in the
   probe is only reached behind find-layout's `isFile` gate (existing behaviour; add a row that
   the sync probe hands a non-regular file to the async fallback). **GREEN** —
   `createNodeLayoutProbe`, `createCanonicalize`.
4. **REFACTOR** — keep `openRepository` under 20 lines of new logic (extract
   `buildNodeAdapters(roots, canonical, syncIo, layout)` if it grows).
5. **Probe** — (i) `npm run bench:ab -- main HEAD 3`, rows: `rev-parse.bench` HEAD,
   `cat-file.bench`, `loose-read.bench` both rows, `status.bench`; report both sides; expect
   `revParse` ≈ 2× faster. (ii) Trace shim on `revParse('HEAD')` warm (adapt probe.mjs) with
   `IO=threadpool` → exactly main's 9 calls in the same order; default → no `fs.promises` call
   except the held-handle `open`, every other operation as `*Sync` calls (a small read is
   `openSync · fstatSync · readSync · readSync · closeSync`); list them. (iii) R4: scratch script with
   `perf_hooks.monitorEventLoopDelay({ resolution: 1 })` around 5 × `status()` on `medium-v3`,
   both modes; report max and p99. Target: default-mode max ≤ 2 ms (budget + 1 ms). If missed,
   escalate with both modes' numbers — do not retune the ADR-880 constants.

### Gate

```
npx vitest run test/unit/adapters/node/sync-io-budget.test.ts test/unit/index.node-io-strategy.test.ts test/unit/index.node.test.ts test/unit/adapters/node/node-adapter.test.ts test/unit/repository \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/adapters/node/sync-io-budget.ts src/index.node.ts src/adapters/node/node-adapter.ts test/unit/adapters/node/sync-io-budget.test.ts test/unit/index.node-io-strategy.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/adapters/node/sync-io-budget.ts src/index.node.ts src/adapters/node/node-adapter.ts test/unit/index.node-io-strategy.test.ts \
  && npm run test:integration \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`feat(node): add the io option and serve cheap serial reads synchronously by default`

## Part 4b — Batched open probes and the derivable realpath

### Context

Design D8, DC-3 recommendation (a). Targets critical-path depth on `io: 'threadpool'` (network
filesystems); call count must stay equal or fall: 13 → 12 on a normal repository. Every decision
keeps today's order and answer.

**Edited: `src/repository/find-layout.ts`**

- `findLayout` (102-147): the .git candidate arm (line ~117) calls a new
  `layoutForDiscoveredGitDir(probe, candidate, pathPolicy, commonDirOverride)`; the bare-directory
  arm (line ~138, every climbed level) keeps calling `layoutFor` serially (DC-3).
- `layoutForDiscoveredGitDir` starts, without awaiting, `probe.readLink?.(HEAD)`,
  `probe.stat(HEAD)`, and — only when `commonDirOverride === undefined` —
  `probe.stat(<gitDir>/commondir)`, `probe.stat(<gitDir>/objects)`, `probe.stat(<gitDir>/refs)`.
  Each speculative promise goes through a small `speculate(promise)` helper that turns a
  rejection into a value (`{ ok: false, error }`), so an unneeded speculative probe never leaves
  a handler-less rejection; when the decision **does** need it, the original error is rethrown.
  It then evaluates in today's order: link text (`isRefsLinkText`) → `stat(HEAD).isFile` →
  `readUtf8(HEAD)` (serial, after the file check — FIFO safety) → `resolveCommonDir` (reusing the
  speculative `commondir` stat: pass the settled stat into a variant of `resolveCommonDir` —
  `resolveCommonDirFrom(stat, …)` — so the exported `resolveCommonDir` keeps its signature) →
  shared dirs: when the resolved common dir **equals** `gitDir`, use the speculative
  `objects`/`refs` stats; otherwise stat them under the common dir as today (two wasted stats on
  linked worktrees only).
- `hasValidHead` (373-397), `resolveCommonDir` (308-360), `sharedDirsValid` (399-408) keep
  their behaviour; extract their decision logic into pure helpers over settled results so both
  the serial and the batched path share it.

**Edited: `src/repository/trust-verdict.ts`** — `evaluateTrust` (79-93): start
`probe.isOwnedByCaller(path)` for every `checkedPathsOf(…)` path at once (through the same
speculate shape — put `speculate` in a tiny shared module only if both files need it; otherwise
local), then walk the results **in iteration order** and report the first foreign path — the
verdict is identical; a rejection is rethrown only if reached in order.

**Edited: `src/index.node.ts`** — the probe's `stat` becomes lstat-first: `lstat(p)`; only when
it reports a symbolic link, `stat(p)` (same answer: `stat` follows exactly the links `lstat`
reports). `createNodeLayoutProbe` returns `{ probe, isPlainDirectory(path): boolean }`, where
`isPlainDirectory` answers from a per-open `Map` of lstat verdicts (a directory that is not a
link). The ports LayoutProbe shape (src/ports/layout-probe.ts) is **not** changed — the record
is node-internal. `resolveNodeLayout`: skip `canonicalize(resolved.gitDir)` and use
`{ path: resolved.gitDir, canonical: true }` when all hold: `cwdCanonical`; `resolved.workDir`
is defined and `isDerivedFromCanonicalCwd(resolved.workDir, cwd)`;
`resolved.gitDir === nodePath.join(resolved.workDir, '.git')`; `isPlainDirectory(resolved.gitDir)`.
Otherwise today's realpath. (Proof, for the doc comment: an ancestor of a realpath is real, and a
non-link child of a real directory is real.)

**Edited tests:** `test/unit/repository/find-layout.test.ts` (rows: a `HEAD` symlink with
refs/ text wins even when `stat(HEAD)` rejects — the rejection is not surfaced; the content
read never runs on a non-file `HEAD`; commondir-present path stats `objects`/`refs` under the
common dir and ignores the speculative ones; commondir-absent path issues exactly five probe
calls before `readUtf8` and no more; a climbed non-repository level issues exactly today's calls —
use a recording fake LayoutProbe); `test/unit/repository/trust-verdict.test.ts` (two foreign
paths → the first in order is reported; a rejection after an earlier foreign path is not
surfaced); `test/unit/index.node.test.ts` (a symlinked .git directory → `layout.gitDir` is the
canonical target; a plain .git → `<canonical cwd>/.git`; the lstat-first probe on a symlinked
.git still resolves the repository).

Read-only: src/repository/resolve-layout.ts (`evaluateTrust` caller, line 224), src/ports/layout-probe.ts.

### TDD steps

1. **RED** — find-layout batching rows with a recording, delay-controlled fake probe (assert the
   five calls are issued before any settles; assert decision order). Fails: serial today.
2. **GREEN** — `layoutForDiscoveredGitDir`, `speculate`, the extracted pure deciders.
3. **RED** — trust-verdict order rows. **GREEN** — batched `evaluateTrust`.
4. **RED** — index.node rows (symlinked .git keeps realpath; plain .git skips it — the value
   is identical, so the skip itself is asserted through the trace probe, and the "never skip"
   mutant is provably equivalent: realpath returns the same string by the proof above).
   **GREEN** — lstat-first probe, `isPlainDirectory`, the skip condition (one row per operand of
   the four-way condition that flips the outcome).
5. **REFACTOR** — every function under 20 lines.
6. **Probe** — trace shim on `openRepository` only (both `IO` values): 13 → 12 calls; with
   `IO=threadpool` also record serial depth (count consecutive awaited hops; expect 8 → 3 inside
   layout discovery). `npm run bench:ab -- main HEAD 3` row `loose-read.bench` "reads a blob"
   (fresh open per call).

### Gate

```
npx vitest run test/unit/repository test/unit/index.node.test.ts test/unit/index.node-io-strategy.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/repository/find-layout.ts src/repository/trust-verdict.ts src/index.node.ts test/unit/repository/find-layout.test.ts test/unit/repository/trust-verdict.test.ts test/unit/index.node.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/repository/find-layout.ts src/repository/trust-verdict.ts src/index.node.ts test/unit/repository/find-layout.test.ts test/unit/repository/trust-verdict.test.ts \
  && npm run test:integration
```

### Commit

`perf(repository): batch the open-time layout probes and skip the derivable gitdir realpath`

## Part 5a — Optional `tryLstat` / `tryReadUtf8` on the port, Node and memory

### Context

ADR-884 (ADR-873 shape). Each resolves `undefined` exactly where its throwing twin refuses
`FILE_NOT_FOUND` and behaves identically otherwise. Browser arms land in Part 10a (same file as
its riders). Probe: sync-arm miss cost.

**Edited: `src/ports/file-system.ts`** — after `lexists` (line 127), with the same doc style:
`readonly tryLstat?: (path: string) => Promise<FileStat | undefined>;` and
`readonly tryReadUtf8?: (path: string) => Promise<string | undefined>;` (OPTIONAL; absence
changes cost, never the answer; a caller without it calls the twin and reads
`FILE_NOT_FOUND` as absence).

**Edited: `src/adapters/node/node-file-system.ts`** — `tryLstat`: sync →
`lstatSync(real, { bigint: true, throwIfNoEntry: false })` → `undefined` or `mapStat`; async →
`fsOps.lstat` with Part 3a's shared catch helper (`ENOENT` → `undefined` before `mapErrno`, so no
`TsgitError` is constructed). `tryReadUtf8`: sync → `readRegularFileSync` path of `readUtf8`
with `ENOENT` from `openSync` answered `undefined` (catch `ENOENT` before mapping); async →
`fsOps.readFile(real, 'utf-8')` with the shared catch. Both `resolveRead` first.

**Edited: `src/adapters/memory/memory-file-system.ts`** — `tryLstat` reuses `lstat`'s
resolution (`walk(path, 'no-follow')`, line 181-194) and returns `undefined` on its not-found arm
instead of constructing the refusal; `tryReadUtf8` reuses `read`'s resolution (line ~95-110,
`absentFileRefusal`) likewise — a directory still refuses `PERMISSION_DENIED`. Every other
refusal (segment `NOT_A_DIRECTORY`, loop `PERMISSION_DENIED`) is unchanged.

**Edited: `src/repository/wrap-fs-validator.ts`** — `guardedTryLstat` / `guardedTryReadUtf8`
following `guardedLexists` (lines 39-56): absent on the adapter → absent on the wrapper; present →
`readGuard(p)` then `method.call(fs, p)`. Spread them where `guardedLexists` is spread.

**Edited: `test/unit/ports/file-system.contract.ts`** — module helpers `tryLstat(fs, p)` /
`tryReadUtf8(fs, p)` throwing "the adapter under contract provides no …" when absent (the
`lexists` helper at line 176 is the pattern). Rows, each asserting `tryX(p)` equals "`X(p)`,
with `FILE_NOT_FOUND` read as `undefined`": absent path; present file; dangling link (under the same host gating the contract already applies to its symlink
rows); `ENOTDIR` ancestor (under the
existing `segmentRefusals: 'pinned'` gate); permission-denied (posix-only, skipped as root). The
contract already runs for memory and for Node in both modes.

**Edited: `test/unit/repository/wrap-fs-validator.test.ts`** — present → forwarded, guarded (an
escaping path refuses before the adapter is called) and invoked with the adapter as receiver;
absent → the key is absent on the wrapper (`'tryLstat' in sut === false`). Same for
`tryReadUtf8`.

Read-only: test/unit/adapters/node/node-file-system-injected.test.ts and node-fs-fakes.ts (the
sync-arm branches are covered by the dual-mode contract; the shared catch helper's branches by
Part 3a's rows).

### TDD steps

1. **RED** — contract rows for `tryLstat`. Fails for memory and Node: method absent.
2. **GREEN** — port member, memory arm, Node arms.
3. **RED** — contract rows for `tryReadUtf8` (add: a directory refuses `PERMISSION_DENIED` as
   `readUtf8` does). **GREEN**.
4. **RED** — wrap-fs-validator rows. **GREEN** — the two guarded forwarders.
5. **REFACTOR** — Node arms share one "sync or async, fold `ENOENT`" tail; no arm over 20 lines.
6. **Probe** — scratch: 10 000 × `tryLstat` of a missing path vs `lstat` + catch, policy-bearing
   Node adapter; expect ≈ 1.1 µs vs ≈ 3.4 µs.

### Gate

```
npx vitest run test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/memory/memory-file-system.test.ts test/unit/repository/wrap-fs-validator.test.ts test/unit/repository/wrap-fs-validator.properties.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/ports/file-system.ts src/adapters/node/node-file-system.ts src/adapters/memory/memory-file-system.ts src/repository/wrap-fs-validator.ts test/unit/ports/file-system.contract.ts test/unit/repository/wrap-fs-validator.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/ports/file-system.ts src/adapters/node/node-file-system.ts src/adapters/memory/memory-file-system.ts src/repository/wrap-fs-validator.ts test/unit/ports/file-system.contract.ts \
  && npx vitest run --project posix-integration \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`feat(ports): add optional non-throwing lstat and utf8 read probes to the file system port`

## Part 5b — Hot callers answer expected misses without a refusal

### Context

ADR-884 callers. DC-2 recommendation (a): read-sparse-checkout.ts stays on its catch.

**Created: `src/application/primitives/internal/fs-probes.ts`** —
`export const lstatIfPresent = async (fs: FileSystem, path: string): Promise<FileStat | undefined>`
and `export const readUtf8IfPresent = async (fs: FileSystem, path: string): Promise<string | undefined>`:
the optional method when present (invoked on `fs` as receiver: `fs.tryLstat?.(path)` keeps
`this`); otherwise the throwing twin with `errorDataCode(err) === 'FILE_NOT_FOUND'` →
`undefined`, anything else rethrown.

**Created: `test/unit/application/primitives/internal/fs-probes.test.ts`** — each helper: method
present → used and twin not called; method absent → twin called, `FILE_NOT_FOUND` →
`undefined`, `NOT_A_DIRECTORY` rethrown (asserted on `.data.code`), a plain object
`{ data: { code: 'FILE_NOT_FOUND' } }` rejection also folds (cross-graph shape).

**Edited callers:**

- `src/application/primitives/internal/read-capped-file.ts` `loadCappedUtf8` (the
  `ctx.fs.lstat` try/catch with `err instanceof TsgitError`) → `lstatIfPresent(ctx.fs, path)`;
  the `instanceof` disappears; the `TsgitError` import stays only if still used.
- `src/application/primitives/config-scoped-read.ts` `readScopeFile` (line 129-146) →
  `readUtf8IfPresent`, `undefined` → `[]`; the remaining `PERMISSION_DENIED` → `[]` fold stays,
  now classified with `errorDataCode`. `scopeFileMtimeKey`'s `stat` miss (the per-command miss
  for an absent global/system scope) is **not** covered — there is no `tryStat`, and `tryLstat`
  would not follow a symlinked dotfile. Record it in the hand-off report for the PR.
- `src/application/primitives/internal/shallow-set.ts` `loadStateUncached` (lines 48-60, the
  per-session shallow read) → `readUtf8IfPresent`; `undefined` → `EMPTY_SHALLOW_STATE`; the
  `isAbsentShallowFile` catch stays for `NOT_A_DIRECTORY`. (The design named shallow-file.ts;
  its `readShallow` has one cold caller and stays as is — the per-command reader is this one.)

**Created: `test/unit/application/primitives/internal/read-capped-file.test.ts`** — the probe as
a unit: a memory-adapter context (test/unit/application/primitives/fixtures.ts builders), 200
absent .gitignore paths through `loadCappedUtf8` with `ctx.fs.lstat` wrapped in a counter →
0 `lstat` calls (was 200 refusals); plus the existing contract of the function (absent,
symlink, non-file, over limit → `tooLarge`, present → text) since it had no direct suite.

Read-only suites that must stay green: test/unit/application/primitives/config-scoped-read.test.ts,
config-scoped-read-untrusted.test.ts, internal/shallow-set.test.ts, shallow-file.test.ts, and the
gitignore/gitattributes suites that reach `loadCappedUtf8`.

### TDD steps

1. **RED** — fs-probes rows. Fails: module missing. **GREEN**.
2. **RED** — read-capped-file suite including the 200 → 0 counter row. Fails: today 200 `lstat`
   calls. **GREEN** — convert `loadCappedUtf8`.
3. **GREEN** — convert `readScopeFile` and `loadStateUncached`. No new rows: their existing
   suites run on the memory adapter, which provides `tryReadUtf8` since Part 5a, so the
   converted arm is exercised there (absent scope file → `[]`, absent shallow file → empty
   state), and the fallback arm is covered in `fs-probes.test.ts`. Run those suites under
   Stryker scope for the two functions; a survivor means a missing row in the existing suite —
   add it there only if the part stays at six edited files, otherwise escalate.
4. **GREEN** — `npm run test:unit` for every other caller of the three functions.
5. **REFACTOR** — no `instanceof TsgitError` left in the touched functions.
6. **Probe** — `npm run bench:ab -- main HEAD 3` row `status.bench`; the 200 → 0 unit count
   from step 2.

### Gate

```
npx vitest run test/unit/application/primitives/internal/fs-probes.test.ts test/unit/application/primitives/internal/read-capped-file.test.ts test/unit/application/primitives/config-scoped-read.test.ts test/unit/application/primitives/config-scoped-read-untrusted.test.ts test/unit/application/primitives/internal/shallow-set.test.ts test/unit/application/primitives/shallow-file.test.ts \
  && npm run test:unit \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/internal/fs-probes.ts src/application/primitives/internal/read-capped-file.ts src/application/primitives/config-scoped-read.ts src/application/primitives/internal/shallow-set.ts test/unit/application/primitives/internal/fs-probes.test.ts test/unit/application/primitives/internal/read-capped-file.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/application/primitives/internal/fs-probes.ts src/application/primitives/internal/read-capped-file.ts src/application/primitives/config-scoped-read.ts src/application/primitives/internal/shallow-set.ts
```

### Commit

`perf(primitives): answer expected file misses through the non-throwing probes`

## Part 6a — One pack-directory listing for the store gate and the scan; unreadable directory folds

### Context

Design D5 "shared listing" and ADR-887 fold. Behaviour change: a `PERMISSION_DENIED` (or any
other coded fault) on the objects/pack listing no longer propagates from `all()`/`lookup()`; it
becomes an empty listing plus one `ctx.logger?.warn` per generation. Order of reads is unchanged
here (Part 6b swaps it).

**Edited: `src/application/primitives/pack-registry.ts`**

- New per-registry memo `packDirListing = createPromiseMemo(listPackDir)` created in
  `createPackRegistry` (line 633) before `createStoreGate`. `listPackDir`:
  `ctx.fs.readdir(packsDir(commonGitDir(ctx)))`; on rejection, if `errorDataCode(error)` is
  defined → warn once (`ctx.logger?.warn?.('packRegistry: unreadable pack directory', { dir, ...faultContext(data) })`
  — `faultContext` is already imported here) and resolve `[]`; an error **without** a data code
  (a programming error) is rethrown, never folded. Since the memo resolves once per generation,
  "once per generation" is structural.
- `isMissingPackDir` (601-604) is deleted (the fold subsumes it); its doc comment about
  `errorDataCode` moves to `listPackDir`.
- `createStoreGate(ctx)` (612-624) → `createStoreGate(ctx, listing: () => Promise<ReadonlyArray<DirEntry>>)`;
  `loadStoreGate` awaits the listing and calls
  `loadMidxSet(ctx, packsDir(…), new Set(entries.map((e) => e.name)))`.
- `scanPacks` (651-719): replace the `ctx.fs.readdir(dir).catch(…)` arm of the `Promise.all`
  with `packDirListing.get()`; rewrite the long comment above it (the "PERMISSION_DENIED …
  propagates" paragraph is now false).
- `refresh()` (914-942) clears `packDirListing` together with `storeGate.clear()`.

**Edited: `src/application/primitives/internal/midx-source.ts`** — `loadMidxSet(ctx, packsDir, listing?: ReadonlySet<string>)`
(line 343). `probeFlat(ctx, path, listing?)` (133): listing present and lacking
`multi-pack-index` → `{ kind: 'absent' }` with no I/O; any entry of that name (file, symlink,
directory) → today's `stat` path verbatim. `readChainManifest` (245) is reached through
`loadChain`: listing present and lacking `multi-pack-index.d` → `{ kind: 'none' }` with no I/O;
otherwise today's path. Listing absent (the ~38 direct test calls) → today's behaviour unchanged.

**Edited tests:**

- `test/unit/application/primitives/pack-registry.test.ts`: the existing row at line ~272
  ("readdir rejects with PERMISSION_DENIED … Then it rejects with PERMISSION_DENIED") flips to
  the fold. New describe `PackRegistry — pack directory listing`: one `readdir` of the pack
  directory shared by the gate and the scan (use `instrumentedContext` from
  test/unit/application/primitives/fixtures.ts; count `readdir` calls on the pack dir = 1 across
  `assertLoadable` + `lookup`); no midx `stat` when the listing has no midx entry; a
  `multi-pack-index` entry → one `stat`; each fault (`FILE_NOT_FOUND`, `NOT_A_DIRECTORY`,
  `PERMISSION_DENIED`, an unmapped `UNSUPPORTED_OPERATION`) → empty listing and exactly one
  `logger.warn` call carrying the code, even across two lookups; no logger → resolves (no
  throw); an code-less `TypeError` from `readdir` → rethrown; after `refresh()` the listing is
  re-read.
- `test/unit/application/primitives/internal/midx-source.test.ts`: listing rows (absent names →
  zero fs calls; flat entry present → stat; chain directory entry present → manifest path; both
  absent → `{ set: undefined, faults: [] }`).
- `test/integration/midx-interop.test.ts`: a row where `multi-pack-index` is a **symlink** to a
  valid midx written by git (`git multi-pack-index write`, then move it and link it) — tsgit reads
  the object through the midx exactly as git's `cat-file -p` does (design D5 row D4).

Read-only: src/ports/file-system.ts (`DirEntry`), src/application/primitives/internal/pack-generation.ts
(`emptyGeneration`).

### TDD steps

1. **RED** — shared-listing count row (today: 2 midx stats + 1 readdir). **GREEN** — memo,
   gate parameter, `loadMidxSet` listing parameter.
2. **RED** — midx-source listing rows. **GREEN** — `probeFlat` / chain short-circuits.
3. **RED** — fault fold rows (four codes, once-per-generation warn, no logger, code-less
   rethrow, refresh re-read); flip the line-272 row. **GREEN** — `listPackDir`.
4. **RED → GREEN** — the symlinked-midx interop row (passes if the stat path is kept verbatim;
   write it first to prove the listing did not short-circuit a symlink).
5. **REFACTOR** — comments in `scanPacks` rewritten to the new truth.
6. **Probe** — trace shim on `loose-only-v3` (read one loose blob, `BLOB` = its `firstBlobId`):
   `stat midx · stat chain · readdir fanout` → `readdir pack · readdir fanout` (2 → 2 calls on
   the read path; the stats are gone). `npm run bench:ab -- main HEAD 3` rows `midx-lookup.bench`
   "loose object with no packs" and "cold open reads one loose blob" — must not regress beyond
   noise.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/internal/midx-source.test.ts \
  && npx vitest run --project integration test/integration/midx-interop.test.ts \
  && npm run test:unit \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts src/application/primitives/internal/midx-source.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/internal/midx-source.test.ts test/integration/midx-interop.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/application/primitives/pack-registry.ts src/application/primitives/internal/midx-source.ts test/integration/midx-interop.test.ts \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`perf(pack)!: share one pack-directory listing and fold an unreadable pack directory`

## Part 6b — Pack-first buffered reads, pinned against git; prefix-scan rider

### Context

Design D5 (pinned matrix O1–O3, P1–P3, D1–D4), ADR-887. Faithfulness-positive: the buffered
resolver answers from the pack first, as git 2.55.0 does for info and buffered reads; the
streaming path (`openBlobSource`) keeps loose-first, as git's `stream_blob_to_fd` does.

**Edited: `src/application/primitives/object-resolver.ts`** —
`resolveObjectContentWithDepth` (lines 68-131): order becomes gate (`assertLoadable`) → empty
tree → `deltaCache` → `registry.lookup(id)` → hit: `resolvePackChainWithDepth` (unchanged) →
miss: `tryLoose` (unchanged body, lines 252-276) → miss: `objectNotFound(id)`. Extract the loose
arm into `resolveLooseArm(ctx, id, maxBytes, verifyHash)` so the function stays short. Keep every
`checkAborted` at its equivalent position.

**Edited: `src/application/primitives/internal/loose-oid-cache.ts`** — module doc line 7
("loose-first precedence is unaffected") becomes the new split: buffered reads consult packs
first, streamed blob reads and `hasObject`'s fallback use this cache as their loose arm. Export
`isMissingFanoutDir` (line 22) for the prefix rider.

**Edited: `src/application/primitives/resolve-oid-prefix.ts`** — `scanLoose` (37-50): drop the
`ctx.fs.exists(dir)` pre-probe; `readdir` rejection with `isMissingFanoutDir(error)` → `[]`,
anything else rethrown. `oidPrefixPattern` / `looseNamePattern` (26-31) become module-level
constants built once per hash width (two widths: 40 and 64 hex) — e.g. two `Map`s keyed by
`hexLength`, filled at module load.

**Created: `test/integration/object-precedence-interop.test.ts`** — per design D5 protocol: `hello\n`
committed, `git gc` (0 loose), then plant loose objects at the same oid with `node:zlib`
`deflateSync`. Rows, each comparing tsgit's structured answer with git's for the same command
class: O1 impostor blob `blob 7\0LOOSE!\n` → `readBlob` / `readObject` (buffered) return
`hello\n` (git `cat-file -s` = 6, `diff`, `grep`, `archive` serve the pack), while `streamBlob`
returns `LOOSE!\n` (git `cat-file -p <blob>` streams loose); O2 commit impostor at HEAD →
`readCommit` returns the packed commit (git `log -1 --format=%s` = `c1`); O3 tree impostor →
`readTree` returns original entries; P1 garbage loose + packed → buffered read serves the pack
without error (git: error line, then `hello`, exit 0); P2 garbage loose, not packed → record
tsgit's refusal code and compare only the exit class (git exits 128 with "Not a valid object
name"; tsgit must refuse — if its code is not `OBJECT_NOT_FOUND`, record it as a pre-existing
divergence in the hand-off report, do not change it here); P1 on the **streamed** path
(`streamBlob` of the garbage-loose packed blob): git's streaming reader tries loose, prints an
error and serves the pack; record whether `openBlobSource` does the same — if it refuses, it is a
pre-existing divergence to record, not to fix here; P3 size-lying `blob 99\0hello\n` → buffered
read `hello\n`, `readObjectMetadata` size 6; posix-only and skipped when
`process.getuid?.() === 0`: D1 loose-only repo with `chmod 000 objects/pack` → loose object
served; D2 packed blob with the same chmod → `OBJECT_NOT_FOUND` (git "Not a valid object
name", exit 128), loose blob served; D3 objects/pack a regular file → loose served. Restore
permissions in `afterAll`. Explicit 60 s `beforeAll` timeout. No `vi.*`.

**Edited: `test/unit/application/primitives/object-resolver.test.ts`** — new describe: a packed
hit never lists the loose fanout (instrumentedContext: no `readdir` of objects/xx); a pack miss
falls to loose; a corrupt loose copy of a packed object is never read (no `read` of its path).

**Edited: `test/unit/application/primitives/resolve-oid-prefix.test.ts`** — missing fanout dir
→ no `exists` call, `[]`; a fanout path that is a file (`NOT_A_DIRECTORY`) → `[]`; a
`PERMISSION_DENIED` readdir → rethrown; both hash widths resolve prefixes.

Read-only: src/application/primitives/internal/blob-source.ts (`openBlobSource` — must stay
loose-first; do not edit), test/integration/interop-helpers.ts, test/integration/pack-fixture-helpers.ts.

### TDD steps

1. **RED** — object-resolver rows (packed hit → no fanout readdir). Fails: loose-first today.
2. **GREEN** — swap, `resolveLooseArm` extraction.
3. **RED** — the interop file (O1 buffered/streamed, O2, O3, P1, P3 fail or pass as listed;
   O1-buffered and P1/P3 fail today). **GREEN** — already green after step 2; fix only test
   plumbing. D1–D3 rows depend on Part 6a's fold.
4. **RED** — prefix-scan rows (no `exists` call). **GREEN** — `scanLoose` rewrite, export
   `isMissingFanoutDir`, module-constant patterns.
5. **REFACTOR** — loose-oid-cache doc; `npm run test:unit` for any suite that pinned a
   loose-first call sequence (none found at plan time — fix by updating the expected sequence,
   never by restoring the order).
6. **Probe** — trace shim on `single-pack-v3` open + one blob: post-open 16 → 13 (loose
   `readdir objects/60` and the two midx stats gone). `npm run bench:ab -- main HEAD 3` rows
   `pack-read.bench` cold rows and `midx-lookup.bench` "cold open reads one blob with/without
   midx".

### Gate

```
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/primitives/loose-oid-cache.test.ts \
  && npx vitest run --project integration test/integration/object-precedence-interop.test.ts \
  && npm run test:unit \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/internal/loose-oid-cache.ts src/application/primitives/resolve-oid-prefix.ts test/integration/object-precedence-interop.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/resolve-oid-prefix.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/application/primitives/object-resolver.ts src/application/primitives/internal/loose-oid-cache.ts src/application/primitives/resolve-oid-prefix.ts test/integration/object-precedence-interop.test.ts \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`fix(object-read)!: consult packs before loose objects on buffered reads, as git does`

## Part 7 — Held-handle header and size; lazy `.idx`

### Context

Design D6. The `.pack` is opened once (header and size ride the held handle); without a midx, a
lookup loads `.idx` files one pack at a time in candidate order. Same pack serves the same oid.

**Edited: `src/application/primitives/pack-registry.ts`** — inside `loadPack` (381-560):

- `headerMemo` (450-459): `parsePackHeader(await readSlice(0, PACK_HEADER_SIZE))` — the pack's
  own `readSlice` (held handle; browser falls back through the existing `UNSUPPORTED_OPERATION`
  arm to `ctx.fs.readSlice`). `readSlice` is declared below `headerMemo` today — hoist its
  declaration (and `handleMemo`, `inFlight`, `retired`) above.
- New local `sizeMemo = createPromiseMemo(packSize)` (not a `RegisteredPack` interface member):
  `(await handleMemo.get()).stat()` → `size`; on `UNSUPPORTED_OPERATION` (the `isUnsupportedOperation`
  predicate, line 73) clear `handleMemo` and fall back to `(await ctx.fs.stat(packPath)).size`;
  when `retired`, path stat. `buildOffsetTable` (461-477) uses `await sizeMemo.get()`.
- `lookupViaIndexedSnapshot` (806-819) and `lookupViaUnclaimedPacks` (844-861) collapse into
  one `lookupLazily(generation, id, isClaimed: (pack) => boolean)` walking `generation.packs` in
  candidate order through `unclaimedIndexOrSkip` (825-842; same `generation.warnedIdx`); no midx
  → `isClaimed = () => false`; with a midx → `(pack) => midx.claimedNames.has(`${pack.name}.idx`)`.
  First hit that passes `probeHeader` wins. `lookupViaIdxScan` (863-871) calls it.

**Edited: `src/application/primitives/internal/pack-generation.ts`** — `resolveIndexes(ctx, packs)`
(115-134) → `resolveIndexes(ctx, packs, warnedIdx: Set<string>)`: load through
`boundedMapFor(ctx.concurrency.ioBound)` (src/application/primitives/internal/concurrency.ts line
53; check its exact signature there), then walk results **in candidate order** to build
`packs`/`indexFaults` and warn — skipping names already in `warnedIdx` and adding the ones it
warns (without this, a pack a lazy lookup already warned would warn twice per generation — R9).
Each pack's `indexMemo` is reused, so a pack a lookup loaded costs nothing. The caller in
`scanPacks` (`indexed: createPromiseMemo(() => resolveIndexes(ctx, packs, warnedIdx))`) shares
the generation's set (create the set before the memo).

**Edited: `test/unit/application/primitives/pack-registry.test.ts`** — new describes:
`RegisteredPack.header — held handle` (after one `readSlice`, `header()` issues no path
`readSlice` and no second `openWithNoFollow`; browser-shaped fallback — `openWithNoFollow`
rejecting `UNSUPPORTED_OPERATION` — still reads header by path); `RegisteredPack.offsetTable —
size through the handle` (no `ctx.fs.stat(packPath)` when a handle exists; fallback stats by
path); `PackRegistry.lookup — lazy index loading without a multi-pack-index` (3 packs, hit in
the first → exactly one `.idx` read; corrupt first `.idx` → one warn, hit from the second; a
later `health()` warns nothing new for that `.idx`); `resolveIndexes — ordered parallel load`
(injected per-pack delays reversing completion order → `packs` order and warn order equal
candidate order). The existing lazy-loading describe at line ~867 is the fixture pattern
(`writeSyntheticPack`, `buildSeededContext`, `writeGarbageIdx`).

### TDD steps

1. **RED** — header via held handle. **GREEN** — hoist and reroute `headerMemo`.
2. **RED** — size via fstat + fallback rows. **GREEN** — `sizeMemo`.
3. **RED** — lazy lookup rows (1 `.idx` read for a first-pack hit). Fails: `resolveIndexes`
   forces all three. **GREEN** — `lookupLazily`.
4. **RED** — ordered parallel `resolveIndexes` + once-per-generation warn across lookup and
   `health()`. **GREEN**.
5. **REFACTOR** — delete the two old lookup functions; every function under 20 lines.
6. **Probe** — trace shim: `single-pack-v3` post-open 13 → ≤ 12 (R8: one `.pack` open, no path
   `stat`); `many-pack-no-midx-v3` cold open + one blob: exactly one `.idx` read (R9; was 49
   `readFile` + 53 `stat`). `npm run bench:ab -- main HEAD 3` rows `midx-lookup.bench` "first
   pack with no midx" and "cold open reads one blob with no midx" (design: 11.7 → ~2.6 ms).

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts \
  && npm run test:unit \
  && npx vitest run --project integration test/integration/midx-interop.test.ts test/integration/object-precedence-interop.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts src/application/primitives/internal/pack-generation.ts test/unit/application/primitives/pack-registry.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/application/primitives/pack-registry.ts src/application/primitives/internal/pack-generation.ts \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`perf(pack): read header and size through the held handle and load pack indexes lazily`

## Part 8a — Refuse malformed `core.packedGitWindowSize` / `core.packedGitLimit` at the eager tier

### Context

ADR-882 (eager tier, `git_default_core_config`), ADR-773 grammar. Today tsgit ignores both keys
and so accepts values git refuses on **every** command. Pinned (git 2.55.0, `git config --file`
in a throwaway):

| value | both keys |
|---|---|
| `0`, `1`, `1k`, `4g`, `9223372036854775807` | accepted |
| `abc`, `-1`, `''`, valueless | `fatal: bad numeric config value '<v>' for '<key>' in file .git/config: invalid unit`, `<key>` all-lowercase |
| `18446744073709551616` | `…: out of range` |

git dies on the **first** malformed entry in file order (its config callback), so one finder
scanning both keys in file order yields the lowest line directly.

**Edited: `src/application/primitives/config-read.ts`**

- Lenient read: `ParsedConfig.core` (lines ~60-76) gains documented
  `readonly packedGitWindowSize?: number;` and `readonly packedGitLimit?: number;` (absent when
  unset or malformed), applied in the `[core]` key dispatch next to
  `DELTA_BASE_CACHE_LIMIT_KEY` (lines ~1312, ~1382) through `checkPackWindowMemoryBound` exactly
  as `applyDeltaBaseCacheLimitEntry` (1321-1327) does; key constants
  `PACKED_GIT_WINDOW_SIZE_KEY` and `PACKED_GIT_LIMIT_KEY`, each holding its key name in lower case.
- Eager finder `findFirstInvalidPackedGitBound(ctx): Promise<(InvalidNumericEntry & { readonly line: number }) | undefined>`
  — walk `readConfigEntry(ctx)` tokens like `findLastInvalidDeltaBaseCacheLimit` (1152-1172) but
  return the **first** failing entry of either key: `key: \`core.${lowered}\``, `source`,
  `value: token.value ?? ''`, `reason` from `checkPackWindowMemoryBound`,
  `line: token.startLine + 1` (the `findFirstValuelessEntry` convention, line ~690). Not
  barrelled.

**Edited: `src/application/primitives/internal/repo-state.ts`** — `EagerCandidate` (145-148)
gains `{ readonly kind: 'numeric'; readonly line: number; readonly entry: InvalidNumericEntry }`;
`throwEagerCandidate` (150-164) maps it to
`configBadNumericValue(entry.key, entry.source, entry.value, entry.reason)`;
`assertEagerConfigValid` (195-220) runs the finder as a **sixth** member of its `Promise.all`
and adds the candidate to the `pickLowerLine` reduction.

**Edited tests:** `test/unit/application/primitives/config-read.test.ts` (lenient values: each
accepted operand parsed, each malformed → absent; finder: first-in-file-order across the two
keys, valueless → `''` / `invalid unit`, `-1` → `invalid unit`, `18446744073709551616` →
`out of range`, line numbers); `test/unit/application/primitives/internal/repo-state.test.ts`
(a malformed key refuses `CONFIG_BAD_NUMERIC_VALUE` with key/source/value/reason data;
lowest-line ordering against a malformed `core.compression` placed earlier and one placed later
— two rows).

**Created: `test/integration/packed-git-window-config-interop.test.ts`** — for each pinned value
and key: run git (`cat-file -p HEAD`, `rev-parse HEAD`, `status`) and tsgit's matching command
(`catFile`/`revParse`/`status` through `createNodeContext`); accepted values → both succeed;
malformed → git exits 128 and tsgit refuses `CONFIG_BAD_NUMERIC_VALUE`; rebuild git's line
`fatal: bad numeric config value '<value>' for '<key>' in file .git/config: <reason>` from the
error `data` and compare with git's stderr. test/integration/max-tree-depth-config-interop.test.ts
is the template (its reconstruction of `source` → .git/config). No `vi.*`.

Read-only: src/domain/commands/error.ts (`configBadNumericValue`, line 639).

### TDD steps

1. **RED** — config-read lenient rows. **GREEN** — dispatch entries.
2. **RED** — finder rows. **GREEN** — `findFirstInvalidPackedGitBound`.
3. **RED** — repo-state eager rows (refusal + two ordering rows). **GREEN** — sixth candidate.
4. **RED → GREEN** — the interop file (red until step 3 lands; write it first).
5. **REFACTOR** — the finder shares the token walk with `findLastInvalidDeltaBaseCacheLimit`
   only if both stay under 20 lines; otherwise keep them separate.
6. **Probe** — `npm run bench:ab -- main HEAD 3` row `rev-parse.bench` HEAD: the sixth finder
   walks the already-cached token list; must not regress beyond noise.

### Gate

```
npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-read.properties.test.ts test/unit/application/primitives/internal/repo-state.test.ts test/unit/application/commands/internal/repo-state.test.ts \
  && npx vitest run --project integration test/integration/packed-git-window-config-interop.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/internal/repo-state.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/internal/repo-state.test.ts test/integration/packed-git-window-config-interop.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/application/primitives/config-read.ts src/application/primitives/internal/repo-state.ts test/integration/packed-git-window-config-interop.test.ts
```

### Commit

`fix(config)!: refuse malformed core.packedGitWindowSize and core.packedGitLimit`

## Part 8b — Pack window cache

### Context

Design D7 (git's `use_pack`), ADR-882: 64 KiB windows, 16 MiB registry-wide limit, LRU across
packs, keys only lower the defaults. The window default is confirmed or replaced by this part's
probe on the spread row before merge.

**Created: `src/application/primitives/internal/pack-window-cache.ts`**

- `export const DEFAULT_PACK_WINDOW_BYTES = 64 * 1024;`,
  `export const DEFAULT_PACK_WINDOW_LIMIT_BYTES = 16 * 1024 * 1024;`, `PAGE_BYTES = 4096`.
- `export const packWindowBudgetFor = async (ctx: Context): Promise<{ windowBytes: number; limitBytes: number }>`
  — `min(default, (await readConfig(ctx)).core?.packedGitWindowSize ?? default)`, same for the
  limit (the `deltaBaseCacheBudgetFor` shape in
  src/application/primitives/internal/resolve-delta-base-cache-limit.ts). git rounds the window
  to a multiple of two pages; that rounding is not observable in data and is not replicated.
- `export const createPackWindowCache = ({ windowBytes, limitBytes }) => ({ read, clear })` over
  one `createLruCache<Uint8Array>(limitBytes)` (src/domain/storage/lru-cache.ts;
  `set(key, value, byteSize)`), key `${packName}:${base}`.
  `read(packName, offset, length, load: (base: number, size: number) => Promise<Uint8Array>)`:
  - `length > windowBytes` or `limitBytes < windowBytes` → `load(offset, length)` (bypass, today's
    shape);
  - window `base = floor(offset / W) × W`; if `[offset, offset + length)` fits → cached window
    or one `load(base, W)`; the loaded window is clamped by `load` at file end;
  - crossing a window edge → `base = floor(offset / PAGE) × PAGE`; if it still does not contain
    the request, bypass;
  - return `window.subarray(offset − base, offset − base + length)` — a **view**; a window
    shorter than requested (file end) returns the short view, like today's `bytesRead` view.
  - `clear()` empties the LRU.

**Edited: `src/application/primitives/pack-registry.ts`** — `createPackRegistry` builds one cache
from `await packWindowBudgetFor(ctx)` next to `deltaBaseCache` (line ~643) and passes it to
`loadPack`; `RegisteredPack.readSlice` (lines ~495-520) serves through `cache.read(name, offset,
length, loadWindow)` where `loadWindow(base, size)` reads `min(size, packSize − base)` bytes
through the held handle (`sizeMemo` from Part 7) into a fresh `Uint8Array` — this removes the
per-call `new Uint8Array(length)` zero-fill; the retired and `UNSUPPORTED_OPERATION` fallbacks
stay per-call `ctx.fs.readSlice` (uncached). `refresh()` and `dispose()` call `cache.clear()`
exactly where `deltaBaseCache.clear()` is called (a replaced pack may reuse its name).

**Retention audit (read-only; record the verdict in the hand-off report):** the three consumers of
`RegisteredPack.readSlice` — src/application/primitives/object-resolver.ts
`readEntryHeaderWithChunk` (~line 666, feeds `parsePackEntryHeader` and inflate),
src/application/commands/internal/fsck/object-cache.ts (~line 224, header parse), and
`headerMemo` — must neither write into the returned bytes nor keep them past the call. Any
consumer that retains must copy. If the compiler accepts `Promise<Readonly<Uint8Array>>` on
`RegisteredPack.readSlice` without touching consumers, apply it; otherwise leave the type.

**Created: `test/unit/application/primitives/internal/pack-window-cache.test.ts`** — contained
request → view, no second load; crossing request → one page-aligned load; `length > W` →
bypass; `limit < W` → bypass; LRU eviction across two packs at the limit; `clear()` empties;
`packWindowBudgetFor`: key below default lowers it, key above is clamped, key equal to default,
absent → default (one row each, both keys).

**Created: `test/unit/application/primitives/internal/pack-window-cache.properties.test.ts`** —
over a generated byte array and arbitrary `(offset, length)` inside it: `read` returns the same
bytes as `bytes.subarray(offset, offset + length)` for arbitrary window/limit pairs
(`numRuns` per .claude/workflow/property-testing.md budget).

**Edited: `test/unit/application/primitives/pack-registry.test.ts`** — a delta chain read counts
handle reads (wrap `openWithNoFollow`'s handle `read` in a counter): ≤ ⌈span / W⌉ + 1; after
`refresh()` a rewritten pack of the same name never serves stale bytes; `dispose()` clears.

### TDD steps

1. **RED** — cache unit rows. Fails: module missing. **GREEN** — `createPackWindowCache`.
2. **RED** — budget rows. **GREEN** — `packWindowBudgetFor`.
3. **RED** — property file. **GREEN** (should pass; fix the crossing arithmetic if not).
4. **RED** — registry rows (read count, stale-after-refresh, dispose). **GREEN** — wire the cache
   into `loadPack` / `refresh` / `dispose`.
5. **REFACTOR** — retention audit; optional `Readonly` return type.
6. **Probe** — `npm run bench:ab -- main HEAD 3` rows `delta-chain-read.bench` cold / warm /
   8-tips, `pack-read.bench` "spread across a cold large pack" (the sentinel: a random-access
   read must not pay a full window per object — if it regresses beyond noise, measure 16 KiB and
   32 KiB windows and escalate with the numbers; ADR-882 lets the probe replace 64 KiB),
   `log.bench`; run the spread and delta rows with `io: 'threadpool'` too (edit the bench's open
   options locally, do not commit). Trace shim: 43-deep `delta-chain-v3` leaf 44 `FH.read` → ≤ 4;
   `single-pack-v3` post-open ≤ 11. `npm run check:size`.

### Gate

```
npx vitest run test/unit/application/primitives/internal/pack-window-cache.test.ts test/unit/application/primitives/internal/pack-window-cache.properties.test.ts test/unit/application/primitives/pack-registry.test.ts \
  && npm run test:unit \
  && npx vitest run --project integration test/integration/object-precedence-interop.test.ts test/integration/midx-interop.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/internal/pack-window-cache.ts src/application/primitives/pack-registry.ts test/unit/application/primitives/internal/pack-window-cache.test.ts test/unit/application/primitives/internal/pack-window-cache.properties.test.ts test/unit/application/primitives/pack-registry.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/application/primitives/internal/pack-window-cache.ts src/application/primitives/pack-registry.ts test/unit/application/primitives/internal/pack-window-cache.test.ts \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`perf(pack): cache pack windows under a registry-wide byte limit`

## Part 9a — Application-layer riders: limiter cursor, buffered blob caching, `hasObject`

### Context

Design D9 rows 1–2 and the D5 `hasObject` rider. Behaviour-neutral.

**Edited: `src/application/primitives/internal/concurrency-limiter.ts`** —
`createConcurrencyLimiter(limit)`: `queue.shift()` in `release()` → a `head` index; compact
(`queue.splice(0, head); head = 0`) once `head > QUEUE_COMPACTION_MIN && head > queue.length / 2`
with `QUEUE_COMPACTION_MIN = 1024`. Direct slot hand-off semantics (the comment above `release`)
unchanged.

**Edited: `test/unit/application/primitives/internal/concurrency-limiter.test.ts`** — a
fast-check property in this file: for arbitrary task counts and interleaved completion orders,
release (start) order equals admit order and in-flight never exceeds `limit`; a row crossing the
compaction threshold (2 × 1024 + 1 queued tasks) keeps FIFO.

**Edited: `src/application/primitives/internal/blob-source.ts`** — buffered arms `resolveLoose`
(line 235, the `fitsBuffer` branch) and `resolvePackBase` (274, the buffered branch): when the
object's declared size equals `content.byteLength`, set `ctx.deltaCache` to `{ type, content }`
under `id`, mirroring `resolveObjectContentWithDepth`'s `cacheEntry` rule (in object-resolver.ts;
reuse that helper if exported, otherwise export it as internal). For the loose arm the declared
size comes from the parsed loose header of `inflated`; a size-lying header is never cached.

**Edited: `test/unit/application/primitives/internal/blob-source.test.ts`** — buffered loose →
cached; buffered pack base → cached; size-lying loose header → not cached; streamed arms → not
cached.

**Edited: `src/application/primitives/has-object.ts`** — the loose fallback
`ctx.fs.exists(looseObjectPath(…))` → `probeLooseOid(ctx, id)` (src/application/primitives/internal/loose-oid-cache.ts,
line 49); pack-first order unchanged.

**Edited: `test/unit/application/primitives/has-object.test.ts`** — a loose-only object is found
with no `exists` call (instrumentedContext); two probes in one fanout issue one `readdir`.

### TDD steps

1. **RED** — limiter property + compaction-threshold row (both pass today — they pin FIFO
   through the rewrite and kill compaction-boundary mutants after it). **GREEN** — head cursor +
   compaction; both stay green.
2. **RED** — blob-source caching rows. **GREEN**.
3. **RED** — `hasObject` rows. **GREEN**.
4. **REFACTOR** — named constant, functions under 20 lines.
5. **Probe** — scratch: 40 000 tasks through `createConcurrencyLimiter(8)`, total ms before/after
   (design: 498 → ~21 ms). `npm run bench:ab -- main HEAD 3` row `diff-whitespace.bench`.

### Gate

```
npx vitest run test/unit/application/primitives/internal/concurrency-limiter.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/has-object.test.ts \
  && npm run test:unit \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/internal/concurrency-limiter.ts src/application/primitives/internal/blob-source.ts src/application/primitives/has-object.ts test/unit/application/primitives/internal/concurrency-limiter.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/has-object.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/application/primitives/internal/concurrency-limiter.ts src/application/primitives/internal/blob-source.ts src/application/primitives/has-object.ts
```

### Commit

`perf(primitives): drain the limiter by cursor, cache buffered blob reads, probe loose by listing`

## Part 9b — Adapter-layer riders: adler32, inflate pre-sizing, compressor views

### Context

Design D9 rows 3–5, ADR-889. Bit-identical outputs.

**Edited: `src/adapters/adler32.ts`** — `adler32(data)`: indexed `for` over blocks of
`NMAX = 5552` bytes, accumulating `a`/`b` without modulo inside a block and reducing
`% ADLER_MOD` once per block; same `((b << 16) | a) >>> 0` result.

**Created: `test/unit/adapters/adler32.properties.test.ts`** — against a reference one-byte
loop written in the test (today's algorithm): equality over arbitrary byte arrays, plus lengths
spanning NMAX boundaries (`5551, 5552, 5553, 2 × 5552 + 1`) of all-`0xff` bytes (the
worst case for the deferred sums). test/unit/adapters/adler32.test.ts stays as is.

**Edited: `src/adapters/inflate.ts`** — `GrowableBuffer` (line 280): constructor takes an
initial capacity: `new GrowableBuffer(maxBytes)` starts at
`maxBytes < MAX_INFLATED_OUTPUT_BYTES ? Math.min(maxBytes, INITIAL_CAPACITY_CEILING) : INITIAL_BUFFER_CAPACITY`
(`INITIAL_BUFFER_CAPACITY = 64` today, line 38; add `INITIAL_CAPACITY_CEILING = 1 << 20`). A cap
below the global maximum is the caller's declared entry size on pack paths (memory and browser
compressors pass `boundedInflateCap(maxOutputBytes)`, which is the global maximum when no size
was declared — src/adapters/memory/memory-compressor.ts line 50,
src/adapters/browser/browser-compressor.ts line 64, both read-only).

**Edited: `test/unit/adapters/inflate.test.ts`** — an exact-size member inflated with
`maxOutputBytes = its length` grows zero times (observe through output identity: add an internal
growth counter only if no observable exists — prefer asserting output equality plus a large
member where the pre-size is below the ceiling); no cap → unchanged behaviour. The inflate
property suite stays green unchanged.

**Edited: `src/adapters/node/node-compressor.ts`** — `inflate` (line 168):
`new Uint8Array(inflateSync(…))` copies; return a view over the Buffer when
`out.byteOffset === 0 && out.byteLength === out.buffer.byteLength`, copy otherwise.
`createInflateStream` (line ~277 `controller?.enqueue(new Uint8Array(chunk))`): same rule
(zlib's ≤ 16 KiB chunks alias its `_outBuffer` and must be copied). `streamInflate` (line ~196)
is **not** touched (backlog 31.6 owns it).

**Edited: `test/unit/adapters/node/node-compressor.test.ts`** — two ≤ 16 KiB members inflated
back to back through `createInflateStream`: the first output is not overwritten; a large
`inflate` output shares its `ArrayBuffer` with no copy (byteOffset 0, exact fit).

### TDD steps

1. **RED** — adler32 property file (passes against today's code — it is the pin); then change
   the loop. **GREEN** — deferred modulo; property still green.
2. **RED** — GrowableBuffer pre-size row. **GREEN**.
3. **RED** — compressor alias row (the second member must not clobber the first) and the view
   row. **GREEN**.
4. **REFACTOR** — named constants.
5. **Probe** — `npm run bench:ab -- main HEAD 3` rows `adapter-inflate.bench` bundled rows; a
   scratch micro-bench of `adler32` over 64 MiB (design: 111 → ~1177 MiB/s).

### Gate

```
npx vitest run test/unit/adapters/adler32.test.ts test/unit/adapters/adler32.properties.test.ts test/unit/adapters/inflate.test.ts test/unit/adapters/inflate.properties.test.ts test/unit/adapters/node/node-compressor.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/adapters/adler32.ts src/adapters/inflate.ts src/adapters/node/node-compressor.ts test/unit/adapters/adler32.properties.test.ts test/unit/adapters/inflate.test.ts test/unit/adapters/node/node-compressor.test.ts \
  && npm run check:spelling && npx cspell --no-progress src/adapters/adler32.ts src/adapters/inflate.ts src/adapters/node/node-compressor.ts test/unit/adapters/adler32.properties.test.ts \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`perf(adapters): defer the adler32 modulo, pre-size inflate output, return zlib views`

## Part 10a — Browser: `tryX` arms, directory-handle cache, hash service

### Context

ADR-884 (browser arms), ADR-888 (no `createSyncAccessHandle`), design D9 rows 6–7.

**Edited: `src/adapters/browser/browser-file-system.ts`**

- `tryLstat(path)` / `tryReadUtf8(path)`: the existing `stat` (line 100, OPFS has no symlinks;
  `lstat` delegates to it at 112) and `readUtf8` (37) resolution, answering `undefined` where
  they refuse `FILE_NOT_FOUND` (classify with `errorDataCode`), every other refusal unchanged.
- Directory-handle LRU: `walkToParent(segments, create, path)` (line 299) caches the resolved
  `FileSystemDirectoryHandle` per parent path in a `createLruCache<FileSystemDirectoryHandle>`
  (the `parentRealpathCache` shape in src/adapters/node/node-file-system.ts line 506: bytes +
  entries capped; charge each entry its key length). Only successful walks are cached;
  `create: true` walks populate it too. Invalidate on `rm` (174), `rename` (186) and
  `rmRecursive` (219) of the path **or any ancestor** (drop every cached key equal to the path or
  prefixed by `path + '/'`, and for `rename` both source and destination).

**Edited: `test/unit/adapters/browser/browser-file-system.test.ts`** — `tryX` equivalence rows
(absent, present, a file used as a directory → `NOT_A_DIRECTORY`, a directory for
`tryReadUtf8` → as `readUtf8` refuses); cache rows with the existing fake handle tree
(`getDirectoryHandle` `vi.fn` spies at ~line 204): second read under one parent walks zero
directory handles; after `rm` / `rename` / `rmRecursive` of an ancestor the walk runs again.

**Edited: `src/adapters/browser/browser-hash-service.ts`** — `toHex` (line 64): 256-entry
module-level hex table; the streaming hasher's `finalize` (line ~36) concatenates the chunks
once into a buffer preallocated from the running total (today: two copies).

**Edited: `test/unit/adapters/browser/browser-adapter.test.ts`** — hex output of all 256 byte
values equals `byte.toString(16).padStart(2, '0')`; streamed digest of three chunks equals the
one-shot digest (SubtleCrypto is available in the Node test runtime).

**Edited: `test/browser/opfs-roundtrip.spec.ts`** — a Playwright row reading a depth-10 delta
chain from OPFS that counts `getFile()` calls (wrap `FileSystemFileHandle.prototype.getFile` in
the page); record the count before/after in the hand-off report (chromium + firefox locally).

### TDD steps

1. **RED** — browser `tryX` rows. **GREEN**.
2. **RED** — handle-cache rows (zero walks on the second read). **GREEN** — LRU in
   `walkToParent`.
3. **RED** — invalidation rows (`rm`, `rename` both sides, `rmRecursive`, ancestor prefix).
   **GREEN**.
4. **RED** — hex table and single-copy rows. **GREEN**.
5. **REFACTOR** — functions under 20 lines; named cache caps.
6. **Probe** — write the Playwright row **first** (before step 1) and run it to capture the
   before numbers; after step 5 run it again. Record `getFile()` and `getDirectoryHandle()`
   counts and wall time for the depth-10 chain (the window cache from Part 8b already cut the
   `getFile()` count; this part cuts the directory walks). `npm run test:e2e` runs chromium +
   firefox locally (WebKit per the existing Playwright note). Never create a second worktree or
   switch branches for a before/after.

### Gate

```
npx vitest run test/unit/adapters/browser \
  && npm run test:e2e \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/adapters/browser/browser-file-system.ts src/adapters/browser/browser-hash-service.ts test/unit/adapters/browser/browser-file-system.test.ts test/unit/adapters/browser/browser-adapter.test.ts test/browser/opfs-roundtrip.spec.ts \
  && npm run check:spelling && npx cspell --no-progress src/adapters/browser/browser-file-system.ts src/adapters/browser/browser-hash-service.ts test/browser/opfs-roundtrip.spec.ts \
  && npm run test:parity:workers && npm run test:parity:deno && npm run test:parity:bun
```

### Commit

`perf(browser): add the non-throwing probes, cache directory handles, hash with one copy`

## Part 10b — Profile workloads and the perf baseline

### Context

ADR-892. Tooling-only (no `src/` delta). Runs after every `src/` part so the baseline reflects
the final state.

**Edited: `tooling/profile-registry.ts`** — new `open` workload (`kind: 'read'`,
`fixture: MEDIUM_FIXTURE`, `perIterationRepo: true`, `run` does nothing beyond the harness's own
open/dispose — read tooling/profile.ts for how `perIterationRepo` opens and disposes, and size
`iterations` so ticks clear the floor, with the measured ticks in a comment like its siblings);
`pack-read` (line 163) stops re-opening per iteration (`perIterationRepo` removed) so it profiles
the packed read on an already-open repository — re-measure its `iterations` against the tick
floor and update the comment.

**Edited: `tooling/test/unit/profile-registry.test.ts`** — `open` is present and `kind: 'read'`;
`pack-read` has no `perIterationRepo`; `resolveWorkloads('open')` returns exactly that entry.

**Edited: `docs/perf/baseline.json`, `docs/perf/baseline.md`** — regenerated by `npm run profile`
(all workloads; writes both files through tooling/profile-baseline.ts). The `pack-read` series
breaks (it measured opens before); say so in the hand-off report for the PR body.

### TDD steps

1. **RED** — registry test rows. Fails: no `open` entry. **GREEN** — the two registry edits.
2. **REFACTOR** — iteration comments carry measured ticks.
3. **Probe** — `npm run profile open` and `npm run profile pack-read`: both clear the tick floor;
   then `npm run profile` to regenerate the baseline; report the `open` and `pack-read` top
   frames.

### Gate

```
npx vitest run tooling/test/unit/profile-registry.test.ts \
  && npm run check:types && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check tooling/profile-registry.ts tooling/test/unit/profile-registry.test.ts \
  && npm run check:spelling && npx cspell --no-progress tooling/profile-registry.ts docs/perf/baseline.md
```

### Commit

`chore(tooling): add an open profile workload and profile pack-read on an open repository`

## Part 11 — Upgrade note, `io` documentation, API report

### Context

Docs-only (DC-6 (a)); last part. Covers every public change of Parts 1, 4a, 5a and 8a and the
behaviour changes of 6a, 6b and 8a (R13).

**Edited: `docs/get-started/upgrade-to-v5.md`** — under `## Adapters`: the `NodeFileSystem`
constructor before/after (`new NodeFileSystem(root, policy, fsOps)` →
`new NodeFileSystem(root, { pathPolicy: policy, fsOps })`; a bare `new NodeFileSystem(root)` is
unchanged) and the new optional `tryLstat` / `tryReadUtf8` port members (a custom adapter may
omit them). Under `## Object reads`: buffered reads consult packs first (an impostor or corrupt
loose copy of a packed object is no longer served or fatal on `readObject`/`readBlob`/tree and
commit reads; `streamBlob` still reads loose first, as git streams); an unreadable
objects/pack now reads as empty with a logger warning (loose objects served, packed ones
`OBJECT_NOT_FOUND`) instead of refusing `PERMISSION_DENIED`. Under `## Config`: malformed
`core.packedGitWindowSize` / `core.packedGitLimit` now refuse every command with
`CONFIG_BAD_NUMERIC_VALUE`, as git does.

**Edited: `docs/get-started/node.md`** — a section after `## Cache budgets` describing
`io: 'sync-fast-path'` (default: cheap serial file operations served synchronously under a
1 ms-per-turn budget, reads up to 64 KiB) and `io: 'threadpool'` (every operation through the
libuv pool; pick it on network or cold filesystems where a synchronous call can take
milliseconds), with an `openRepository({ io: 'threadpool' })` example and the same field on
`createNodeContext`.

**Edited: `docs/understand/performance.md`** — the I/O strategy: why cheap serial calls go
synchronous (a pool hop costs ~10 µs against ~1 µs), the per-repository budget and what it
bounds (one budget per repository, so the stall is 1 ms × concurrently active repositories),
bulk reads staying pooled, pack-first reads, lazy `.idx`, pack windows and the two git keys that
can only lower them. Numbers come from the hand-off reports of Parts 4a, 6b, 7 and 8b (use recorded
local numbers; label them as such).

**Edited: `reports/api.json`** — regenerated with `npm run docs:json`; commit the whole diff.

### TDD steps

1. **RED** — `npm run docs:json && git diff --no-ext-diff --stat -- reports/api.json` shows a
   stale report (the Part 1/4a/5a/8a surface). **GREEN** — commit the regenerated file.
2. **GREEN** — write the three docs (no code blocks with options that steer rendered output;
   examples use structured fields only).
3. **REFACTOR** — `npm run check:doc-links` and `npm run check:doc-coverage` clean.
4. **Probe** — none (docs); confirm `npm run docs:json` is idempotent (a second run leaves
   `git status` clean for reports/api.json).

### Gate

```
npm run docs:json \
  && npm run check:doc-links && npm run check:doc-coverage \
  && npm run check:spelling && npx cspell --no-progress docs/get-started/upgrade-to-v5.md docs/get-started/node.md docs/understand/performance.md \
  && npm run validate
```

After the commit: `npm run docs:json && git diff --no-ext-diff --exit-code -- reports/api.json`
must be clean (the committed report is current). `npm run validate` here is the phase gate.

### Commit

`docs(node): document the io modes, the options object and the v5 read-path changes`
