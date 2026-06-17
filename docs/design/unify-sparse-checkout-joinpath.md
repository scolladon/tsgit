# Design — a dedicated module owns the one working-tree-write `joinPath`

> Brief: 24.9p (ADR-340) consolidated the working-tree-write path join into ONE shared, trailing-slash-collapsing
> `joinPath` in `primitives/internal/write-working-tree-file.ts`. `commands/internal/apply-sparse-checkout.ts` still
> keeps its OWN private workdir-join helper that DELIBERATELY tolerates a doubled separator (no collapse), and the same
> shared file inlines a fourth non-collapsing copy in `removeWorkingTreeFile`. Reach the "exactly ONE `joinPath`" north
> star — after confirming the collapse difference is harmless for sparse-checkout.
> Status: draft → self-reviewed ×3 → ADR conversation done → **revised against ADR-357** → ready for the planner.
> Decision: ADR-357 chose to **extract** the helper into its own dedicated module and **fold the fourth copy now** (see
> Decision candidates — D1/D2 DECIDED).
> Scope: behaviour-preserving internal refactor — no new git surface, no public-API change, no on-disk-state change.

## Context

`applySparseCheckout` (`src/application/commands/internal/apply-sparse-checkout.ts`) re-shapes the working tree to a
`SparseMatcher`. To probe each entry's on-disk presence it joins the entry's index-relative path onto the workdir
with a **private** helper (doc-comment L54-58, helper L59):

```
const joinPath = (workdir: string, rel: FilePath): string => `${workdir}/${rel}`;   // NON-collapsing
```

Its comment claims the doubled `//` (when `workdir` ends with `/`) is "harmless — node and memory FS both normalise
`//`". The output (`absPath`) is consumed at three sites, all pure FS reads:

- L84-86 — `ctx.fs.exists(absPath)` then `isWorkingTreeDirty(ctx, absPath, entry.id)` (partition step);
- L140 — `ctx.fs.exists(joinPath(workdir, entry.path))` (changeset-build step).

24.9p (ADR-340) created the canonical join in `primitives/internal/write-working-tree-file.ts` (L35):

```
export const joinPath = (workDir: string, path: FilePath): string =>
  workDir.endsWith('/') ? `${workDir}${path}` : `${workDir}/${path}`;            // COLLAPSING
```

This shared helper has **exactly one external importer**: `apply-changeset.ts` imports it cross-file (L29; used L93,
L157). `find_referencing_symbols` on `joinPath` confirms the full reference set — the two in-file callers
(`writeWorkingTreeFile` L65, `writeWorkingTreeEntry` L82) plus `apply-changeset.ts` — and **no barrel/index re-export**
(`internal/` has no `index.ts`; siblings import each other directly). So today there are **two** workdir-join variants
for the working-tree-write surface — the shared collapsing one and the sparse non-collapsing copy — plus a **third
inline non-collapsing copy** in the same shared file: `removeWorkingTreeFile` (L95-98, inline join at L96) bypasses the
helper with bare `` `${ctx.layout.workDir}/${path}` ``.

> **Pre-chewed-context correction (recorded per the verify-independently mandate).** The brief framed the shared
> `joinPath` as living in `apply-changeset.ts`. It does NOT: 24.9p/ADR-340 already **moved** it into
> `write-working-tree-file.ts:35`, and `apply-changeset.ts` now merely *imports* it from there. The "third copy" this
> item unifies is the sparse one; the inline one inside `removeWorkingTreeFile` is effectively a **fourth** copy in
> the same file (see D2). Three other `joinPath` definitions exist in the tree — `walk-submodules.ts:106`,
> `walk-working-tree.ts:108`, `mv.ts:327` — but they join **path segments into a repo-relative `FilePath`** (tree-walk
> prefixing), NOT a workdir onto a relative path producing an absolute disk path. They are a **different** join with
> different semantics and types and are explicitly OUT OF SCOPE of the "one working-tree-write `joinPath`" north star.

### Constraints that bind this change

- **ADR-226 (git-faithfulness prime directive):** replicate git's observable behaviour byte-for-byte. This is a
  behaviour-preserving refactor — no new git behaviour to pin. The faithfulness obligation is the **inverse**: prove
  the change is observationally byte-identical (no SHA / ref / reflog / state-file / refusal / structured-output
  change, no working-tree path difference), so the existing sparse-checkout + interop suites remain the regression
  authority. The harmlessness proof below discharges it.
- **ADR-249 (structured data only):** unaffected — no rendering, no display string, no public surface touched.
- **ADR-340 (one shared mode-aware writer / one join):** the north star this item closes for the sparse path.
- **Hexagonal dependency rule:** `commands → primitives` is legal. `apply-sparse-checkout` (commands/internal)
  already imports from `primitives/` (`apply-changeset`, `read-index`), and several `commands/internal` peers already
  import from `primitives/internal/` (`repo-state.ts`, `index-update.ts`, `build-ignore-evaluator.ts`). Importing the
  shared `joinPath` from the new `primitives/internal/join-working-tree-path.ts` is therefore legal with precedent —
  the same `commands/internal → primitives/internal` direction it already crosses for `index-update.ts`.
- **CLAUDE.md coding style:** DRY, small single-purpose functions, no duplicated logic in touched code; "many small
  files > few large files". The change collapses three duplicate definitions to one and gives the single survivor a
  self-naming home file; it adds no surface.

## The harmlessness proof (the precondition the brief mandates)

The brief blocks the unification on confirming the collapse difference is **harmless for sparse-checkout pathspec
matching**. Two independent arguments, each pinned to source with file:line, plus an empirical adapter check.

### Argument 1 — the `SparseMatcher` structurally never sees the joined path

Pathspec matching runs on the **index-relative** `FilePath`, never on the joined absolute path. The matcher type is
`SparseMatcher = (path: FilePath) => boolean` (`src/domain/sparse/sparse-pattern.ts:32`). In
`apply-sparse-checkout.ts` it is invoked only via:

- `isIncluded(opts.matcher, entry.path)` at L80 (partition loop), where `isIncluded` (L61-62) calls
  `matcher(path)` — argument is **`entry.path`**, the index-relative path.

The `joinPath` output (`absPath`) is consumed only by `ctx.fs.exists` / `isWorkingTreeDirty` (L84-86) and a second
`ctx.fs.exists` (L140) — **all pure filesystem existence/dirty probes**, never the matcher. Therefore changing how
the workdir join collapses cannot alter any inclusion/exclusion verdict: pathspec matching is **structurally
decoupled** from the join. This is the crux the precondition demands, and it holds by construction.

### Argument 2 — `//` and `/` resolve to the same file under every adapter (empirically pinned)

Even at the FS-probe sites, `workdir//rel` and `workdir/rel` resolve to the **same** path under every adapter:

- **Memory FS** — every op routes through `resolve()` → `normalizePath()`
  (`src/adapters/memory/memory-file-system.ts:383, 504`). `normalizePath` splits on `/` and **skips empty segments**
  (L508-509: `if (segment === '' || segment === '.') continue;`), so `a//b` and `a/b` yield the identical segment
  array → identical resolved path.
- **Node FS** — `exists` (L451-452) routes the path through `toAbsolute(path, rootDir, policy)` → `policy.resolve(...)`
  (`src/adapters/node/node-file-system.ts:66-72, 451-452`); `node:path`'s `join`/`resolve` collapse redundant
  separators natively. Verified empirically on this machine (Node, throwaway one-liner):
  `path.join('/a/b/', 'c/d') === '/a/b/c/d'`, `path.posix.normalize('/a/b//c/d') === '/a/b/c/d'`, and
  `fs.existsSync('/etc//hosts') === true`. So a doubled slash resolves to the same file on node too.

### Argument 3 — the divergence is unreachable in practice anyway

The two helpers diverge in exactly ONE case: when `workDir` ends with `/`. No production adapter produces such a
`workDir`:

- node: `workDir = nodePath.resolve(options.workDir)` (`src/adapters/node/node-adapter.ts:40`) — `path.resolve`
  strips trailing slashes;
- memory / browser: constant `DEFAULT_WORK_DIR` / `ROOT_WORK_DIR` (`memory-adapter.ts`, `browser-adapter.ts`) — no
  trailing slash.

So today the two `joinPath` variants already produce byte-identical output for every real input, and even in the
contrived trailing-slash case (only reachable by hand-constructing a `Context`, as one existing unit test does — see
Test strategy) both adapters normalise `//` away.

### Verdict

**Harmless — the unification is safe.** Pathspec matching never sees the join (Arg 1, decisive); even the FS probes
that do are `//`-normalised by both adapters (Arg 2); and the only diverging input is unreachable in production
(Arg 3). Routing the sparse helper through the shared collapsing `joinPath` is **observationally byte-identical** —
no SHA / ref / reflog / state-file / refusal / structured-output change, no working-tree path difference. The
collapse is, if anything, *strictly more* normalised (it removes the latent `//` at the source instead of relying on
the adapter to clean it up), which is why the shared helper was written collapsing in the first place. This is a
behaviour-preserving refactor; the existing sparse-checkout unit + interop suites are the regression authority.

