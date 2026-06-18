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

## Sweep slices (scope expansion)

> Source: design doc `docs/design/unify-sparse-checkout-joinpath.md` § "Scope expansion (in-PR)" (REVISED for
> the full sweep) · ADR `358`. Slices 1 & 2 above are LANDED — do NOT re-touch them. This section appends the
> five sweep slices that close the "exactly ONE join per family" north star codebase-wide.
>
> **Orientation for every sweep slice (read once, applies to S1–S5).** This is a **behaviour-preserving internal
> refactor** (ADR-358) — no new git behaviour, no on-disk-state change, no public surface. Every touched symbol is
> INTERNAL (`primitives/internal/` + in-`src` callers); the family-A module and the new family-B module both live in
> `primitives/internal/`, which has **no `index.ts` barrel** — siblings import by direct relative path. **No public
> surface gate trips:** no barrel/facade edit, no `Repository` method, no `repository.test` snapshot, no
> `docs/use/commands` page, no browser scenario, no README count, no `api.json`/typedoc regeneration. **Do NOT
> regenerate `reports/api.json` and do NOT touch any doc/README surface for this change.**
>
> **TDD framing — there is NO new failing RED test.** "Behaviour-preserving" means the named home suites are GREEN
> *before* each edit and MUST stay GREEN *unchanged* afterward (changing a test would mask a regression). The
> "RED→GREEN" beat is replaced by *existing named suites green before → same suites still green after, unchanged*.
> Each slice's correctness gate is: named suites still green + `npm run validate` clean + `npm run test:mutation`
> scoped to the slice's touched src files shows **0 new survivors** (deleting/folding non-collapsing inlines REDUCES
> surface). Do **not** add a new test unless the scoped mutation gate surfaces a survivor on a touched file (then add
> the targeted test in that slice — the D4 safety net, not the expectation).
>
> **Harmlessness (applies to every family-A site).** The join's output flows only into a pure `ctx.fs.*` op (or, for
> `submodule-context`, a child-`Context` `workDir` field). `//` ≡ `/` under both adapters — memory `normalizePath`
> skips empty segments (`adapters/memory/memory-file-system.ts:508-509`), node `node:path` collapses redundant
> separators — and `ctx.layout.workDir` is never trailing-slash (`nodePath.resolve` strips it,
> `adapters/node/node-adapter.ts:40`; memory/browser use the slash-free `DEFAULT_WORK_DIR`/`ROOT_WORK_DIR`). So routing
> through the COLLAPSING `joinPath` is observationally byte-identical. The family-B `joinPathSegment` guards the empty
> prefix instead (`prefix === '' ? leaf : ...`); `mv`'s fold is safe because its `destDir` is provably never empty /
> leading-slash (`validateWorkingTreePath` rejects both).
>
> **Slice ordering / build integrity.** S1 lands **first** — it widens the `joinPath` signature (`path: FilePath` →
> `path: string`) that every later family-A sweep slice relies on (filenames/constants/constructed suffixes pass only
> after the widen). S2/S3/S4 are independent of each other after S1. S5 (family B) is independent of all of them. A
> local helper is deleted only in the **same commit** that removes its last in-file reference. All slices share one
> working tree and run sequentially.
>
> **Verified-ground note (checked against current code this worktree, lines may still drift — re-grep at slice time):**
> all S1–S5 file/line/symbol references below were confirmed. Two drift corrections folded in: the new
> `join-path-segment.ts` does **not** yet exist; `submodule-context.ts` carries an *unrelated* pre-existing Stryker
> disable on its `homeDir` conditional (the `...homeDir...` spread) — that disable is **NOT** the family-A join on L16
> and must stay untouched. Guard-test path asymmetry confirmed: `read-gitignore.test.ts` lives under
> `test/unit/application/commands/internal/`, but `read-gitattributes.test.ts` lives under
> `test/unit/application/primitives/internal/` — use the exact paths in each gate.

## Slice S1 — widen `joinPath` signature + fold the two named twins (`repoPath`, `workPath`)

### Context

