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

> The sections above closed the working-tree-write `joinPath` north star (family A) — the four collapsing-join sites now
> share `primitives/internal/join-working-tree-path.ts`. This appended section extends the same de-duplication, in the
> same PR, to the join copies that were explicitly listed as out-of-scope above. It is **user-approved** and additive:
> the sections above are unchanged and remain the authority for the already-landed work. Same constraints as the
> original change — behaviour-preserving internal refactor, no new git surface, no public-API change, no on-disk-state
> change. The faithfulness obligation stays the **inverse**: prove every touched site is observationally byte-identical.

### Two distinct join families — do not conflate them

There are **two** different "join" operations in the application layer, with different inputs, outputs and semantics.
The expansion keeps them **separately named** so they are never confused:

| Family | What it joins | Output | Fed to | Helper after this PR |
|---|---|---|---|---|
| **A — working-tree-write** | `workDir` (absolute) + index-relative `FilePath` | absolute disk path (`string`) | **only** FS ops (`write`/`read`/`lstat`/`rename`/`exists`/`rm`) | `joinPath` in `primitives/internal/join-working-tree-path.ts` (COLLAPSING) — landed above |
| **B — path-segment** | a repo-relative `prefix` + a `leaf`/`name` | repo-relative `FilePath` | tree-walk / index keys / further joins (NOT FS as an absolute) | NEW shared helper (NOT named `joinPath` — see D-FAMB-MODULE) |

Family A collapses a trailing `/` (so `workDir//rel` → `workDir/rel`). Family B instead **guards the empty prefix**
(`prefix === '' ? leaf : `${prefix}/${leaf}``) so a root-level entry yields `leaf`, not `/leaf`. They are genuinely
different joins; after this PR family A's helper is `joinPath`, and family B's shared helper carries a **distinct** name
so the two are not conflated at a glance.

This expansion has **two parts**:

- **Part 1** — fold the **5th family-A copy** (`repoPath` in `commands/internal/working-tree.ts`) into the unified
  family-A `joinPath`. It was missed by the family-A sweep above purely because it is named `repoPath`, not `joinPath`.
- **Part 2** — unify the **three family-B copies** (`walk-submodules.ts`, `walk-working-tree.ts`, `mv.ts`, each a local
  `joinPath`) into one shared family-B helper under `primitives/internal/`.

### Part 1 — the 5th family-A copy: `repoPath`

`commands/internal/working-tree.ts:24` defines a **non-collapsing** copy of the exact family-A join:

```
const repoPath = (ctx: Context, path: FilePath): string => `${ctx.layout.workDir}/${path}`;   // NON-collapsing
```

It differs from the unified family-A `joinPath` (`join-working-tree-path.ts:9`,
`workDir.endsWith('/') ? `${workDir}${path}` : `${workDir}/${path}``) **only** in the trailing-slash collapse — exactly
the difference the family-A harmlessness proof above already discharged.

#### Verified importer / call-site set (Part 1)

`find_referencing_symbols` on `repoPath` (`commands/internal/working-tree.ts`) returns **5 references, all in-file, all
pure FS**, and **no external importer** (`repoPath` is not exported):

| Site | Code | Consumer |
|---|---|---|
| L49 | `const dst = repoPath(ctx, path);` (`materializeFile`) | `ctx.fs.write` / `ctx.fs.openWithNoFollow` / `ctx.fs.chmod` |
| L81 | `return ctx.fs.read(repoPath(ctx, path));` (`readFile`) | `ctx.fs.read` |
| L91 | `const full = repoPath(ctx, path);` (`removeFile`) | `ctx.fs.lstat` then `ctx.fs.rm` |
| L123 | `await moveNode(ctx, repoPath(ctx, from), repoPath(ctx, to));` (`renameInWorkingTree`) ×2 | `moveNode` → `ctx.fs.lstat`/`readdir`/`mkdir`/`rename`/`rmRecursive` |

