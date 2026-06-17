# Plan — unify the working-tree-write `joinPath` into one dedicated module

> Source: design doc `docs/design/unify-sparse-checkout-joinpath.md` · ADRs `357`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: coverage/interop/property tests fold
  into the implementation slice whose code they exercise.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Orientation for every slice (read once, applies to all)

This is a **behaviour-preserving internal refactor** (ADR-357). It establishes ONE
dedicated module — `src/application/primitives/internal/join-working-tree-path.ts` — as
the single home of the working-tree-write `joinPath`, and routes all former copies
through it. **No new git behaviour, no new test file** (design D4: the relocated
`joinPath`'s mutants are killed transitively by existing tests; the scoped-mutation slice
gate is the safety net).

**TDD framing — there is NO new failing RED test.** "Behaviour-preserving" means the
named suites are GREEN *before* the edit and MUST stay GREEN *unchanged* afterward
(changing a test would mask a regression). The "RED→GREEN" beat is replaced by:
*existing named suites green before → same suites still green after, unchanged*. The
slice's correctness gate is: named suites still green + `npm run validate` clean + scoped
mutation (`npm run test:mutation` over the touched src file) shows 0 new survivors (the
deleted non-collapsing branches REDUCE surface). Do NOT write a new test unless the
scoped mutation gate surfaces a survivor on the new file (then add the targeted test in
that slice — this is the safety net, not the expectation).

**No public-surface gates trip — verified, do not chase phantoms.** `joinPath` and the new
module live in `primitives/internal/` and are INTERNAL symbols consumed only within `src/`.
There is no `Repository` method, no exported error code, no package-entry re-export, no new
Tier-1 command. So NONE of the project's surface gates apply: no barrel/facade edit (the
`internal/` directory has no `index.ts` and never gets one — siblings import by direct
path), no `repository.test` snapshot, no `docs/use/commands` page, no browser scenario, no
README count, no `api.json` / typedoc regeneration. Confirmed against the current tree:
`find_referencing_symbols` on `joinPath` shows exactly two in-file callers plus
`apply-changeset.ts`, and no barrel re-exports it. **Do NOT regenerate `reports/api.json`
and do NOT touch any doc/README surface for this change.**

**Verified ground facts (checked against current code via Serena + grep, this worktree):**
- `src/application/primitives/internal/` has **no `index.ts`** barrel; siblings import each
  other by direct relative path (e.g. `serialize-and-hash.js`, `read-blob.js` style).
- `FilePath` is re-exported through `../../../domain/objects/index.js` (via
  `export * from './object-id.js'` at `domain/objects/index.ts:43`). The new module's type
  import `import type { FilePath } from '../../../domain/objects/index.js';` is the SAME
  specifier `write-working-tree-file.ts:9` already uses.
- The new file `join-working-tree-path.ts` does **not** yet exist.
- The three OTHER `joinPath` definitions — `primitives/walk-submodules.ts:106`,
  `primitives/walk-working-tree.ts:108`, `commands/mv.ts:327` — are a **different** join
  (path-segment → repo-relative `FilePath` for tree-walk prefixing), NOT a workdir-onto-
  relative absolute-path join. They are **OUT OF SCOPE — DO NOT TOUCH THEM.**

**Build-integrity constraint (why the two slices are ordered as they are):** deleting the
`joinPath` definition from `write-working-tree-file.ts` while `apply-changeset.ts` still
imports it from there breaks the build. Therefore the new-module creation + the
`write-working-tree-file.ts` repoint + the `apply-changeset.ts` repoint MUST be ONE atomic
slice (Slice 1). Slice 2 (the sparse command repoint) is independent of build integrity but
is split out to keep each diff single-purpose and gate the helper-home move separately from
the command repoint (design slicing hint — recommended split). Slices share one working
tree and run sequentially; Slice 2 builds on Slice 1's landed module.

## Slice 1 — extract the module, repoint the helper's home + `apply-changeset`, fold the 4th copy

### Context