The enabler slice. Widen the landed family-A `joinPath` 2nd param from `FilePath` to `string` (strictly more
permissive — `FilePath ⊂ string`, so the three already-landed callers in `write-working-tree-file.ts` /
`apply-changeset.ts` / `apply-sparse-checkout.ts` stay type-assignable with ZERO body edits, verified), then fold the
two named twin helpers `repoPath` and `workPath` into thin wrappers that delegate to `joinPath` (D-TWINS (a) — keep the
`ctx → ctx.layout.workDir` projection sugar; call sites untouched). No logic changes; the join body lives in exactly
one place after this.

**(A) EDIT `src/application/primitives/internal/join-working-tree-path.ts`** (verified this worktree):
- **WIDEN** the signature at **L9**: change `(workDir: string, path: FilePath): string` → `(workDir: string, path: string): string`. Body (**L10** `workDir.endsWith('/') ? \`${workDir}${path}\` : \`${workDir}/${path}\``) is UNCHANGED.
- **DELETE** the now-unused `import type { FilePath } from '../../../domain/objects/index.js';` at **L1** (it is referenced ONLY by the param type being widened — confirm no other use in the file before deleting).
- **UPDATE the doc-comment (L3-8)** wording: replace any "index-relative `FilePath`" phrasing with "a working-tree path" (the 2nd operand is now any `string` — a `FilePath`, filename, constant, or constructed suffix). Why-comment only; keep it brief.

**(B) EDIT `src/application/commands/internal/working-tree.ts`** (verified this worktree):
- **CHANGE** `repoPath`'s body at **L24**. Current: `const repoPath = (ctx: Context, path: FilePath): string => \`${ctx.layout.workDir}/${path}\`;`. New body: `const repoPath = (ctx: Context, path: FilePath): string => joinPath(ctx.layout.workDir, path);` (keep the `(ctx, path)` signature; only the body delegates).
- **ADD** `import { joinPath } from '../../primitives/internal/join-working-tree-path.js';` among the top imports (current import block **L1-10**; `commands/internal → primitives/internal` is a legal, already-used direction). Keep Biome import grouping clean.
- **UNCHANGED — verify, do NOT edit:** the five `repoPath` call sites (**L49** `const dst = repoPath(ctx, path);`, **L81** `return ctx.fs.read(repoPath(ctx, path));`, **L91** `const full = repoPath(ctx, path);`, **L123** `await moveNode(ctx, repoPath(ctx, from), repoPath(ctx, to));` — two calls); `validatePath` export (**L22**); and **`moveNode`'s `\`${fromAbs}/${child.name}\`` join (L130)** — an absolute-fragment join, NOT family A, leave it.

**(C) EDIT `src/application/commands/mv.ts`** (verified this worktree):
- **CHANGE** `workPath`'s body at **L332**. Current: `const workPath = (ctx: Context, path: FilePath): string => \`${ctx.layout.workDir}/${path}\`;`. New body: `const workPath = (ctx: Context, path: FilePath): string => joinPath(ctx.layout.workDir, path);`.
- **ADD** `import { joinPath } from '../primitives/internal/join-working-tree-path.js';` among the top imports (current block **L12-34**; `commands/ → primitives/internal/` path is `../primitives/internal/`). **Name-clash caution:** this file ALSO has a LOCAL `joinPath` (the family-B one at **L327**, handled in S5) — importing a symbol named `joinPath` while a local `const joinPath` exists is a redeclaration conflict. In THIS slice the family-B local is still present, so **import the family-A `joinPath` under an alias** to avoid the clash: `import { joinPath as joinWorkPath } from '../primitives/internal/join-working-tree-path.js';` and write `workPath`'s body as `joinWorkPath(ctx.layout.workDir, path)`. (S5 deletes the local family-B `joinPath`; a later cleanup could drop the alias, but the alias is correct and safe to leave — do NOT rename the family-B local in this slice.)
- **UNCHANGED — verify, do NOT edit:** `workPath`'s call site (**L338** `ctx.fs.lstat(workPath(ctx, path)).catch(...)`); the local family-B `joinPath` (**L327**) and its call site (**L176**); `repath` (**L311**).

**Files the implementer must NOT touch in this slice:** the three landed family-A callers' bodies
(`write-working-tree-file.ts`, `apply-changeset.ts`, `apply-sparse-checkout.ts` — confirm they still type-check after
the widen, but edit nothing), and every S2–S5 site.