Every consumer is a pure FS operation; **none** is a matcher, an index key, or any verdict-bearing comparison. (Note:
`moveNode`'s own recursion at `working-tree.ts:130` uses a bare `` `${fromAbs}/${child.name}` `` to descend — that joins
two **already-absolute** path fragments, not workDir-onto-relative, so it is neither family A nor family B and is left
untouched.)

#### Harmlessness proof (Part 1) — identical to the family-A proof above

The same two-pronged argument the sections above pinned for the sparse/inline copies applies verbatim to `repoPath`:

1. **Output feeds only FS, never a verdict.** All 5 sites feed `ctx.fs.*` (table above). Routing through the COLLAPSING
   `joinPath` cannot alter any observable outcome that is not a disk path, and disk paths are `//`-normalised (next
   point).
2. **`//` and `/` resolve to the same file under every adapter.** Memory FS routes every op through `normalizePath`,
   which skips empty segments (`adapters/memory/memory-file-system.ts:508-509`); Node FS routes through `node:path`,
   which collapses redundant separators. Pinned empirically in a throwaway on this machine:
   `fs.existsSync(cwd + '/d//f') === true` for an existing `d/f`.
3. **The diverging input is unreachable in production.** The two helpers diverge **only** when `workDir` ends with `/`.
   No production adapter produces that: node `workDir = nodePath.resolve(options.workDir)`
   (`adapters/node/node-adapter.ts:40`) strips trailing slashes (pinned: `path.resolve('/a/b/') === '/a/b'`);
   memory/browser use the slash-free constants `DEFAULT_WORK_DIR` / `ROOT_WORK_DIR`.

So for every real input the unified `joinPath` produces the byte-identical string `repoPath` does, and even the
unreachable trailing-slash case resolves to the same file. **Harmless — observationally byte-identical** (no SHA / ref /
reflog / state-file / refusal / structured-output change, no working-tree path difference).

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

#### The reconciled shared family-B helper

A single `string`-returning helper with the guard fits all three callers:

```ts
import type { FilePath } from '../../../domain/objects/index.js';

/**
 * Join a repo-relative path segment onto a repo-relative prefix, guarding the
 * empty prefix so a root-level segment yields the bare leaf (never a leading
 * `/`). The single definition shared by the tree walkers and `mv`'s into-dir
 * target build. NOT the same join as the working-tree-write `joinPath`.
 */
export const <name> = (prefix: string, leaf: string): string =>
  prefix === '' ? leaf : `${prefix}/${leaf}`;
```

(Parameter typed `string` — accepts `mv`'s `FilePath` `dir` by assignability and the walkers' `string` prefixes.)
Each call site casts `as FilePath` where it already does:

- `walk-submodules.ts:66` — `<name>(pathPrefix, entry.path) as FilePath` — cast already present, unchanged.
- `walk-working-tree.ts:87` — currently `const path = joinPath(prefix, entry.name);` consumed as `FilePath`; becomes
  `const path = <name>(prefix, entry.name) as FilePath;` (the cast moves from inside the deleted helper to the call
  site — net byte-identical value, no behaviour change).
- `mv.ts:176` — `<name>(mode.destDir, basename(source)) as FilePath` (cast moves to the call site, same as above).

`<name>` is resolved by **D-FAMB-MODULE** below.