Behaviour-preserving move of the shared collapsing `joinPath` out of
`write-working-tree-file.ts` into a new dedicated module, plus repointing its only external
importer (`apply-changeset.ts`) and folding `removeWorkingTreeFile`'s inline 4th copy onto
the helper. Atomic for build integrity (see Orientation). The symbol body is byte-identical;
no logic changes.

**(A) CREATE `src/application/primitives/internal/join-working-tree-path.ts` (new file).**
Holds the collapsing helper *verbatim* (the exact body lifted from
`write-working-tree-file.ts:35-36`), with its doc-comment, depending only on the `FilePath`
brand. Full file contents:

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

The body (`workDir.endsWith('/') ? `${workDir}${path}` : `${workDir}/${path}``) and
signature (`(workDir: string, path: FilePath): string`) MUST be byte-identical to the
current shared helper — only the home and the doc-comment wording move.

**(B) EDIT `src/application/primitives/internal/write-working-tree-file.ts`** (current
contents, line-verified this worktree):
- **DELETE** the local `joinPath` definition and its doc-comment — **L30-36** (doc-comment
  L30-34 `/** Join a working-tree-relative … */`, helper L35-36 `export const joinPath = …`).
- **ADD** the sibling import `import { joinPath } from './join-working-tree-path.js';`
  (place it among the other `import` statements at the top; e.g. after the existing
  `import type { Context } …` at L10 — exact position is implementer's call, keep import
  grouping clean for Biome).
- **FOLD** `removeWorkingTreeFile` — **L95-98**. Replace the inline join at **L96**
  `const fullPath = \`${ctx.layout.workDir}/${path}\`;` with
  `const fullPath = joinPath(ctx.layout.workDir, path);`. (The function body is otherwise
  unchanged: `await rmIfExists(ctx, fullPath);`.)
- **UNCHANGED — verify, do NOT edit:** `writeWorkingTreeFile` (L65,
  `await writeRegularFile(ctx, joinPath(ctx.layout.workDir, path), content);`) and
  `writeWorkingTreeEntry` (L82, `const fullPath = joinPath(ctx.layout.workDir, path);`)
  already call `joinPath(ctx.layout.workDir, …)` — after the import they resolve to the
  imported symbol, no call-site change.
- **DO NOT re-export `joinPath`** from `write-working-tree-file.ts` — no indirection
  (design Requirement 2 / ADR-357 explicit "no re-export").

**(C) EDIT `src/application/primitives/apply-changeset.ts`.** Today **L29** is a single
import: `import { joinPath, rmIfExists, writeWorkingTreeEntry } from './internal/write-working-tree-file.js';`.
Split it into two:
```ts
import { rmIfExists, writeWorkingTreeEntry } from './internal/write-working-tree-file.js';
import { joinPath } from './internal/join-working-tree-path.js';
```
Call sites are **L94** (`const absPath = joinPath(workdir, entry.path);` in
`evaluateDirtyPath`) and **L158** (`const absPath = joinPath(workdir, entry.path);` in
`applyEntry`) — both **UNCHANGED**. (Design said L93/L157; verified-drift +1 → actual
L94/L158. The line numbers are only for orientation; the call expressions are unchanged
either way.)

**Files the implementer must NOT touch in this slice:** `apply-sparse-checkout.ts` (that is
Slice 2), and the three out-of-scope `joinPath` defs (`walk-submodules.ts`,
`walk-working-tree.ts`, `mv.ts`).

**Regression-guard suites (existing — run, expect GREEN unchanged; do NOT modify them):**
- `test/unit/application/primitives/internal/write-working-tree-file.test.ts` — drives the
  relocated `joinPath`'s **non-slash** branch via `writeWorkingTreeFile` /
  `writeWorkingTreeEntry` (the suite uses non-slash `DEFAULT_WORK_DIR = '/repo'`), and
  covers the folded `removeWorkingTreeFile` at **L355-385** (file-gone + no-op-on-absent).
- `test/unit/application/primitives/apply-changeset.test.ts` — imports the same `joinPath`
  (now from the new module); the import edit is invisible to its behaviour tests.