## Requirements

When this ships:

1. There is **exactly one** working-tree-write `joinPath` definition, and it lives in its own dedicated module
   `src/application/primitives/internal/join-working-tree-path.ts`. The three former definition/inline sites
   (`apply-sparse-checkout.ts`'s private copy, the in-file definition in `write-working-tree-file.ts`, and
   `removeWorkingTreeFile`'s inline `` `${ctx.layout.workDir}/${path}` ``) are gone; every working-tree-write join site
   — `write-working-tree-file.ts` (`writeWorkingTreeFile` / `writeWorkingTreeEntry` / `removeWorkingTreeFile`),
   `apply-changeset.ts`, and `apply-sparse-checkout.ts` — imports the shared collapsing `joinPath` from the new module.
   (The "exactly ONE working-tree-write `joinPath`" north star ADR-340 opened is closed.)
2. `write-working-tree-file.ts` does **not** re-export `joinPath` — no indirection; its sole external consumer
   (`apply-changeset.ts`) is repointed onto the new module directly. (Confirmed: `apply-changeset.ts` is the only
   external importer and no barrel re-exports it.)
3. The sparse-checkout and merge/stash behaviour is **unchanged**: same files materialised / removed / retained, same
   index skip-worktree bits, same `status` truthfulness — under cone AND non-cone, on memory AND node.
4. No public surface / option change; `api.json`, command surfaces, refusal conditions, reflogs, and ADR-249 untouched.
5. The existing sparse-checkout unit + interop suites and the helper-home + merge/stash suites stay green **unchanged**
   (they are the behaviour-preservation guard), and touched code keeps 100% line/branch coverage + 0 surviving
   mutants — including the relocated `joinPath` (Stryker mutates the new file; see Test strategy).

## Design

ADR-357 fixes the shape: the single `joinPath` moves into its **own dedicated module**, and **all four** former join
sites converge on it now (the fourth — `removeWorkingTreeFile`'s inline — folded in this change). The verbatim symbol
moves; no logic changes.

### The new module — `src/application/primitives/internal/join-working-tree-path.ts`

Holds the collapsing helper *verbatim* (the exact body moved out of `write-working-tree-file.ts:35`), plus its
doc-comment. It depends only on the `FilePath` brand:

```ts
import type { FilePath } from '../../../domain/objects/index.js';

/**
 * Join a working-tree-relative path onto the work directory, collapsing a
 * trailing slash so the result is byte-identical regardless of how `workDir`
 * is configured. The single definition shared by every working-tree-write
 * join site (the file writers/remover, changeset application, sparse-checkout).
 */
export const joinPath = (workDir: string, path: FilePath): string =>
  workDir.endsWith('/') ? `${workDir}${path}` : `${workDir}/${path}`;
```

The `FilePath` import path is `../../../domain/objects/index.js` — the same specifier `write-working-tree-file.ts`
already uses for `FilePath` (verified: `write-working-tree-file.ts:9` imports `FilePath` from there). The new file
sits beside its peers in `primitives/internal/`, which has **no** `index.ts` barrel — siblings import each other by
direct path (the established convention; `internal/` is excluded from Stryker's `!src/**/index.ts` ignore precisely
because it has none).

### `write-working-tree-file.ts` — delete the definition, import the symbol, fold the fourth copy

- **Delete** the local `joinPath` definition and its doc-comment (L30-36).
- **Add** `import { joinPath } from './join-working-tree-path.js';` (sibling, same directory).
- **Fold** `removeWorkingTreeFile` (L95-98): replace the inline `` `${ctx.layout.workDir}/${path}` `` (L96) with
  `joinPath(ctx.layout.workDir, path)` — the canonical helper its own file had been bypassing.
- The two existing in-file callers — `writeWorkingTreeFile` (L65) and `writeWorkingTreeEntry` (L82) — already call
  `joinPath(ctx.layout.workDir, …)` and are **unchanged** (they now resolve to the imported symbol).
- `write-working-tree-file.ts` does **not** re-export `joinPath` — no indirection. (Its only external `joinPath`
  consumer, `apply-changeset.ts`, is repointed below; nothing else needs it.)

### `apply-changeset.ts` — repoint the existing import

Today L29 is `import { joinPath, rmIfExists, writeWorkingTreeEntry } from './internal/write-working-tree-file.js';`.
Split it: keep `rmIfExists` / `writeWorkingTreeEntry` coming from `write-working-tree-file.js`, and import `joinPath`
from the new sibling module:

```ts
import { rmIfExists, writeWorkingTreeEntry } from './internal/write-working-tree-file.js';
import { joinPath } from './internal/join-working-tree-path.js';
```

Call sites L93/L157 (`joinPath(workdir, entry.path)`) are **unchanged**.

### `apply-sparse-checkout.ts` — delete the private copy, import the shared symbol

- **Delete** the private `joinPath` (doc-comment L54-58, helper L59).
- **Add** `import { joinPath } from '../../primitives/internal/join-working-tree-path.js';` (alongside the existing
  `../../primitives/*` imports, ~L16-18).
- Call sites L84/L140 (`joinPath(workdir, entry.path)`) are **unchanged**. Signatures match
  (`(workDir: string, path: FilePath) => string` vs the sparse copy's `(workdir, rel: FilePath)` — same shape,
  `FilePath` arg), so no call-site edit is needed.

### Net delta

| File | Change |
|---|---|
| `join-working-tree-path.ts` (NEW) | `+` the moved `joinPath` + doc-comment + one `FilePath` type-import |
| `write-working-tree-file.ts` | `−` definition + doc-comment; `+` import; fold `removeWorkingTreeFile` (one line) |
| `apply-changeset.ts` | repoint `joinPath` to the new module (split one import line into two) |
| `apply-sparse-checkout.ts` | `−` private copy + comment; `+` import |

Four files touched, no logic moves — the symbol body is byte-identical to today's shared helper. The collapsing
branch is the only behavioural difference from the two deleted non-collapsing copies, and it is provably
unreachable-or-equivalent (harmlessness proof above).

## Decision candidates

| # | Choice | Alternatives (≤3) | Outcome | Why |
|---|---|---|---|---|
| **D1 — where the unified `joinPath` lives** | The sparse path needs the one shared collapsing join; which module owns it. | **(a)** Import the existing shared `joinPath` from `primitives/internal/write-working-tree-file.ts` as-is. **(b)** Extract `joinPath` into a new dedicated module (`primitives/internal/join-working-tree-path.ts`) that every working-tree-write join site imports. **(c)** No-op — keep the private copy. | **DECIDED → (b)** (ADR-357) | The user chose extraction over import-as-is, against the prior draft's recommendation of (a). Harmlessness being proven rules out (c). The dedicated module gives the path util a self-naming home rather than cementing it as a member of a file named for working-tree *writing*; a future call site has one obvious place to import from. Cost — repointing the two existing importers' import lines — is accepted as a naming-correctness improvement (pure import churn, no logic moves). Folded into the Design above as settled. |
| **D2 — fold `removeWorkingTreeFile`'s inline 4th copy?** | `removeWorkingTreeFile` (`write-working-tree-file.ts:96`) inlines a non-collapsing `` `${ctx.layout.workDir}/${path}` `` instead of calling the shared `joinPath`. | **(a)** Fold it now (one-liner, same file, same north star, same harmlessness proof). **(b)** Leave it; record a follow-up. **(c)** Leave it, no follow-up. | **DECIDED → (a)** (ADR-357) | The user chose to fold the fourth copy in this change. Identical harmlessness argument (`removeWorkingTreeFile`'s path only reaches `rmIfExists` → `lstat`/`rm`, pure FS, never a matcher; both adapters `//`-normalise; `ctx.layout.workDir` never ends in `/`); already-covered call site (`write-working-tree-file.test.ts:357,373`). After the fold the canonical helper's own file no longer bypasses it — internally self-consistent. Folded into the Design above as settled. |
| **D4 — does the new standalone module get its own unit test?** | Extracting `joinPath` into a file with no co-located test raises a *new* question: where do its mutants get killed? | **(a)** No dedicated test — the moved `joinPath` stays covered transitively by the existing tests that already exercise both branches across the import graph: `write-working-tree-file.test.ts` (non-slash `workDir` via the writers) + `apply-sparse-checkout.test.ts:376-398` (trailing-slash). **(b)** Add a dedicated `join-working-tree-path.test.ts` asserting both branches (slash + non-slash) directly. **(c)** (a) now, add a dedicated test only if the scoped mutation gate surfaces a survivor. | **RESOLVED → (a)** (test-strategy detail; not user-facing) | This is a genuinely-new sub-question the extraction raises, but it is a test-strategy detail, so it is resolved here, not deferred. Three verified facts decide it: **(1)** the moved `joinPath` is byte-identical code — relocating a symbol does not change which tests cover it, since Stryker resolves mutants through the import graph, not file co-location. **(2)** Both branches are already exercised: `write-working-tree-file.test.ts` only ever uses the non-slash `DEFAULT_WORK_DIR = '/repo'` (kills the `endsWith==false` arm and the `${workDir}/${path}` template mutant); `apply-sparse-checkout.test.ts:392` hand-builds a trailing-slash `Context` (kills the `endsWith==true` arm and the `${workDir}${path}` template mutant). After the move these tests drive the *same* symbol through `import`. **(3)** application-layer files are outside the line-coverage denominator (coverage gates domain/adapters only), but Stryker mutates **all** `src` including the new file (`mutate: ["src/**/*.ts", "!src/**/index.ts", …]`) — so the mutants must be killed, and per (1)+(2) they are, by the two existing tests. A dedicated test would duplicate that coverage for zero new kills (DRY / "no contrived tests"). **(b)** is rejected as redundant; **(c)** is the safety net the slice gate already encodes — if the scoped mutation run shows a survivor on the new file, the plan adds the targeted test then. Net: ship with no dedicated test; the slice gate empirically confirms it. |

D1 and D2 are DECIDED by ADR-357 and folded into the design as settled. D4 is a resolved test-strategy detail (not a
user decision). No remaining load-bearing choice is left open for the user.

## Test strategy

Behaviour-preserving refactor → the **existing** suites are the regression authority; they must stay green
**unchanged** (changing them would mask a regression). **No new test file** — including for the new module (D4):

- **New module — `join-working-tree-path.ts`: no dedicated test (D4 → (a)).** The relocated `joinPath` is
  byte-identical code; its mutants are killed transitively across the import graph (Stryker resolves mutants by import,
  not co-location), and it WILL be mutated (`mutate: ["src/**/*.ts", …]` includes it). Both branches are covered:
  - `endsWith('/') === false` (and the `${workDir}/${path}` template) — by every writer test in
    `write-working-tree-file.test.ts`, which uses the non-slash `DEFAULT_WORK_DIR = '/repo'`;
  - `endsWith('/') === true` (and the `${workDir}${path}` template) — by `apply-sparse-checkout.test.ts:376-398`, which
    hand-builds a trailing-slash `Context`.
- **Unit — `test/unit/application/commands/internal/apply-sparse-checkout.test.ts`.** The full partition / changeset /
  skip-worktree / retained-dirty coverage, **including the trailing-slash `Context` test (L376-398)** — RETAIN it: it
  is the load-bearing guard for the collapse branch of the relocated `joinPath`. Deleting the private sparse helper
  removes its line from the (application-layer, non-gated) coverage view; behaviour is unchanged.
- **Helper home — `test/unit/application/primitives/internal/write-working-tree-file.test.ts`** drives the relocated
  `joinPath`'s non-slash branch via `writeWorkingTreeFile` / `writeWorkingTreeEntry`, and covers the folded
  `removeWorkingTreeFile` (L355-385: file-gone + no-op-on-absent); unchanged.
- **`apply-changeset.ts` repoint** — covered unchanged by `test/unit/application/primitives/apply-changeset.test.ts`
  (it imports the same `joinPath`, now from the new module; the import edit is invisible to its behaviour tests).
- **Integration / interop — `test/integration/sparse-checkout.test.ts` (multi-adapter parity, drives the real command
  surface through memory; final `describe.skipIf` cross-checks index + pattern file against canonical `git`),
  `sparse-checkout-file-interop.test.ts`, `sparse-reset-merge.test.ts`** guard the sparse path; the **merge / stash
  interop suites** guard the folded `removeWorkingTreeFile` (its callers are `merge.ts` / `apply-merge-to-worktree.ts`
  / `stash.ts`, all passing `ctx.layout.workDir`). If the unification changed any on-disk/index outcome, one goes red —
  the behaviour-preservation gate.

**No new interop pin** — there is no new git behaviour. The faithfulness obligation is discharged by the harmlessness
proof + the unchanged green suites, not by a fresh `git`-probe matrix (running one would be theatre: nothing in git's
observable behaviour changes).

**Property tests — DO NOT APPLY.** `joinPath` is a single-line string concat behind I/O orchestration, not a
parser / matcher / round-trip pair / counting invariant (CLAUDE.md: "I/O wrappers, command facades belong in
integration / parity tests, not property tests").

## Slicing hint for the planner

Two slices, each independently green. Slice 1 establishes the module and keeps the helper's home + `apply-changeset`
green; slice 2 repoints the sparse command. They could merge into one atomic commit, but splitting keeps each diff
single-purpose and lets the planner gate the helper-home move separately from the command repoint — recommended split.

**Slice 1 — extract the module, repoint the helper's home + `apply-changeset`, fold the fourth copy.**
- Pre-chewed context:
  - **NEW file** `src/application/primitives/internal/join-working-tree-path.ts`: export `joinPath` verbatim — body
    `workDir.endsWith('/') ? `${workDir}${path}` : `${workDir}/${path}``, signature `(workDir: string, path: FilePath): string`
    — plus its doc-comment; `import type { FilePath } from '../../../domain/objects/index.js';` (same specifier
    `write-working-tree-file.ts:9` uses).
  - Edit `src/application/primitives/internal/write-working-tree-file.ts`:
    - DELETE the local `joinPath` definition + doc-comment (**L30-36**).
    - ADD `import { joinPath } from './join-working-tree-path.js';` (sibling).
    - FOLD `removeWorkingTreeFile` (**L95-98**): replace inline `` `${ctx.layout.workDir}/${path}` `` (L96) with
      `joinPath(ctx.layout.workDir, path)`.
    - UNCHANGED (verify, do not edit): `writeWorkingTreeFile` (L65), `writeWorkingTreeEntry` (L82) call sites; do NOT
      re-export `joinPath`.
  - Edit `src/application/primitives/apply-changeset.ts`: split L29 — keep
    `import { rmIfExists, writeWorkingTreeEntry } from './internal/write-working-tree-file.js';`, ADD
    `import { joinPath } from './internal/join-working-tree-path.js';`. Call sites L93/L157 UNCHANGED.
  - Regression guard tests (run, expect green unchanged): unit
    `test/unit/application/primitives/internal/write-working-tree-file.test.ts` (writer slash/non-slash branches +
    `removeWorkingTreeFile` L355-385), `test/unit/application/primitives/apply-changeset.test.ts`; interop merge / stash
    suites (guard the folded `removeWorkingTreeFile`).
- TDD note: behaviour-preserving — RED is not a *new failing* test; the existing suites are GREEN before and after. The
  correctness gate is "all suites still green + `npm run validate` clean + 0 new mutants". The relocated `joinPath`'s
  non-slash branch is killed here by the writer tests; its slash branch is killed in slice 2 by the sparse test.
- Gate: `npm run validate` green; `npm run test:mutation` scoped to `write-working-tree-file.ts` +
  `join-working-tree-path.ts` shows 0 new survivors (the deleted non-collapsing inline *reduces* surface).

**Slice 2 — repoint the sparse command onto the shared module.**
- Pre-chewed context:
  - File: `src/application/commands/internal/apply-sparse-checkout.ts`.
  - DELETE the private `joinPath` (doc-comment **L54-58**, helper **L59**).
  - ADD `import { joinPath } from '../../primitives/internal/join-working-tree-path.js';` (alongside the existing
    `../../primitives/*` imports, ~L16-18).
  - UNCHANGED (verify, do not edit): call sites L84 `const absPath = joinPath(workdir, entry.path);` and L140
    `await ctx.fs.exists(joinPath(workdir, entry.path))`.
  - Regression guard tests: unit `test/unit/application/commands/internal/apply-sparse-checkout.test.ts` (esp. the
    trailing-slash test **L376-398**, which now guards the relocated helper's collapse branch); integration
    `test/integration/sparse-checkout.test.ts`, `sparse-checkout-file-interop.test.ts`, `sparse-reset-merge.test.ts`.
- TDD note: behaviour-preserving; the trailing-slash unit test already passes and after the edit exercises the real
  `endsWith('/') === true` branch of the *shared* helper (against the deleted non-collapsing copy it only passed via
  adapter `//`-normalisation).
- Gate: `npm run validate` green; `npm run test:mutation` scoped to `apply-sparse-checkout.ts` +
  `join-working-tree-path.ts` shows 0 new survivors (the deleted private branch *reduces* surface; the slash branch of
  the relocated helper is now killed by the trailing-slash test).

Each slice gates on the full `npm run validate`; both lean on the named existing suites as the behaviour-preservation
guard. Per D4, **no new test file** is added — if a scoped mutation run surfaces a survivor on `join-working-tree-path.ts`,
add the targeted test in that slice (the safety net, not the expectation).

## Out of scope

End-state after this change: **exactly one** working-tree-write `joinPath`, in its own named module
`primitives/internal/join-working-tree-path.ts`, imported by all four former sites; the sparse private copy and the
`removeWorkingTreeFile` inline are both deleted. Out of scope:

- **`walk-submodules.ts:106` / `walk-working-tree.ts:108` / `mv.ts:327` `joinPath` definitions** — a *different* join
  (path-segment → repo-relative `FilePath` for tree-walk prefixing), not the workdir-onto-relative absolute-path join.
  Not part of the "one working-tree-write `joinPath`" north star; untouched.
- **Any public surface / option / on-disk-state change** — none. This is a pure internal de-duplication; `api.json`,
  command surfaces, refusal conditions, reflogs, and structured output are untouched (ADR-249/226 unaffected).
- **A re-export of `joinPath` from `write-working-tree-file.ts`** — explicitly NOT done; the one external importer
  (`apply-changeset.ts`) is repointed onto the new module directly, so no indirection is introduced.
- **New empirical git pins** — not needed; no git behaviour changes (the harmlessness proof + unchanged green suites
  discharge faithfulness).

## Scope expansion (in-PR): the remaining joinPath copies

> The sections above closed the working-tree-write `joinPath` north star (family A) **for the four collapsing-join sites
> that were already named `joinPath`** — they now share `primitives/internal/join-working-tree-path.ts`. This appended
> section extends the same de-duplication, in the same PR, to **every remaining workDir-onto-relative join** in the
> application layer (the family-A sweep, ~25 sites) **and** to the three family-B path-segment copies. It is
> **user-approved** and additive: the sections above are unchanged and remain the authority for the already-landed work.
> Same constraints as the original change — behaviour-preserving internal refactor, no new git surface, no public-API
> change, no on-disk-state change. The faithfulness obligation stays the **inverse**: prove every touched site is
> observationally byte-identical.

### Two distinct join families — do not conflate them

There are **two** different "join" operations in the application layer, with different inputs, outputs and semantics.
The expansion keeps them **separately named** so they are never confused:

| Family | What it joins | Output | Fed to | Helper after this PR |
|---|---|---|---|---|
| **A — working-tree-write** | `workDir` (absolute) + a working-tree-relative path (`FilePath`, a filename, a constant, or a constructed suffix) | absolute disk path (`string`) | FS ops (`write`/`read`/`lstat`/`rename`/`exists`/`rm`/`readdir`/`mkdir`/`writeUtf8`/`readlink`) — **or** a child-`Context` workDir field (one site) | `joinPath` in `primitives/internal/join-working-tree-path.ts` (COLLAPSING; 2nd param WIDENED to `string`) |
| **B — path-segment** | a repo-relative `prefix` + a `leaf`/`name` | repo-relative `FilePath` | tree-walk / index keys / further joins (NOT FS as an absolute) | `joinPathSegment` in `primitives/internal/join-path-segment.ts` (GUARDED) |

Family A collapses a trailing `/` (so `workDir//rel` → `workDir/rel`). Family B instead **guards the empty prefix**
(`prefix === '' ? leaf : `${prefix}/${leaf}``) so a root-level entry yields `leaf`, not `/leaf`. They are genuinely
different joins; after this PR family A's helper is `joinPath`, family B's is `joinPathSegment` — a **distinct** name so
the two are never conflated at a glance.

This expansion has **two parts**:

- **Part 1 — the FULL family-A workDir-join sweep (~25 sites).** Route **every** remaining
  `` `${ctx.layout.workDir}/${…}` `` (and the two named twins `repoPath` / `workPath`) onto the unified family-A
  `joinPath`. This is **wider than the original "fold the 5th copy" framing**: the user chose the complete sweep, not
  just `repoPath`. It requires **widening `joinPath`'s signature** (2nd param `FilePath` → `string`) so filenames,
  constants (`GITMODULES_FILE`), `run-hook`'s `hooksPath`, and constructed suffixes (`${path}/.git`,
  `${dir}/.gitattributes`) pass without a cast.
- **Part 2 — the three family-B copies.** Unify the three local `joinPath` definitions (`walk-submodules.ts`,
  `walk-working-tree.ts`, `mv.ts`) into the shared `joinPathSegment` under `primitives/internal/`. (Name DECIDED — see
  D-FAMB-MODULE.)

### Part 1 — the full family-A workDir-join sweep (~25 sites)

The family-A sweep above unified only the sites already *named* `joinPath`. **Every other workDir-onto-relative join in
the application layer remains a hand-inlined or differently-named copy of the same join.** This part routes them all onto
the one collapsing `joinPath`, after widening its signature.

#### Signature widening (the enabler — DECIDED in principle, exact shape formalised here)

The current helper is `joinPath = (workDir: string, path: FilePath): string => …` (`join-working-tree-path.ts:9`). Many
sweep sites do **not** pass a `FilePath` as the 2nd operand: a bare filename (`GITMODULES_FILE` — a `string` constant),
`run-hook`'s `hooksPath` (`string`), or a **constructed suffix** (`` `${dir}/.gitattributes` ``, `` `${path}/.git` ``,
`` `${dir}/.gitignore` ``). Widen the 2nd param to `string`:

```ts
export const joinPath = (workDir: string, path: string): string =>
  workDir.endsWith('/') ? `${workDir}${path}` : `${workDir}/${path}`;
```

Return stays `string`. **Confirmed: this does not break the three landed family-A call sites** — `write-working-tree-file.ts`
(`writeWorkingTreeFile` / `writeWorkingTreeEntry` / `removeWorkingTreeFile`), `apply-changeset.ts`, and
`apply-sparse-checkout.ts` all pass a `FilePath` as the 2nd arg, and `FilePath` is a branded `string` (∴ `FilePath ⊂ string`),
so every existing caller stays type-assignable with zero edits. The widening is **strictly more permissive** — it only
removes a constraint, never adds one. (The doc-comment in `join-working-tree-path.ts` is updated to say "a working-tree
path" rather than the narrower "index-relative `FilePath`".)

#### The complete family-A site inventory (verified against current code)

Enumerated by `grep -rnE 'layout\.workDir\}/' src | grep -v '\.test\.'` (27 raw matches) and reconciled against the
brief's list. **26 logical join sites across 16 files** — the grep's 27th line is `read-gitattributes.ts:27`, the second
arm of a single `dir === '' ? … : …` conditional that spans L26-27 (counted once). Every consumer was opened and
confirmed. The line numbers are pinned to the current tree but may drift — the planner re-greps.

**Standard FS-only inline sites** — output flows *only* into a pure `ctx.fs.*` op; route each to
`joinPath(ctx.layout.workDir, <path>)`:

| File | Line(s) | Expression / consumer |
|---|---|---|
| `primitives/snapshot/workdir-entry.ts` | 81 | `absPath`, fed to `ctx.fs.read` / `readSymlinkBytes` / `readlink` / `liveStat` |
| `primitives/find-would-overwrite.ts` | 76 | `ctx.fs.lstat(...)` |
| `primitives/compare-working-tree-entry.ts` | 59 | `absPath`, fed to `ctx.fs.lstat` |
| `commands/status.ts` | 314 | `ctx.fs.lstat(...).catch(...)` |
| `commands/blame.ts` | 173 | `absPath`, fed to `ctx.fs.lstat` / `read` / `readlink` |
| `commands/stash.ts` | 120, 158, 366 | `abs` (read/readlink) ; `lstat` ; `exists` |
| `commands/add.ts` | 129, 312, 328, 357 | `lstat` ×3 ; `readlink` |
| `commands/submodule.ts` | 90, 360, 504, 533, 538, 571 | `exists`/`stat`/`readUtf8` ; `exists`/`readdir`/`rmRecursive`/`mkdir` ; `exists`/`readUtf8`/`writeUtf8` ; `lstat` ; `lstat` ; `writeUtf8` |

`submodule.ts` L90/L504/L538 join the **constant** `GITMODULES_FILE` (a `string`, not a `FilePath`) and L571 joins a
**constructed** `` `${path}/.git` `` suffix (a `string`) — both pass only after the signature widening above. All six
consumers are pure FS.

**Named twin helpers** (identical body to `repoPath`; in-file FS consumers only, not exported):

| File | Line | Helper | Decision |
|---|---|---|---|
| `commands/internal/working-tree.ts` | 24 | `repoPath = (ctx, path) => `${ctx.layout.workDir}/${path}`` (5 in-file call sites: L49/81/91/123×2) | thin wrapper (D-TWINS) |
| `commands/mv.ts` | 332 | `workPath = (ctx, path) => `${ctx.layout.workDir}/${path}`` (1 in-file call site: L338 `lstatOrUndefined`) | thin wrapper (D-TWINS) |

**Variant sites** (bespoke handling — see the per-variant byte-identity arguments below):

| File | Line(s) | Shape | Handling |
|---|---|---|---|
| `primitives/walk-working-tree.ts` | 105-106 | `directoryPath` — HYBRID, returns **bare** `workDir` on empty prefix | fold only the **non-empty** branch |
| `primitives/walk-working-tree.ts` | 101 | inline `ctx.fs.lstat(`${workDir}/${path}`)` | route to `joinPath` |
| `primitives/run-hook.ts` | 41 | `` `${layout.workDir}/${hooksPath}` `` (relative-hooksPath branch) | route to `joinPath` after widening |
| `primitives/internal/read-gitignore.ts` | 20-21 | `dir === '' ? `…/.gitignore` : `…/${dir}/.gitignore`` (**carries** a Stryker-disable on L19) | route to `joinPath(workDir, dir === '' ? '.gitignore' : `${dir}/.gitignore`)` — see note (disable narrows) |
| `primitives/internal/read-gitattributes.ts` | 25-27 | same shape for `.gitattributes` (**no** Stryker-disable today) | same routing — add no disable |
| `primitives/internal/submodule-context.ts` | 16 | `const workDir = `${ctx.layout.workDir}/${treeRelPath}`` — CONSTRUCTS a child-`Context` workDir field (not an FS access) | route to `joinPath`; **flagged** as a workDir-construction, not an FS access |

**Excluded (verified, NOT family A):**

- `commands/internal/working-tree.ts:130` — `moveNode`'s `` `${fromAbs}/${child.name}` `` joins two **already-absolute**
  fragments (recursion descent), neither family; untouched.
- `commands/mv.ts:311` — `repath`, a `slice`-based reparent (`` `${target}${entry.path.slice(source.length)}` ``), not a
  workDir join; untouched.
- `join-working-tree-path.ts` — the family-A module's own definition; it is widened, not "swept".
- All family-B path-segment joins (Part 2) and any join whose first operand is not `workDir`.

> **Reconciliation against the brief's inventory:** every site the brief listed is present above and verified. **No site
> was missed**, and **no extra workDir-join site** exists beyond those the brief enumerated (the grep returns exactly the
> 27 raw lines tabulated → 26 logical sites; `read-gitattributes.ts:26-27` is a single conditional, counted once). The
> `read-gitignore` carries a **pre-existing `Stryker disable` comment** on its `dir === ''` conditional
> (`read-gitignore.ts:19`); `read-gitattributes` has the equivalent conditional **without** a disable today (it is not
> currently flagged as an equivalent mutant — verify in the scoped mutation run after the rewrite, and only add a disable
> if a genuinely-equivalent survivor appears, with explicit user approval). See the per-variant note.

#### Harmlessness proof (Part 1) — the landed family-A proof, applied per-site

For the **standard FS-only sites and the named twins**, the proof is the landed family-A proof **verbatim**: the join's
output flows only into a pure `ctx.fs.*` op; `//` ≡ `/` under both the memory adapter (`normalizePath` skips empty
segments — `adapters/memory/memory-file-system.ts:508-509`) and the node adapter (`node:path` collapses redundant
separators); and `ctx.layout.workDir` is never trailing-slash (node `nodePath.resolve` strips it —
`adapters/node/node-adapter.ts:40`; memory/browser use the slash-free `DEFAULT_WORK_DIR` / `ROOT_WORK_DIR`). Re-pinned
empirically in a throwaway on this machine (scrubbed `GIT_*`): `path.resolve('/a/b/') === '/a/b'`,
`path.join('/a/b/','c/d') === '/a/b/c/d'`, `path.posix.normalize('/a/b//c/d') === '/a/b/c/d'`,
`fs.existsSync(cwd + '/d//f') === true` for an existing `d/f`. So routing through the COLLAPSING `joinPath` is
observationally byte-identical for every standard site.

The **variant sites** each get a one-line byte-identity argument:

- **`walk-working-tree.ts:101` (inline lstat join)** — standard FS-only site (the join feeds `config.ctx.fs.lstat`).
  Byte-identical by the standard proof. Route to `joinPath`.
- **`walk-working-tree.ts:105-106` `directoryPath` (HYBRID)** — returns the **bare** `workDir` when `prefix === ''`,
  else `` `${workDir}/${prefix}` ``. The empty branch **cannot** be `joinPath(workDir, '')` (that would yield
  `` `${workDir}/` `` — a trailing slash, NOT byte-identical to the bare `workDir`). **Fold ONLY the non-empty branch:**
  `prefix === '' ? config.ctx.layout.workDir : joinPath(config.ctx.layout.workDir, prefix)`. The empty branch is left
  exactly as-is (bare `workDir`). The non-empty branch is byte-identical (standard proof — `prefix` is a non-empty
  validated walk path, `workDir` non-slash → `joinPath` produces `` `${workDir}/${prefix}` ``, identical). `directoryPath`'s
  consumers are `ctx.fs.readdir` / `lstat` (pure FS), so even the empty-branch bare-`workDir` value is unchanged and
  harmless.
- **`run-hook.ts:41`** — the relative-`hooksPath` branch of `resolveHooksDir`; output is the hooks **directory** the
  runner resolves hook files against (`HookRequest.hooksDir`, consumed by the runner's dir+filename lookups, a pure path
  resolution). `hooksPath` is a non-empty relative `string` here (the `''`, `~/`, and absolute branches are handled
  separately above it), `workDir` is non-slash → `joinPath` yields the byte-identical `` `${workDir}/${hooksPath}` ``.
  Harmless after widening (`hooksPath` is `string`).
- **`read-gitignore.ts:20-21` & `read-gitattributes.ts:25-27`** — both are
  `dir === '' ? `${workDir}/.gitignore` : `${workDir}/${dir}/.gitignore`` (`.gitattributes` for the latter). Rewrite each
  to a **single** `joinPath` call with the conditional moved to the 2nd operand:
  `joinPath(ctx.layout.workDir, dir === '' ? '.gitignore' : `${dir}/.gitignore`)`. Byte-identity: empty branch →
  `joinPath(workDir, '.gitignore')` = `` `${workDir}/.gitignore` `` (identical); non-empty branch →
  `joinPath(workDir, `${dir}/.gitignore`)` = `` `${workDir}/${dir}/.gitignore` `` (identical). Consumer is
  `loadCappedUtf8` → `ctx.fs` read (pure FS). **Stryker-disable interaction (asymmetric — note carefully):**
  - `read-gitignore.ts:19` carries a **pre-existing** `// Stryker disable next-line ConditionalExpression,StringLiteral:
    equivalent …`. The `ConditionalExpression` half stays equivalent after the rewrite — the `dir === ''` conditional now
    selects the 2nd-operand string, but both arms still resolve to the same file via FS `//`-normalisation, so flipping
    it is still equivalent. **The `StringLiteral` half changes shape:** today it covers the two whole-template literals;
    after the rewrite the literals are `'.gitignore'` and `` `${dir}/.gitignore` ``, and a `StringLiteral` mutant on
    `'.gitignore'` (e.g. emptying it) would produce a *genuinely wrong* path — **no longer equivalent**. So the planner
    must **not** blindly re-point the old `StringLiteral` disable: re-validate it in the scoped mutation run. If the
    `'.gitignore'`/`'.gitattributes'` literal mutant is killed by an existing test (a `readGitignore`/`readGitattributes`
    test that asserts the file at the repo root is loaded), **drop the `StringLiteral` token from the disable**, keeping
    only `ConditionalExpression` (which remains equivalent). Net: the disable **narrows**, it does not get re-introduced
    wholesale. Only keep a token under explicit user approval if a provably-equivalent survivor remains.
  - `read-gitattributes.ts` has **no** Stryker disable today, and its conditional is **not** currently flagged equivalent.
    The rewrite must keep it that way — **add no disable**; rely on the existing `readGitattributes` tests to kill both
    branches + the literals, and surface any real survivor to the user rather than silencing it.
  - Flag both for the reviewer.
- **`submodule-context.ts:16` (workDir CONSTRUCTION — flagged)** — `const workDir = `${ctx.layout.workDir}/${treeRelPath}``
  builds the **child `Context`'s `layout.workDir` and `cwd`** (a layout field), **NOT an immediate FS access**. Route to
  `joinPath(ctx.layout.workDir, treeRelPath)`. Byte-identity: `ctx.layout.workDir` non-slash + `treeRelPath` a validated
  `FilePath` (non-empty, no leading/trailing `/`) → `joinPath` yields the identical `` `${workDir}/${treeRelPath}` `` with
  **no trailing slash**. **Downstream trailing-slash sensitivity — confirmed harmless:** the constructed `workDir`
  becomes the child's `layout.workDir`/`cwd`, and every downstream join *onto* it goes through the family-A `joinPath`
  (collapsing) or a family-A inline FS site (FS-normalised) — none depends on a trailing-slash distinction, and the
  constructed value carries none anyway. This is the **one** sweep site whose output is not an immediate disk path; it is
  flagged explicitly so the reviewer treats it as a layout-field construction, not an FS access.

**Verdict (Part 1):** every sweep site is observationally byte-identical — no SHA / ref / reflog / state-file / refusal /
structured-output change, no working-tree path difference. The collapse is strictly more normalised; the widening is
strictly more permissive. Behaviour-preserving.

### Part 2 — the family-B path-segment join: three copies

Three local `joinPath` definitions join a repo-relative prefix to a leaf, producing a repo-relative `FilePath`:

| Copy | Definition | Empty-prefix guard? | Call site |
|---|---|---|---|
| `walk-submodules.ts:106` | `(prefix: string, leaf: string): string => prefix === '' ? leaf : `${prefix}/${leaf}`` | **yes** | L66 `joinPath(pathPrefix, entry.path) as FilePath` |
| `walk-working-tree.ts:108` | `(prefix: string, name: string): FilePath => (prefix === '' ? name : `${prefix}/${name}`) as FilePath` | **yes** | L87 `joinPath(prefix, entry.name)` |
| `mv.ts:327` | `(dir: FilePath, leaf: string): FilePath => `${dir}/${leaf}` as FilePath` | **no** | L176 `joinPath(mode.destDir, basename(source))` |

They differ in exactly two cosmetic ways:

1. **Return type / cast placement.** `walk-submodules` returns `string` and the call site casts `as FilePath`; the
   other two return `FilePath` (cast *inside* the helper). `FilePath` is a branded `string`, assignable to `string`.
2. **`mv`'s first param is typed `FilePath`** (not `string`). `FilePath` is assignable to `string`, so a
   `string`-typed parameter accepts it.

And in one **substantive** way: **`mv` has no empty-prefix guard.** The reconciliation question is whether folding `mv`
onto a **guarded** shared helper changes `mv`'s behaviour — i.e. whether `mv`'s `dir` can ever be empty (in which case
the guard's `leaf` branch would diverge from `mv`'s current `${dir}/${leaf}` = `/leaf`).

#### Harmlessness proof (Part 2) — `mv`'s `destDir` is provably never empty and never leading-slash

The guard is a **no-op for `mv`**: its `dir` (`mode.destDir`) is always a non-empty, non-leading-slash `FilePath`, so
the guarded shared helper always takes the **else** branch — byte-identical to `mv`'s current `${dir}/${leaf}`. Proof
chain, every link pinned to source:

- `mv.ts:103` — `const destNoSlash = validatePath(stripTrailingSlash(destination));`
- `mv.ts:34` — `validatePath` is imported from `commands/internal/working-tree.ts`, where (`working-tree.ts:22`)
  `export const validatePath = validateWorkingTreePath;`
- `domain/working-tree-path.ts:28-33` — `validateWorkingTreePath` **rejects** `input === ''` (L30, throws
  `PATHSPEC_OUTSIDE_REPO`) **and** `input.startsWith('/')` (L33). So any value returned by `validatePath` is non-empty
  and has no leading `/`.
- `mv.ts:151` — `destDir` is assigned **only** here: `return { kind: 'into-dir', destDir: destNoSlash };`. There is no
  other producer of `destDir`. Therefore `mode.destDir` is always `destNoSlash`, hence always non-empty / non-slash.
- `mv.ts:176` — the family-B join `joinPath(mode.destDir, basename(source))` runs **only** when `mode.kind !== 'rename'`,
  i.e. `mode.kind === 'into-dir'`, the only mode carrying `destDir`.

So for `mv`, `prefix === ''` is **structurally unreachable**: the guard's true-branch can never fire, and the else-branch
`${dir}/${leaf}` is exactly `mv`'s current join. Folding `mv` onto the guarded helper is **behaviour-preserving**.

The other two callers (`walk-submodules`, `walk-working-tree`) **already carry the identical guard**, so for them the
shared helper is the same function they call today — trivially behaviour-preserving.

Faithfulness cross-check (Part 2, pinned in a throwaway with scrubbed `GIT_*`): real `git mv a.txt dir` yields
`dir/a.txt` (single separator, basename kept) — exactly what `joinPath(destDir, basename(source))` produces via the
else-branch. No git observable behaviour changes.

#### The reconciled shared family-B helper — `joinPathSegment`

A single `string`-returning helper with the guard fits all three callers. **Name DECIDED:** `joinPathSegment` in
`primitives/internal/join-path-segment.ts`.

```ts
/**
 * Join a repo-relative path segment onto a repo-relative prefix, guarding the
 * empty prefix so a root-level segment yields the bare leaf (never a leading
 * `/`). The single definition shared by the tree walkers and `mv`'s into-dir
 * target build. NOT the same join as the working-tree-write `joinPath`.
 */
export const joinPathSegment = (prefix: string, leaf: string): string =>
  prefix === '' ? leaf : `${prefix}/${leaf}`;
```

Both params typed `string` — accepts `mv`'s `FilePath` `dir` by assignability and the walkers' `string` prefixes. The
body needs **no import** (params + return are plain `string`); the doc-comment references neither, so no `FilePath`
type-import is added. Each call site casts `as FilePath` where it already does:

- `walk-submodules.ts:66` — `joinPathSegment(pathPrefix, entry.path) as FilePath` — cast already present, unchanged.
- `walk-working-tree.ts:87` — currently `const path = joinPath(prefix, entry.name);` (the local helper casts *inside*);
  becomes `const path = joinPathSegment(prefix, entry.name) as FilePath;` (the cast moves from the deleted helper to the
  call site — net byte-identical value, no behaviour change).
- `mv.ts:176` — `joinPathSegment(mode.destDir, basename(source)) as FilePath` (cast moves to the call site, same as
  above).

### Decision candidates (scope expansion)

The two load-bearing choices the user has **already settled** (the full sweep; the family-B name) are recorded here as
DECIDED so the planner has the rationale. One genuinely-open sub-choice (twin wrapper-vs-inline) is surfaced with a
recommendation.

| # | Choice | Alternatives (≤3) | Outcome | Why |
|---|---|---|---|---|
| **D-SWEEP — scope of the family-A expansion** | The original framing folded only the 5th copy (`repoPath`). How wide does the family-A expansion go? | **(a)** Fold only `repoPath` (the 5th named copy). **(b)** The FULL sweep — every workDir-onto-relative join (~25 sites across 16 files), widening `joinPath`'s signature to `string`. | **DECIDED → (b)** | The user chose the complete family-A sweep, not just `repoPath`. Leaving ~20 hand-inlined copies would defeat the "one join" north star for everything except the two named helpers. The signature widening is the enabler (filenames / constants / suffixes need a `string` 2nd param); it is strictly more permissive and breaks no landed caller (proven above). Folded into Part 1 as settled. |
| **D-WIDEN — `joinPath` signature shape** | The sweep needs sites passing non-`FilePath` 2nd operands. What exact signature? | **(a)** Widen 2nd param `FilePath` → `string`, return stays `string`. **(b)** Keep `FilePath`, cast every non-`FilePath` site (`as FilePath`). **(c)** Overload / add a second helper. | **DECIDED → (a)** (formalised here) | The user decided to widen in principle; (a) is the exact shape. (b) sprays unsafe `as FilePath` casts across ~6 sites (a smell the project forbids) and lies about the type. (c) adds surface for no gain. (a) is one constraint removed; all landed `FilePath`-passing callers stay assignable (`FilePath ⊂ string`). Confirmed no break. Folded into Part 1. |
| **D-TWINS — the two named twin helpers (`repoPath`, `workPath`)** | `working-tree.ts:24` `repoPath` (5 in-file call sites) and `mv.ts:332` `workPath` (1 in-file call site) are non-collapsing family-A copies. How to route each onto the unified `joinPath`. | **(a)** Keep each as a thin local wrapper delegating to `joinPath` (`(ctx, path) => joinPath(ctx.layout.workDir, path)`) — call sites unchanged, the `ctx`-projection sugar kept. **(b)** Inline-delete each: replace every call site with `joinPath(ctx.layout.workDir, …)` and remove the helper. | **RECOMMEND → (a)** for **both** (consistency) | Both satisfy "exactly ONE join definition" (the join logic lives only in `joinPath` either way). (a) is the smaller, lower-risk diff (one import + a one-line wrapper body per file; call sites untouched), keeps the readable `repoPath(ctx, path)` / `workPath(ctx, path)` shape (the `ctx → ctx.layout.workDir` projection is real local sugar — without it each site repeats `ctx.layout.workDir`), and applies the **same** decision to both twins for consistency. (b) trades 6 call-site edits + loss of the projection sugar for removing two trivial wrappers — net negative on diff/readability, no correctness gain. **This sub-choice is load-bearing — the user confirms (a) for both, or picks (b).** |
| **D-FAMB-MODULE — home + name of the shared family-B helper** | The family-B helper must be importable by **both** `primitives/` (`walk-*`) **and** `commands/` (`mv`), so it lives in `primitives/internal/`. The name + file name. | `join-path-segment.ts` / `joinPathSegment`; (rejected: `join-tree-path.ts` / `joinTreePath`; `append-path-segment.ts` / `appendPathSegment`) | **DECIDED → `joinPathSegment` in `join-path-segment.ts`** | The user chose `joinPathSegment`. It is distinct from family A's `joinPath` (so the two joins are never conflated), names exactly what differs ("join a path **segment** onto a prefix"), reads unambiguously at every call site, and keeps the `join*` family verb while the `*Segment` suffix supplies the qualifier. `joinTreePath` was rejected (risks confusion with `read-tree`/`walk-tree`/`write-tree` — it is not a git *tree* operation). Folded into Part 2 as settled. |

D-SWEEP, D-WIDEN, and D-FAMB-MODULE are **DECIDED by the user** and folded into the design as settled. **D-TWINS** is the
one remaining load-bearing sub-choice — the design recommends (a) for both twins; the user confirms or overrides.

### Requirements (scope expansion)

When this expansion ships, in addition to the family-A requirements above:

1. **There is exactly ONE family-A workDir-join definition** — the widened `joinPath` in `join-working-tree-path.ts`
   (`(workDir: string, path: string): string`). **Every** workDir-onto-relative join in the application layer routes
   through it: the ~20 standard inline FS sites, the two named twins (`repoPath`, `workPath`, per D-TWINS), and the
   variant sites (`directoryPath`'s non-empty branch, `run-hook`, `read-gitignore`/`read-gitattributes`,
   `submodule-context`'s workDir construction). No hand-inlined `` `${ctx.layout.workDir}/${…}` `` remains except the
   explicitly-excluded non-family sites (`moveNode`'s absolute-fragment join, `mv`'s `repath`).
2. **The `joinPath` signature is widened** to `(workDir: string, path: string): string`; the three landed family-A
   callers still type-check unchanged.
3. **Exactly one family-B path-segment join definition** — `joinPathSegment` in `primitives/internal/join-path-segment.ts`,
   imported by `walk-submodules.ts`, `walk-working-tree.ts`, and `mv.ts`. The three local `joinPath` definitions are gone.
4. **The family-A and family-B helpers carry distinct names** (`joinPath` vs `joinPathSegment`) — the two joins are never
   conflated.
5. **Behaviour is unchanged** under cone AND non-cone, memory AND node: same files materialised/read/removed/renamed,
   same status/add/stash/blame/submodule on-disk + index outcomes, same hooks dir resolution, same gitignore/gitattributes
   loads, same child-submodule contexts (Part 1); same submodule walk paths, working-tree walk paths, and `mv` index+tree
   readback (Part 2). No SHA / ref / reflog / state-file / refusal / structured-output change; no public surface / option
   / `api.json` change (ADR-249/226 unaffected).
6. The existing suites stay green **unchanged** (they are the regression authority); touched code keeps its coverage
   posture and **0 surviving mutants** — including the widened `joinPath` (both branches) and the new `joinPathSegment`
   (both branches) (Stryker mutates all `src`). The one **pre-existing** `Stryker disable` on `read-gitignore.ts`'s
   `dir === ''` conditional is **narrowed** after the rewrite (its `ConditionalExpression` half stays equivalent and is
   re-pointed; its `StringLiteral` half is re-validated and dropped if the literal mutant is now killed) — **no *new*
   suppression is introduced** anywhere (notably none on `read-gitattributes`, which has none today).

### Test strategy (scope expansion)

Behaviour-preserving → the **existing** suites are the regression authority and must stay green **unchanged**. Coverage
gates `domain`/`adapters` only; Stryker mutates **all** `src` against unit tests — so both helpers' mutants must die.

- **Part 1 — the full family-A sweep.** **No new test.** The widened `joinPath` is the single point where every swept
  site now joins; its **two branches** are already killed by the family-A sections above — non-slash by
  `write-working-tree-file.test.ts` (`DEFAULT_WORK_DIR = '/repo'`), slash by `apply-sparse-checkout.test.ts:376-398`
  (hand-built trailing-slash `Context`). The widening (param `FilePath` → `string`) removes a type constraint only — it
  adds no runtime branch, so it introduces no new mutant. Each swept **call site** stays exercised by its own existing
  home suite (all assert a written/read/lstatted path string, which kills any per-site delegation mutant):
  - `working-tree.ts` (`repoPath` twin) → `test/unit/application/commands/internal/working-tree.test.ts` +
    `test/unit/application/commands/mv.test.ts` (drives `renameInWorkingTree`).
  - `mv.ts` (`workPath` twin) → `mv.test.ts` (the `lstatOrUndefined` path).
  - `status` / `blame` / `stash` / `add` / `submodule` → their respective command unit + integration/interop suites.
  - `snapshot/workdir-entry` / `find-would-overwrite` / `compare-working-tree-entry` / `walk-working-tree` (L101 +
    `directoryPath` non-empty branch) → the snapshot/status/checkout suites that drive them.
  - `run-hook` (relative-`hooksPath` branch) → the hooks unit suite that exercises a relative `core.hooksPath`.
  - `read-gitignore` / `read-gitattributes` → their unit suites (both `dir === ''` and nested-`dir` cases). **The
    rewritten `dir === ''` conditional keeps its pre-existing `Stryker disable`** (equivalent mutant; rationale and
    line re-pointed, not newly introduced).
  - `submodule-context` (child-workDir construction) → the submodule walk/status/add suites that build a child `Context`
    and read through it.
  The twin **wrapper bodies** (per D-TWINS (a)) are single delegating calls; the only mutant is swapping the delegation,
  killed by any home-suite test asserting a concrete path. If the user picks D-TWINS (b) (inline-delete) there is no
  wrapper to mutate — coverage is unaffected either way.
- **Part 2 — the family-B helper `joinPathSegment` has a REAL guard branch** (`prefix === ''`), so **both** branches must be exercised or
  a `ConditionalExpression` / `StringLiteral` mutant survives. Verified the existing suites already cover both, across
  the three callers (so transitive coverage suffices — **no dedicated helper test needed**, mirroring the family-A D4
  resolution):
  - **Empty-prefix TRUE branch** (`prefix === ''` → returns `leaf`):
    - `walk-working-tree.test.ts` — root files `a.txt` / `b.txt` (`expect(sut.sort()).toEqual(['a.txt','b.txt'])`,
      ~L65) are produced with `prefix === ''`.
    - `walk-submodules.test.ts` — top-level gitlinks `orphan` / `foo` / `gitlink` / `vendor/foo` (depth 0,
      `pathPrefix === ''`) — e.g. the recursive test asserts the depth-0 entry `path: 'vendor/foo'` (L527).
  - **Non-empty branch** (`${prefix}/${leaf}`):
    - `walk-working-tree.test.ts` — nested `a/b/c.txt` / `a/d.txt` (`expect(sut.sort()).toEqual(['a/b/c.txt','a/d.txt',
      'e.txt'])`, ~L84) join a non-empty `prefix`.
    - `walk-submodules.test.ts` — the recursive "nested submodule with absorbed gitdir" test asserts the depth-1 child
      `path: 'vendor/foo/nested/bar'` (L534), built with `pathPrefix === 'vendor/foo'` (non-empty).
    - `mv.test.ts` — into-dir moves assert `to: 'dir/a.txt'` (L101, L119-120) and `to: 'dest/src/f.txt'` (L180), each
      from `joinPath(mode.destDir, basename(source))` with a non-empty `destDir`.
  - **`StringLiteral` / template mutants** on `${prefix}/${leaf}` (e.g. dropping the `/`, swapping operands) are killed
    by the exact-string `toEqual` assertions above (`'a/b/c.txt'`, `'vendor/foo/nested/bar'`, `'dir/a.txt'`).

  **Recommendation:** ship Part 2 with **no dedicated helper test** — both branches and the template are killed
  transitively by the three callers' existing suites (Stryker resolves mutants through the import graph, not file
  co-location). **Safety net:** if the scoped mutation run surfaces a survivor on `join-path-segment.ts`, add a targeted
  two-case `join-path-segment.test.ts` (empty-prefix → `leaf`; non-empty → `prefix/leaf`) in that slice. This is the
  expectation's fallback, not the plan.
- **No new interop pin** — no new git behaviour; the two empirical throwaway pins above (git-mv basename; node
  double-slash) are confirmations of *existing* behaviour, recorded for the proof, not a new parity matrix.

**Property tests — DO NOT APPLY.** Both helpers are single-line string concatenations behind I/O orchestration, not a
parser / matcher / round-trip pair / counting invariant (the property-test lenses do not fit; the family-A section
reached the same conclusion for `joinPath`).

### Slicing hint for the planner (scope expansion)

**Five atomic, build-safe slices** (not 25 micro-slices). Each is self-consistent **per file** — a local helper is
deleted only in the same commit that removes its last in-file reference (build integrity). S1 must land **first** (it
widens the signature every later sweep slice relies on); S2/S3/S4 are independent of each other after S1; S5 (family B)
is independent of all of them. Each slice gates on the full `npm run validate` + a scoped 0-survivor mutation run; all
lean on the named existing suites as the behaviour-preservation guard (no new test unless a scoped mutation survivor
appears).

**Slice S1 — widen `joinPath` + fold the two named twins.** *(Part 1, the enabler)*
- Edit `src/application/primitives/internal/join-working-tree-path.ts`: widen the 2nd param `path: FilePath` → `path: string`
  (**L9**); the `import type { FilePath }` (L1) is now unused — DELETE it; update the doc-comment to say "a working-tree
  path" rather than "index-relative `FilePath`".
- Edit `src/application/commands/internal/working-tree.ts`: per **D-TWINS (a)** change `repoPath` body (**L24**) to
  `(ctx, path) => joinPath(ctx.layout.workDir, path)`; ADD
  `import { joinPath } from '../../primitives/internal/join-working-tree-path.js';` (the `commands/internal →
  primitives/internal` direction is legal and already used by sibling files). Call sites L49/81/91/123×2 verbatim.
  UNCHANGED (verify): `moveNode`'s `` `${fromAbs}/${child.name}` `` (L130).
- Edit `src/application/commands/mv.ts`: per **D-TWINS (a)** change `workPath` body (**L332**) to
  `(ctx, path) => joinPath(ctx.layout.workDir, path)`; ADD
  `import { joinPath } from '../primitives/internal/join-working-tree-path.js';`. Call site L338 verbatim. UNCHANGED:
  the local family-B `joinPath` (L327) and `repath` (L311) — both untouched here.
- (D-TWINS (b) variant: inline-delete each twin, edit its call sites, same import — one commit per file.)
- Regression: `working-tree.test.ts`, `mv.test.ts`; plus the writer/sparse/changeset suites that gate the landed
  `joinPath` (prove the widening didn't regress them).
- Gate: `npm run validate` green; scoped mutation on `join-working-tree-path.ts` + `working-tree.ts` + `mv.ts` → 0 new
  survivors.

**Slice S2 — sweep the primitives inline FS sites.** *(Part 1)*
- Files + lines (route each `` `${ctx.layout.workDir}/${…}` `` to `joinPath(ctx.layout.workDir, …)`, adding
  `import { joinPath } from './internal/join-working-tree-path.js';` — or `'./join-working-tree-path.js'` for files
  already in `internal/`):
  `snapshot/workdir-entry.ts:81`; `find-would-overwrite.ts:76`; `compare-working-tree-entry.ts:59`;
  `walk-working-tree.ts:101` (inline lstat) and **`directoryPath` L105-106 non-empty branch only** (keep the empty
  branch's bare `workDir`).
- Regression: the snapshot / status / checkout / walk-working-tree unit suites; relevant integration suites.
- Gate: `npm run validate` green; scoped mutation on the 4 touched files → 0 new survivors.

**Slice S3 — sweep the commands inline FS sites.** *(Part 1)*
- Files + lines (same routing + import): `status.ts:314`; `blame.ts:173`; `stash.ts:120,158,366`;
  `add.ts:129,312,328,357`; `submodule.ts:90,360,504,533,538,571` (the constant-`GITMODULES_FILE` and
  constructed-`${path}/.git` sites pass only after S1's widening).
- Regression: the status / blame / stash / add / submodule unit + integration/interop suites.
- Gate: `npm run validate` green; scoped mutation on the 5 touched files → 0 new survivors.

**Slice S4 — sweep the variant sites.** *(Part 1)*
- `primitives/run-hook.ts:41` → `joinPath(layout.workDir, hooksPath)`.
- `primitives/internal/read-gitignore.ts:20-21` → `joinPath(ctx.layout.workDir, dir === '' ? '.gitignore' : `${dir}/.gitignore`)`.
  **The existing `Stryker disable` (L19) covers `ConditionalExpression,StringLiteral`: the `ConditionalExpression` half
  stays equivalent and is re-pointed; the `StringLiteral` half is re-validated — if the `'.gitignore'` literal mutant is
  killed by an existing root-load test, DROP `StringLiteral` from the disable (it narrows, it is not re-introduced).**
- `primitives/internal/read-gitattributes.ts:25-27` → same shape for `.gitattributes`. **No Stryker disable exists here
  today — add none; rely on existing tests + escalate any real survivor to the user.**
- `primitives/internal/submodule-context.ts:16` → `joinPath(ctx.layout.workDir, treeRelPath)` (the child-`Context`
  workDir construction — flag in the commit body as a layout-field construction, not an FS access).
- Regression: the gitignore/gitattributes unit suites (both `dir === ''` and nested cases — they must assert a root-level
  load to kill the `'.gitignore'`/`'.gitattributes'` literal mutant), the hooks unit suite (relative `hooksPath`), the
  submodule walk/status/add suites (child-context).
- Gate: `npm run validate` green; scoped mutation on the 4 touched files → 0 new survivors. **Confirm the rewritten
  `read-gitignore` conditional's `StringLiteral` mutants are killed (so the disable narrows to `ConditionalExpression`),
  and `read-gitattributes` introduces no survivor needing a disable.**

**Slice S5 — extract `joinPathSegment`, route the three family-B callers.** *(Part 2)*
- **NEW file** `src/application/primitives/internal/join-path-segment.ts`: export
  `joinPathSegment = (prefix: string, leaf: string): string => prefix === '' ? leaf : `${prefix}/${leaf}`` + doc-comment.
  No import needed (params/return are `string`).
- Edit `walk-submodules.ts`: DELETE local `joinPath` (**L106-107**); ADD
  `import { joinPathSegment } from './internal/join-path-segment.js';`; call site **L66** →
  `joinPathSegment(pathPrefix, entry.path) as FilePath` (cast already present).
- Edit `walk-working-tree.ts`: DELETE local `joinPath` (**L108-109**); ADD the same import; call site **L87** →
  `const path = joinPathSegment(prefix, entry.name) as FilePath;` (cast moves out of the deleted helper).
  **UNCHANGED:** `directoryPath` (L105-106) and the lstat join (L101) — those are family A, handled in S2.
- Edit `mv.ts`: DELETE local `joinPath` (**L327**); ADD
  `import { joinPathSegment } from '../primitives/internal/join-path-segment.js';`; call site **L176** →
  `joinPathSegment(mode.destDir, basename(source)) as FilePath`. **UNCHANGED:** `workPath` (handled in S1) and
  `repath` (L311).
- Each file's helper-delete + call-site-edit lands in the **same commit** (build integrity).
- Regression: `walk-submodules.test.ts` (root depth-0 → bare leaf; recursive depth-1 → `vendor/foo/nested/bar`),
  `walk-working-tree.test.ts` (root → bare name; nested → `a/b/c.txt`), `mv.test.ts` (into-dir → `dir/a.txt`,
  `dest/src/f.txt`) + the `mv` interop suite.
- Gate: `npm run validate` green; scoped mutation on `join-path-segment.ts` + the 3 touched files → 0 new survivors. If a
  survivor appears on `join-path-segment.ts`, add the two-case targeted test (safety net) in this slice.

### Out of scope (scope expansion)

- **Family A's already-landed work** — `join-working-tree-path.ts`'s *signature* is widened (S1) and the three landed
  callers (`write-working-tree-file.ts`, `apply-sparse-checkout.ts`, `apply-changeset.ts`) are confirmed to still
  type-check unchanged, but their bodies are **not** edited. The widening is the only re-touch of the family-A module.
- **`moveNode`'s absolute-fragment join (`working-tree.ts:130`)** — `` `${fromAbs}/${child.name}` `` joins two
  **already-absolute** fragments (recursion descent); neither family A nor B; untouched.
- **`mv.ts`'s `repath` (L311)** — `` `${target}${entry.path.slice(source.length)}` `` is a `slice`-based reparent, not a
  workDir or path-segment join; untouched.
- **`directoryPath`'s empty-prefix branch (`walk-working-tree.ts:106`)** — returns the **bare** `workDir`; folding it onto
  `joinPath(workDir, '')` would introduce a trailing slash (NOT byte-identical). Only the non-empty branch is swept (S2);
  the empty branch is left exactly as-is.
- **Any behaviour change, public surface, option, or on-disk-state change** — none. Pure internal de-duplication +
  signature widening; `api.json`, command surfaces, refusal conditions, reflogs, structured output untouched
  (ADR-249/226 unaffected).