### Decision candidates (scope expansion)

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **D-REPOPATH — fold the 5th family-A copy** | `repoPath` (`working-tree.ts:24`) is a non-collapsing family-A join with 5 in-file call sites. How to route it through the unified `joinPath`. | **(a)** Keep a thin local wrapper: `const repoPath = (ctx: Context, path: FilePath): string => joinPath(ctx.layout.workDir, path);` — the 5 call sites stay verbatim; the join logic lives only in `joinPath`. **(b)** Delete `repoPath`; inline `joinPath(ctx.layout.workDir, path)` at all 5 sites — no wrapper indirection, 5 call-site edits. | **(a)** — thin local wrapper | Both satisfy "exactly ONE join definition" (the join lives only in `joinPath` either way). (a) is the smaller, lower-risk diff (one import + one one-line wrapper body change; 5 call sites untouched), keeps the readable `repoPath(ctx, path)` shape at every site (the `ctx`→`ctx.layout.workDir` projection is real local sugar — without it each site repeats `ctx.layout.workDir`), and matches the family-A precedent of de-duplicating the *definition* without churning callers. (b) trades 5 call-site edits and the loss of the `ctx`-projection sugar for removing one trivial wrapper — net negative on diff size and readability with no correctness gain. **This is a load-bearing choice — the user decides.** |
| **D-FAMB-MODULE — home + name of the shared family-B helper** | The family-B helper must be importable by **both** `primitives/` (`walk-*`) **and** `commands/` (`mv`), so it lives in `primitives/internal/` (the `commands → primitives` direction is legal and already crossed). The open choice is the file name + symbol name. | **(a)** `join-tree-path.ts` exporting `joinTreePath`. **(b)** `join-path-segment.ts` exporting `joinPathSegment`. **(c)** `append-path-segment.ts` exporting `appendPathSegment`. | **(b)** — `join-path-segment.ts` / `joinPathSegment` | All three live in `primitives/internal/` (importable by both layers; same precedent the family-A module set). The name MUST be distinct from family A's `joinPath` so the two joins are never conflated. (b) is the clearest: "join a path **segment**" names exactly what differs from family A (it joins a *segment* onto a prefix, not a workDir onto a relative path) and reads unambiguously at every call site (`joinPathSegment(prefix, leaf)`). (a) `joinTreePath` risks confusion with `read-tree`/`walk-tree`/`write-tree` (it is not a git *tree* object operation — it is plain path-segment concatenation). (c) `appendPathSegment` is accurate and equally distinct, but (b) is preferred because `join*` mirrors the established `joinPath` vocabulary (one verb for both joins) while the `*Segment` suffix supplies the distinguishing qualifier — so (b) keeps the family relationship visible *and* the distinction sharp, where (c) drops the shared verb. **This is a load-bearing choice — the user decides the name.** |

Neither D-REPOPATH nor D-FAMB-MODULE is pre-decided; both are surfaced for the user. The design records recommendations
only — the choice is the user's.

### Requirements (scope expansion)

When this expansion ships, in addition to the family-A requirements above:

1. **`repoPath` no longer defines its own join.** Per D-REPOPATH (a): `repoPath` becomes a thin wrapper over the unified
   family-A `joinPath`; the only family-A join *logic* lives in `join-working-tree-path.ts`. (Or per (b): `repoPath` is
   deleted and all 5 sites call `joinPath` directly.)
2. **Exactly one family-B path-segment join definition**, in `primitives/internal/<D-FAMB-MODULE module>`, imported by
   `walk-submodules.ts`, `walk-working-tree.ts`, and `mv.ts`. The three local `joinPath` definitions are gone.
3. **The family-A and family-B helpers carry distinct names** (`joinPath` vs the D-FAMB-MODULE name) — the two joins are
   never conflated.
4. **Behaviour is unchanged** under cone AND non-cone, memory AND node: same files materialised/read/removed/renamed
   (Part 1); same submodule walk paths, working-tree walk paths, and `mv` index+tree readback (Part 2). No SHA / ref /
   reflog / state-file / refusal / structured-output change; no public surface / option / `api.json` change
   (ADR-249/226 unaffected).
5. The existing suites stay green **unchanged** (they are the regression authority); touched code keeps its coverage
   posture and **0 surviving mutants** — including the new family-B helper (Stryker mutates all `src`).

### Test strategy (scope expansion)

Behaviour-preserving → the **existing** suites are the regression authority and must stay green **unchanged**. Coverage
gates `domain`/`adapters` only; Stryker mutates **all** `src` against unit tests — so both helpers' mutants must die.