**Regression-guard suites (existing — run, expect GREEN unchanged; do NOT modify):**
- `test/unit/application/commands/internal/working-tree.test.ts` — drives `repoPath` via `renameInWorkingTree` / `materializeFile` / `readFile` / `removeFile` (asserts concrete written/read paths → kills the wrapper-delegation mutant).
- `test/unit/application/commands/mv.test.ts` — drives `workPath` via the `lstatOrUndefined` path.
- The landed-`joinPath` guard suites (prove the widen didn't regress them): `test/unit/application/primitives/internal/write-working-tree-file.test.ts`, `test/unit/application/commands/internal/apply-sparse-checkout.test.ts`, `test/unit/application/primitives/apply-changeset.test.ts`.

### TDD steps

- **RED (not a new failing test — baseline):** before editing, run the guard suites and confirm GREEN — `npx vitest run test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/mv.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/unit/application/primitives/apply-changeset.test.ts`. This is the behaviour baseline the refactor must preserve.
- **GREEN (the refactor):** perform (A) widen `joinPath` + drop the `FilePath` import + reword the doc-comment, (B) delegate `repoPath` + add import, (C) delegate `workPath` + add the **aliased** import. Re-run the same guard suites — they MUST stay GREEN, unchanged. The widen adds NO runtime branch (it removes a type constraint only), so it introduces no new mutant; both `joinPath` branches stay killed by the landed writer/sparse tests.
- **REFACTOR:** none beyond the delegation. Confirm no stray inline `\`${ctx.layout.workDir}/${path}\`` remains in `repoPath` / `workPath`, and that the family-A `joinPath` body lives only in `join-working-tree-path.ts`.

### Gate

Slice gate (resolved from manifest `gates.slice`):
```
npx vitest run test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/mv.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/unit/application/primitives/apply-changeset.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/join-working-tree-path.ts src/application/commands/internal/working-tree.ts src/application/commands/mv.ts
```
Phase-boundary: `npm run validate` green, and `npm run test:mutation` scoped to `src/application/primitives/internal/join-working-tree-path.ts` + `src/application/commands/internal/working-tree.ts` + `src/application/commands/mv.ts` shows **0 new survivors**. The two wrapper bodies' only mutant is swapping the delegation, killed by any home-suite test asserting a concrete path.

### Commit

```
refactor: widen the working-tree joinPath and fold the repoPath/workPath twins onto it
```

## Slice S2 — sweep the primitives inline FS join sites

### Context

Route every remaining hand-inlined `\`${ctx.layout.workDir}/${…}\`` in the `primitives/` layer onto the unified family-A
`joinPath` (landed + widened in S1). Each site's output flows only into a pure `ctx.fs.*` op — byte-identical by the
harmlessness note. Builds on S1.

**EDIT these four files** (verified this worktree — re-grep `layout\.workDir\}/` in each at slice time):
- `src/application/primitives/snapshot/workdir-entry.ts` — **L81** `\`${ctx.layout.workDir}/${row.path}\`` (fed to `ctx.fs.read` / `readSymlinkBytes` / `readlink` / `liveStat`) → `joinPath(ctx.layout.workDir, row.path)`. ADD `import { joinPath } from '../internal/join-working-tree-path.js';` (this file is in `primitives/snapshot/`, so `../internal/`).
- `src/application/primitives/find-would-overwrite.ts` — **L76** `\`${ctx.layout.workDir}/${path}\`` (fed to `ctx.fs.lstat`) → `joinPath(ctx.layout.workDir, path)`. ADD `import { joinPath } from './internal/join-working-tree-path.js';` (this file is directly in `primitives/`, so `./internal/`).
- `src/application/primitives/compare-working-tree-entry.ts` — **L59** `\`${ctx.layout.workDir}/${entry.path}\`` (fed to `ctx.fs.lstat` / `readlink` / `read`) → `joinPath(ctx.layout.workDir, entry.path)`. ADD `import { joinPath } from './internal/join-working-tree-path.js';`.
- `src/application/primitives/walk-working-tree.ts` — **two family-A sites here**:
  - **L101** inline `\`${config.ctx.layout.workDir}/${path}\`` (fed to `config.ctx.fs.lstat`) → `joinPath(config.ctx.layout.workDir, path)`.
  - **`directoryPath` L105-106** — current: `const directoryPath = (config: WalkConfig, prefix: string): string => prefix === '' ? config.ctx.layout.workDir : \`${config.ctx.layout.workDir}/${prefix}\`;`. **FOLD ONLY THE NON-EMPTY BRANCH:** `prefix === '' ? config.ctx.layout.workDir : joinPath(config.ctx.layout.workDir, prefix)`. The empty branch MUST stay the bare `config.ctx.layout.workDir` — `joinPath(workDir, '')` would yield a trailing slash, NOT byte-identical. Leave the empty arm exactly as-is.
  - ADD `import { joinPath } from './internal/join-working-tree-path.js';`. **DO NOT touch** the LOCAL family-B `joinPath` (**L108-109**) — that is a different join, swept in S5. Importing family-A `joinPath` while a local `joinPath` exists is a redeclaration conflict, so in THIS slice **import family-A under an alias** to dodge the clash: `import { joinPath as joinWorkTreePath } from './internal/join-working-tree-path.js';` and use `joinWorkTreePath(...)` at L101 + the `directoryPath` non-empty branch. (S5 deletes the family-B local; the alias is correct and safe to leave.)

**Confirm the relative-path depths** at slice time: `snapshot/` → `../internal/...`; files directly in `primitives/` → `./internal/...`.

**Regression-guard suites (existing — run, expect GREEN unchanged; do NOT modify):**
- `test/unit/application/primitives/snapshot/workdir-entry.test.ts` (+ its `.mutation.test.ts` sibling).
- `test/unit/application/primitives/find-would-overwrite.test.ts`.
- `test/unit/application/primitives/compare-working-tree-entry.test.ts`.
- `test/unit/application/primitives/walk-working-tree.test.ts` — root names + nested `a/b/c.txt` (drives `directoryPath` non-empty AND empty branches + the L101 lstat join).
- Integration coverage that drives these primitives: `test/integration/status-interop.test.ts` (status walks the tree).

### TDD steps

- **RED (baseline):** run the guard suites, confirm GREEN — `npx vitest run test/unit/application/primitives/snapshot/workdir-entry.test.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/walk-working-tree.test.ts`.
- **GREEN (the refactor):** route each inline join to `joinPath` (aliased in `walk-working-tree.ts`), fold ONLY `directoryPath`'s non-empty branch. Re-run the same suites — GREEN, unchanged.
- **REFACTOR:** none. Confirm `directoryPath`'s empty branch still returns bare `workDir`; confirm the family-B local in `walk-working-tree.ts` is untouched.

### Gate

Slice gate (resolved from manifest `gates.slice`):
```
npx vitest run test/unit/application/primitives/snapshot/workdir-entry.test.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/walk-working-tree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/snapshot/workdir-entry.ts src/application/primitives/find-would-overwrite.ts src/application/primitives/compare-working-tree-entry.ts src/application/primitives/walk-working-tree.ts
```
Phase-boundary: `npm run validate` green, and `npm run test:mutation` scoped to the four touched files shows **0 new survivors** (especially confirm `directoryPath`'s preserved empty branch and the non-empty fold are both killed by `walk-working-tree.test.ts`).

### Commit

```
refactor: route the primitives working-tree FS joins through the shared joinPath
```

## Slice S3 — sweep the commands inline FS join sites

### Context

Route every remaining hand-inlined `\`${ctx.layout.workDir}/${…}\`` in the `commands/` layer onto the unified family-A
`joinPath`. Each site is a pure FS consumer — byte-identical by the harmlessness note. The constant-`GITMODULES_FILE` and
constructed-`\`${path}/.git\`` sites pass only after S1's signature widen. Builds on S1.

**EDIT these five files** (verified this worktree — re-grep at slice time). All are in `commands/`, so the import is
`import { joinPath } from '../primitives/internal/join-working-tree-path.js';` (add once per file, Biome-grouped). For
each, replace the inline template with `joinPath(ctx.layout.workDir, <2nd-operand>)`:
- `src/application/commands/status.ts` — **L314** `\`${ctx.layout.workDir}/${path}\`` (→ `ctx.fs.lstat(...).catch(...)`).
- `src/application/commands/blame.ts` — **L173** `\`${ctx.layout.workDir}/${path}\`` (→ `lstat` / `read` / `readlink`).
- `src/application/commands/stash.ts` — **L120** `\`${ctx.layout.workDir}/${path}\`` (read/readlink); **L158** `\`${ctx.layout.workDir}/${entry.path}\`` (lstat → `hashFileAt`); **L366** `\`${ctx.layout.workDir}/${path}\`` (exists).
- `src/application/commands/add.ts` — **L129** (lstat→catch); **L312** (lstat→catch→'missing'); **L328** (lstat type-change); **L357** (readlink) — all `\`${ctx.layout.workDir}/${path}\``.
- `src/application/commands/submodule.ts` — **L90** `\`${ctx.layout.workDir}/${GITMODULES_FILE}\`` (exists); **L360** `\`${ctx.layout.workDir}/${path}\`` (exists/readdir/rmRecursive/mkdir); **L504** `\`${ctx.layout.workDir}/${GITMODULES_FILE}\`` (exists/readUtf8/writeUtf8); **L533** `\`${ctx.layout.workDir}/${path}\`` (lstat → `indexEntryFromStat`); **L538** `\`${ctx.layout.workDir}/${GITMODULES_FILE}\`` (lstat → `indexEntryFromStat`); **L571** `\`${ctx.layout.workDir}/${path}/.git\`` (writeUtf8). **L90/L504/L538 join the CONSTANT `GITMODULES_FILE`** (a `string`, defined locally ~L69) and **L571 joins a CONSTRUCTED `\`${path}/.git\`` suffix** (a `string`) — both pass only after S1's widen: `joinPath(ctx.layout.workDir, GITMODULES_FILE)` and `joinPath(ctx.layout.workDir, \`${path}/.git\`)`.

**No name-clash** in these five files (none defines a local `joinPath`) — import the symbol directly, unaliased.

**Regression-guard suites (existing — run, expect GREEN unchanged; do NOT modify):**
- Unit: `test/unit/application/commands/status.test.ts`, `blame.test.ts`, `stash.test.ts`, `add.test.ts`, `submodule.test.ts` (+ `submodule-add.test.ts`).
- Integration/interop: `test/integration/status-interop.test.ts`, `blame-interop.test.ts`, `stash-interop.test.ts`, `add-interop.test.ts`, `add-add-content-interop.test.ts`, `add-all.test.ts`, `submodule-init-sync-deinit-interop.test.ts`, `submodules.test.ts`.

### TDD steps

- **RED (baseline):** run the unit guard suites, confirm GREEN — `npx vitest run test/unit/application/commands/status.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/submodule.test.ts`.
- **GREEN (the refactor):** route each of the 15 inline joins (across the 5 files) to `joinPath`, add one import per file. Re-run the same suites — GREEN, unchanged.
- **REFACTOR:** none. Confirm no `\`${ctx.layout.workDir}/…\`` template remains in the five files (re-grep `layout\.workDir\}/` over them returns nothing).

### Gate

Slice gate (resolved from manifest `gates.slice`):
```
npx vitest run test/unit/application/commands/status.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/submodule.test.ts test/unit/application/commands/submodule-add.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/status.ts src/application/commands/blame.ts src/application/commands/stash.ts src/application/commands/add.ts src/application/commands/submodule.ts
```
Phase-boundary: `npm run validate` green, and `npm run test:mutation` scoped to the five touched files shows **0 new survivors**.

### Commit

```
refactor: route the command working-tree FS joins through the shared joinPath
```

## Slice S4 — sweep the variant sites (DELICATE — Stryker-disable narrowing)

### Context

The bespoke family-A sites: `run-hook`'s relative-`hooksPath` branch, the conditional `read-gitignore` /
`read-gitattributes` paths, and `submodule-context`'s child-`Context` `workDir` construction. Each gets a one-line
byte-identity argument (design § "Harmlessness proof (Part 1)"). **This is the delicate slice:** the
`read-gitignore` Stryker-disable must NARROW, driven by a scoped mutation run. Builds on S1.

**EDIT these four files** (verified this worktree — re-grep at slice time):

1. `src/application/primitives/run-hook.ts` — **L41** `return \`${layout.workDir}/${hooksPath}\`;` (the relative-`hooksPath` branch of `resolveHooksDir`; `hooksPath` is a non-empty relative `string` here — the `''`/`~/`/absolute branches are handled above it). → `return joinPath(layout.workDir, hooksPath);`. Passes only after S1's widen (`hooksPath` is `string`). ADD `import { joinPath } from './internal/join-working-tree-path.js';` (file is in `primitives/`). No name-clash.

2. `src/application/primitives/internal/read-gitignore.ts` — current **L20-21**: `const path = dir === '' ? \`${ctx.layout.workDir}/.gitignore\` : \`${ctx.layout.workDir}/${dir}/.gitignore\`;`. → `const path = joinPath(ctx.layout.workDir, dir === '' ? '.gitignore' : \`${dir}/.gitignore\`);`. ADD `import { joinPath } from './join-working-tree-path.js';` (file is in `primitives/internal/`).
   - **STRYKER-DISABLE NARROWING (the delicate part).** **L19** carries a pre-existing `// Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — the false branch yields \`${workDir}//.gitignore\`; node + memory FS path normalisation collapse the empty segment, so the file resolves to the identical location.`. After the rewrite the conditional moves to the 2nd operand. The `ConditionalExpression` half **stays equivalent** (both arms still resolve to the same file via FS `//`-normalisation — flipping it is still equivalent), so RE-POINT it (keep `ConditionalExpression`, update the comment text to describe the new shape). The `StringLiteral` half **changes shape**: after the rewrite the literals are `'.gitignore'` and `\`${dir}/.gitignore\``; a `StringLiteral` mutant on `'.gitignore'` (e.g. emptying it) now produces a *genuinely wrong* path — **likely no longer equivalent**. **The slice MUST run the scoped mutation run to decide:** if the `'.gitignore'` literal mutant is killed by an existing root-load test (`read-gitignore.test.ts` asserts the root `.gitignore` is loaded — L46-62, L402-419), **DROP the `StringLiteral` token from the disable**, keeping only `// Stryker disable next-line ConditionalExpression: …`. Net: the disable **NARROWS** (it does not get re-introduced wholesale). Only keep a token under explicit user approval if a provably-equivalent survivor remains. **Do NOT add a provenance/phase ref to the comment.** Flag this change for the reviewer.

3. `src/application/primitives/internal/read-gitattributes.ts` — current **L25-27**: `dir === '' ? \`${ctx.layout.workDir}/.gitattributes\` : \`${ctx.layout.workDir}/${dir}/.gitattributes\`` (inside a `loadAndParse(ctx, …)` call). → `joinPath(ctx.layout.workDir, dir === '' ? '.gitattributes' : \`${dir}/.gitattributes\`)`. ADD `import { joinPath } from './join-working-tree-path.js';`. **This file has NO Stryker disable today — ADD NONE.** Rely on the existing `read-gitattributes.test.ts` (root + nested cases) to kill both branches + the literals; if a genuine survivor appears, ESCALATE to the user rather than silencing it.

4. `src/application/primitives/internal/submodule-context.ts` — **L16** `const workDir = \`${ctx.layout.workDir}/${treeRelPath}\`;` — this CONSTRUCTS the child `Context`'s `layout.workDir`/`cwd` (a layout field), **NOT an immediate FS access**. → `const workDir = joinPath(ctx.layout.workDir, treeRelPath);`. ADD `import { joinPath } from './join-working-tree-path.js';`. Byte-identical (`treeRelPath` is a validated non-empty `FilePath`, no trailing slash). **Flag in the commit body as a layout-field construction, not an FS access.** **DO NOT touch** the UNRELATED pre-existing Stryker disable on the `homeDir` conditional (~L24, the `...(ctx.layout.homeDir !== undefined ? …)` spread) — that is a different mutant on a different line; leave it verbatim.

**Regression-guard suites (existing — run, expect GREEN unchanged; do NOT modify):**
- `test/unit/application/primitives/run-hook.test.ts` — the relative-`hooksPath` case (resolves against the working-tree root).
- `test/unit/application/commands/internal/read-gitignore.test.ts` — **path asymmetry: this one lives under `commands/internal/`** — root `dir===''` load (L46-62, L402-419, the literal pins) + nested-dir load (L64-79). The root-load assertion is the kill that lets the `StringLiteral` disable narrow.
- `test/unit/application/primitives/internal/read-gitattributes.test.ts` — **this one lives under `primitives/internal/`** — root `.gitattributes` (L41-55) + nested (L74-89).
- `test/unit/application/primitives/internal/submodule-context.test.ts` — asserts the child `layout.workDir` equals `\`${ctx.layout.workDir}/libs/a\`` (L17-29). Plus the submodule walk/status/add suites that build + read through a child Context.

### TDD steps

- **RED (baseline):** run the guard suites, confirm GREEN — `npx vitest run test/unit/application/primitives/run-hook.test.ts test/unit/application/commands/internal/read-gitignore.test.ts test/unit/application/primitives/internal/read-gitattributes.test.ts test/unit/application/primitives/internal/submodule-context.test.ts`.
- **GREEN (the refactor):** route the four variant sites to `joinPath` (folding the conditional to the 2nd operand for the two `read-git*` files, keeping `directoryPath`-style empty handling N/A here). Re-run the same suites — GREEN, unchanged.
- **MUTATION-DRIVEN DECISION (the delicate beat):** run `npm run test:mutation` scoped to `read-gitignore.ts`. If the `'.gitignore'` `StringLiteral` mutant is KILLED, narrow the L19 disable to `ConditionalExpression` only (drop `StringLiteral`). If it SURVIVES and is provably equivalent, escalate to the user before keeping the token. Re-run scoped mutation on `read-gitattributes.ts` — confirm NO survivor needs a disable (add none).
- **REFACTOR:** none beyond the routing + the disable narrowing.

### Gate

Slice gate (resolved from manifest `gates.slice`):
```
npx vitest run test/unit/application/primitives/run-hook.test.ts test/unit/application/commands/internal/read-gitignore.test.ts test/unit/application/primitives/internal/read-gitattributes.test.ts test/unit/application/primitives/internal/submodule-context.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/run-hook.ts src/application/primitives/internal/read-gitignore.ts src/application/primitives/internal/read-gitattributes.ts src/application/primitives/internal/submodule-context.ts
```
Phase-boundary: `npm run validate` green, and `npm run test:mutation` scoped to the four touched files shows **0 new survivors**. **Explicitly confirm:** (a) the rewritten `read-gitignore` `StringLiteral` mutants are killed → disable narrowed to `ConditionalExpression`; (b) `read-gitattributes` introduces no survivor needing a disable.

### Commit

```
refactor: route the working-tree variant joins through the shared joinPath and narrow the gitignore disable
```

## Slice S5 — extract `joinPathSegment`, route the three family-B callers

### Context

Family B — a **different** join (repo-relative `prefix` + `leaf` → repo-relative `FilePath`; guards the empty prefix
rather than collapsing a trailing slash). Unify the three local `joinPath` copies into one shared, distinctly-named
`joinPathSegment` so the two families are never conflated. Independent of S1–S4. `mv`'s fold is behaviour-preserving:
its `destDir` is provably never empty / leading-slash (`mv.ts:103` `validatePath(stripTrailingSlash(destination))` →
`validateWorkingTreePath` rejects `''` and leading-`/`; `destDir` is assigned only from that), so the guard's
empty-branch is structurally unreachable for `mv` — the else-branch `\`${dir}/${leaf}\`` is exactly `mv`'s current join.
The other two callers already carry the identical guard.

**(A) CREATE `src/application/primitives/internal/join-path-segment.ts` (new file — confirmed does NOT yet exist).**
No import needed (params + return are plain `string`). Full contents:
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
Both params typed `string` — accepts the walkers' `string` prefixes and `mv`'s `FilePath` `dir` by assignability
(`FilePath ⊂ string`).

**(B) EDIT `src/application/primitives/walk-submodules.ts`** (verified this worktree):
- **DELETE** the local family-B `joinPath` (**L106-107**: `const joinPath = (prefix: string, leaf: string): string => prefix === '' ? leaf : \`${prefix}/${leaf}\`;`).
- **ADD** `import { joinPathSegment } from './internal/join-path-segment.js';` (file is in `primitives/`).
- **EDIT** call site **L66**: `const fullPath = joinPath(pathPrefix, entry.path) as FilePath;` → `const fullPath = joinPathSegment(pathPrefix, entry.path) as FilePath;` (the `as FilePath` cast is already present — keep it).

**(C) EDIT `src/application/primitives/walk-working-tree.ts`** (verified this worktree):
- **DELETE** the local family-B `joinPath` (**L108-109**: `const joinPath = (prefix: string, name: string): FilePath => (prefix === '' ? name : \`${prefix}/${name}\`) as FilePath;`).
- **ADD** `import { joinPathSegment } from './internal/join-path-segment.js';`.
- **EDIT** call site **L87**: `const path = joinPath(prefix, entry.name);` → `const path = joinPathSegment(prefix, entry.name) as FilePath;` (the cast moves from the deleted helper's body to the call site — net byte-identical value).
- **UNCHANGED — verify, do NOT edit:** `directoryPath` (L105-106) and the L101 lstat join — those are family A, already swept in S2. **Note:** if S2 added an aliased family-A `joinPath as joinWorkTreePath` import, leave it; this slice only removes the family-B local and adds the `joinPathSegment` import.

**(D) EDIT `src/application/commands/mv.ts`** (verified this worktree):
- **DELETE** the local family-B `joinPath` (**L327**: `const joinPath = (dir: FilePath, leaf: string): FilePath => \`${dir}/${leaf}\` as FilePath;`).
- **ADD** `import { joinPathSegment } from '../primitives/internal/join-path-segment.js';` (file is in `commands/`).
- **EDIT** call site **L176**: `joinPath(mode.destDir, basename(source))` → `joinPathSegment(mode.destDir, basename(source)) as FilePath` (move the cast to the call site — the deleted helper used to cast internally).
- **UNCHANGED — verify, do NOT edit:** `workPath` (folded in S1; if S1 aliased the family-A import as `joinWorkPath`, leave it) and `repath` (L311). Deleting the local `joinPath` here removes the S1 alias's reason-to-exist but the alias stays valid — do NOT touch the S1 `joinWorkPath` import in this slice.

Each file's helper-delete + call-site edit lands in the **same commit** (build integrity).

**Regression-guard suites (existing — run, expect GREEN unchanged; do NOT modify):**
- `test/unit/application/primitives/walk-submodules.test.ts` — root depth-0 → bare leaf; recursive depth-1 → `vendor/foo/nested/bar` (kills the empty-true branch, the non-empty branch, and the `/`-template mutant via exact-string `toEqual`).
- `test/unit/application/primitives/walk-working-tree.test.ts` — root → bare name (`['a.txt','b.txt']`); nested → `['a/b/c.txt','a/d.txt','e.txt']`.
- `test/unit/application/commands/mv.test.ts` — into-dir → `to: 'dir/a.txt'` (L101) and `to: 'dest/src/f.txt'` (L180), each from `joinPathSegment(mode.destDir, basename(source))` with a non-empty `destDir`.
- Integration: the `mv` interop suite (search `test/integration/` for `mv`-parity).

### TDD steps

- **RED (baseline):** run the guard suites, confirm GREEN — `npx vitest run test/unit/application/primitives/walk-submodules.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/commands/mv.test.ts`.
- **GREEN (the refactor):** create `join-path-segment.ts`, delete each local family-B `joinPath`, add the `joinPathSegment` import per file, repoint each call site (casts at the call sites). Re-run the same suites — GREEN, unchanged. The empty-true branch is killed by the root-level walk assertions; the non-empty branch + template by the nested / into-dir exact-string assertions.
- **REFACTOR:** none. Confirm no local family-B `joinPath` remains in the three callers and `join-path-segment.ts` is the sole definition.

### Gate

Slice gate (resolved from manifest `gates.slice`):
```
npx vitest run test/unit/application/primitives/walk-submodules.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/commands/mv.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/join-path-segment.ts src/application/primitives/walk-submodules.ts src/application/primitives/walk-working-tree.ts src/application/commands/mv.ts
```
Phase-boundary: `npm run validate` green, and `npm run test:mutation` scoped to `src/application/primitives/internal/join-path-segment.ts` + `src/application/primitives/walk-submodules.ts` + `src/application/primitives/walk-working-tree.ts` + `src/application/commands/mv.ts` shows **0 new survivors**. **Safety net:** if a survivor appears on `join-path-segment.ts`, add a targeted two-case `test/unit/application/primitives/internal/join-path-segment.test.ts` (empty-prefix → `leaf`; non-empty → `prefix/leaf`) in THIS slice — the D4 fallback, not the expectation.

### Commit

```
refactor: extract joinPathSegment and route the three path-segment joins through it
```