- Merge / stash interop suites guarding the folded `removeWorkingTreeFile` (its callers are
  `merge.ts` / `apply-merge-to-worktree.ts` / `stash.ts`):
  `test/integration/merge-interop.test.ts`, `test/integration/stash-interop.test.ts`.

### TDD steps

- **RED (not a new failing test — baseline):** before editing, run the guard suites and
  confirm they are GREEN —
  `npx vitest run test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/primitives/apply-changeset.test.ts`.
  This establishes the behaviour baseline the refactor must preserve.
- **GREEN (the refactor):** perform (A) create the new module, (B) edit
  `write-working-tree-file.ts` (delete def+comment L30-36, add sibling import, fold
  `removeWorkingTreeFile` L96), (C) split the `apply-changeset.ts` import (L29). Re-run the
  same guard suites — they MUST stay GREEN, unchanged. The relocated `joinPath`'s non-slash
  branch (and the `${workDir}/${path}` template mutant) is killed here by the writer tests;
  its slash branch is killed in Slice 2 by the sparse trailing-slash test.
- **REFACTOR:** none beyond the move itself — the symbol body is byte-identical. Confirm no
  stray `joinPath` definition remains in `write-working-tree-file.ts` and that it does NOT
  re-export `joinPath`.

### Gate

Slice gate (resolved from manifest `gates.slice`):
```
npx vitest run test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/merge-interop.test.ts test/integration/stash-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/join-working-tree-path.ts src/application/primitives/internal/write-working-tree-file.ts src/application/primitives/apply-changeset.ts
```
Phase-boundary (the implement-phase exit gate, after the slice): `npm run validate` green,
and `npm run test:mutation` scoped to `src/application/primitives/internal/write-working-tree-file.ts`
shows **0 new survivors** (the deleted non-collapsing inline *reduces* surface — folding
`removeWorkingTreeFile` onto the helper means its branch is now killed by the writer +
`removeWorkingTreeFile` tests).
**Expected, not a defect:** if you also mutate `join-working-tree-path.ts` in isolation at
THIS slice, its **slash** arm (`endsWith('/') === true`, the `${workDir}${path}` template)
will SURVIVE — no slash-`workDir` test reaches the new module yet (every Slice-1 importer's
test uses the non-slash `DEFAULT_WORK_DIR = '/repo'`). That survivor is **closed in Slice 2**
by the trailing-slash sparse test (L376-398), which then routes through this same symbol. So
do NOT add a dedicated slash test here to chase it — the cross-slice coverage is by design
(D4). The new module's **non-slash** arm IS killed here (writer tests). Only escalate /
add a test if `write-working-tree-file.ts`'s OWN surface shows an unexpected survivor.

### Commit

```
refactor: extract the shared working-tree-write joinPath into its own module
```

## Slice 2 — repoint the sparse command onto the shared module

### Context

Delete the private non-collapsing `joinPath` copy in the sparse-checkout apply engine and
import the shared collapsing helper from the module Slice 1 landed. Behaviour-preserving:
the harmlessness proof (design §"The harmlessness proof") shows the collapse difference is
unobservable — the sparse `joinPath` output feeds only `ctx.fs.exists` /
`isWorkingTreeDirty` (pure FS probes), never the `SparseMatcher` (which matches the
index-relative `entry.path`), and both adapters normalise `//`→`/`; the only diverging
input (`workDir` ending in `/`) is unreachable from production adapters.

**EDIT `src/application/commands/internal/apply-sparse-checkout.ts`** (current contents,
line-verified this worktree):
- **DELETE** the private `joinPath` — the doc-comment at **L54-58**
  (`/** Join a working-tree-relative path onto the workdir. A doubled separator … */`) and
  the helper at **L59** (`const joinPath = (workdir: string, rel: FilePath): string => \`${workdir}/${rel}\`;`).
- **ADD** `import { joinPath } from '../../primitives/internal/join-working-tree-path.js';`
  alongside the existing `../../primitives/*` imports (current import block L12-19; the
  `primitives/` imports are L16-18: `apply-changeset.js`, `compute-changeset.js`,
  `read-index.js`). Place the new import among those for clean Biome grouping.