- **Part 1 — `repoPath` fold.** No dedicated test. `repoPath` is application-layer (outside the coverage denominator),
  and the unified `joinPath` it now delegates to is already mutation-covered by the family-A sections above (non-slash
  branch by `write-working-tree-file.test.ts`, slash branch by `apply-sparse-checkout.test.ts:376-398`). The 5
  `repoPath` call sites stay exercised by the existing `working-tree`-driven suites: read
  `test/unit/application/commands/internal/working-tree.test.ts` to confirm `materializeFile` / `readFile` /
  `removeFile` / `renameInWorkingTree` are each driven (they are — `working-tree.test.ts` is the home suite), plus the
  `mv` suite drives `renameInWorkingTree` end-to-end. The wrapper body itself (per D-REPOPATH (a)) is a single delegating
  call; its only mutant — swapping the delegation — is killed by any `working-tree` test that asserts a written/read
  path, which the suite already does.
- **Part 2 — the family-B helper has a REAL guard branch** (`prefix === ''`), so **both** branches must be exercised or
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
  co-location). **Safety net:** if the scoped mutation run surfaces a survivor on the new family-B module, add a targeted
  two-case `<D-FAMB-MODULE module>.test.ts` (empty-prefix → `leaf`; non-empty → `prefix/leaf`) in that slice. This is
  the expectation's fallback, not the plan.
- **No new interop pin** — no new git behaviour; the two empirical throwaway pins above (git-mv basename; node
  double-slash) are confirmations of *existing* behaviour, recorded for the proof, not a new parity matrix.

**Property tests — DO NOT APPLY.** Both helpers are single-line string concatenations behind I/O orchestration, not a
parser / matcher / round-trip pair / counting invariant (the property-test lenses do not fit; the family-A section
reached the same conclusion for `joinPath`).

### Slicing hint for the planner (scope expansion)

Two atomic, build-safe slices. Each must be self-consistent **per file** — a local helper may be deleted only in the
same commit that removes its last in-file reference (build integrity). They are independent of each other and of the
family-A slices above; order is free, but Part 1 (one file) is the smaller warm-up.

**Slice C — fold the 5th family-A copy (`repoPath`).** *(Part 1)*
- Pre-chewed context (all in `src/application/commands/internal/working-tree.ts`):
  - Per **D-REPOPATH (a)** (recommended): change the body of `repoPath` (**L24**) to
    `const repoPath = (ctx: Context, path: FilePath): string => joinPath(ctx.layout.workDir, path);` and ADD
    `import { joinPath } from '../../primitives/internal/join-working-tree-path.js';` (the `commands/internal →
    primitives/internal` import direction is legal and already used by sibling `commands/internal` files). Call sites
    L49 / L81 / L91 / L123 (×2) stay verbatim.
  - (If the user picks **D-REPOPATH (b)**: delete `repoPath` (L24) and replace each of the 5 call sites with
    `joinPath(ctx.layout.workDir, …)`, adding the same import — all in one commit for build integrity.)
  - UNCHANGED (verify, do not edit): `moveNode`'s `` `${fromAbs}/${child.name}` `` (L130) — joins two absolute fragments,
    neither family A nor B; out of scope.
- Regression guard tests (run, expect green unchanged): `test/unit/application/commands/internal/working-tree.test.ts`
  (the home suite — drives `materializeFile` / `readFile` / `removeFile` / `renameInWorkingTree`);
  `test/unit/application/commands/mv.test.ts` (drives `renameInWorkingTree` end-to-end).
- TDD note: behaviour-preserving — no *new failing* test; correctness gate is "all suites green + `npm run validate`
  clean + 0 new mutants".
- Gate: `npm run validate` green; scoped mutation on `working-tree.ts` shows 0 new survivors (the deleted non-collapsing
  branch *reduces* surface).

**Slice D — extract the family-B helper, route the three callers.** *(Part 2)*
- Pre-chewed context:
  - **NEW file** `src/application/primitives/internal/<D-FAMB-MODULE module>` (recommended `join-path-segment.ts`):
    export the guarded helper `(prefix: string, leaf: string): string => prefix === '' ? leaf : `${prefix}/${leaf}``
    (recommended name `joinPathSegment`) + doc-comment; `import type { FilePath } from '../../../domain/objects/index.js';`
    only if the doc-comment references it (the body itself needs no import — params/return are `string`). Keep names
    distinct from family A's `joinPath`.
  - Edit `src/application/primitives/walk-submodules.ts`: DELETE the local `joinPath` (**L106-107**); ADD
    `import { <name> } from './internal/<module>.js';` (sibling `primitives/` → `primitives/internal/`); change the call
    site **L66** to `<name>(pathPrefix, entry.path) as FilePath` (cast already present).
  - Edit `src/application/primitives/walk-working-tree.ts`: DELETE the local `joinPath` (**L108-109**); ADD the same
    import; change call site **L87** from `const path = joinPath(prefix, entry.name);` to
    `const path = <name>(prefix, entry.name) as FilePath;` (cast moves from the deleted helper to the call site — same
    value). UNCHANGED: `directoryPath` (L105-106) and the bare lstat join `` `${config.ctx.layout.workDir}/${path}` ``
    (L101) — those are workDir joins, not family B; leave them (they are outside this expansion's two parts).
  - Edit `src/application/commands/mv.ts`: DELETE the local `joinPath` (**L327**); ADD
    `import { <name> } from '../primitives/internal/<module>.js';` (alongside the existing `../primitives/*` imports);
    change call site **L176** to `<name>(mode.destDir, basename(source)) as FilePath`. UNCHANGED: `workPath` (L332,
    a family-A workDir join in this file — NOT this expansion's scope) and `repath` (L311, a `slice`-based reparent).
  - Each file's helper-delete + call-site-edit must land in the **same commit** (build integrity — deleting a referenced
    local breaks the file mid-slice otherwise).
- Regression guard tests (run, expect green unchanged): `test/unit/application/primitives/walk-submodules.test.ts`
  (root + recursive depth-1 path assertions — both guard branches), `test/unit/application/primitives/walk-working-tree.test.ts`
  (root + nested path assertions — both branches), `test/unit/application/commands/mv.test.ts` (into-dir moves — non-empty
  branch + exact `to:` strings); plus the `mv` interop suite if present.
- TDD note: behaviour-preserving; the existing assertions already exercise both guard branches and the template (see Test
  strategy).
- Gate: `npm run validate` green; scoped mutation on the new module + the three touched files shows 0 new survivors. If a
  survivor appears on the new module, add the two-case targeted test (safety net) in this slice.

### Out of scope (scope expansion)

- **Family A's already-landed work** — `join-working-tree-path.ts`, `write-working-tree-file.ts`,
  `apply-sparse-checkout.ts`, `apply-changeset.ts` are NOT re-touched, except that `working-tree.ts` (Part 1) *imports*
  the family-A `joinPath` from `join-working-tree-path.ts` — an import add, not a re-touch of the module's contents.
- **`mv.ts`'s `workPath` (L332)** and **`walk-working-tree.ts`'s bare lstat join (L101) / `directoryPath` (L105-106)** —
  these are family-A workDir-onto-relative joins, not the family-B path-segment join this expansion unifies. They are a
  separate (already-landed or not-in-this-PR) concern; untouched here to keep scope bounded.
- **`moveNode`'s absolute-fragment join (`working-tree.ts:130`)** — joins two already-absolute fragments; neither family;
  untouched.
- **Any behaviour change, public surface, option, or on-disk-state change** — none. Pure internal de-duplication;
  `api.json`, command surfaces, refusal conditions, reflogs, structured output untouched (ADR-249/226 unaffected).