- **UNCHANGED — verify, do NOT edit:** call site **L84**
  (`const absPath = joinPath(workdir, entry.path);` in `partition`) and call site **L140**
  (`const present = await ctx.fs.exists(joinPath(workdir, entry.path));` in
  `buildChangeset`). Signatures match — the deleted copy was `(workdir, rel: FilePath) =>
  string`, the shared helper is `(workDir: string, path: FilePath) => string`: same shape,
  same `FilePath` arg — so no call-site edit is needed.

**Note on the `FilePath` import in this file:** `apply-sparse-checkout.ts` imports
`FilePath` from `../../../domain/objects/object-id.js` (L13) — that is a DIFFERENT file's
own import and is **left untouched**. Only the new `joinPath` import is added; the new
module itself imports `FilePath` from `domain/objects/index.js` (Slice 1), which is fine —
the two specifiers both resolve `FilePath` (the index re-exports `object-id.js`).

**Files the implementer must NOT touch in this slice:** the Slice-1 files
(`join-working-tree-path.ts`, `write-working-tree-file.ts`, `apply-changeset.ts` — already
landed) and the three out-of-scope `joinPath` defs.

**Regression-guard suites (existing — run, expect GREEN unchanged; do NOT modify them):**
- `test/unit/application/commands/internal/apply-sparse-checkout.test.ts` — the full
  partition / changeset / skip-worktree / retained-dirty coverage, **including the
  trailing-slash `Context` test at L376-398** (`'Given a workdir path that ends with a
  slash' → 'Then working-tree paths still resolve'`). This test is the **load-bearing
  guard** for the **slash** branch of the relocated `joinPath`: after the edit it exercises
  the real `endsWith('/') === true` branch of the SHARED helper (against the deleted
  non-collapsing copy it only passed via adapter `//`-normalisation). RETAIN it unchanged.
- `test/integration/sparse-checkout.test.ts` (multi-adapter parity through memory; final
  `describe.skipIf` cross-checks index + pattern file against canonical `git`),
  `test/integration/sparse-checkout-file-interop.test.ts`,
  `test/integration/sparse-reset-merge.test.ts`.

### TDD steps

- **RED (not a new failing test — baseline):** before editing, run the guard suites and
  confirm GREEN —
  `npx vitest run test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/integration/sparse-checkout.test.ts test/integration/sparse-checkout-file-interop.test.ts test/integration/sparse-reset-merge.test.ts`.
  The trailing-slash unit test (L376-398) already passes against the private copy; it is the
  behaviour baseline.
- **GREEN (the refactor):** delete the private `joinPath` (doc-comment L54-58 + helper L59),
  add the import from `../../primitives/internal/join-working-tree-path.js`. Re-run the same
  guard suites — they MUST stay GREEN, unchanged. The trailing-slash test now drives the
  `endsWith('/') === true` branch of the shared helper (killing the `${workDir}${path}`
  template mutant on the new file).
- **REFACTOR:** none — pure delete + import. Confirm no `joinPath` definition remains in
  `apply-sparse-checkout.ts` and the two call sites are untouched.

### Gate

Slice gate (resolved from manifest `gates.slice`):
```
npx vitest run test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/integration/sparse-checkout.test.ts test/integration/sparse-checkout-file-interop.test.ts test/integration/sparse-reset-merge.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/apply-sparse-checkout.ts
```
Phase-boundary (after the slice): `npm run validate` green, and `npm run test:mutation`
scoped to `src/application/commands/internal/apply-sparse-checkout.ts` +
`src/application/primitives/internal/join-working-tree-path.ts` shows **0 new survivors**
(the deleted private branch *reduces* surface; the relocated helper's slash branch is now
killed by the trailing-slash test). If a survivor appears on `join-working-tree-path.ts`,
add the targeted test in THIS slice (D4 safety net) — otherwise add no test.

### Commit

```
refactor: route sparse-checkout through the shared working-tree-write joinPath
```
