# Design — unify the third working-tree `joinPath` copy

> Brief: 24.9p (ADR-340) consolidated the working-tree-write path join into ONE shared, trailing-slash-collapsing
> `joinPath` in `primitives/internal/write-working-tree-file.ts`. `commands/internal/apply-sparse-checkout.ts` still
> keeps its OWN private workdir-join helper that DELIBERATELY tolerates a doubled separator (no collapse). Route it
> through the shared `joinPath` to reach the "exactly ONE `joinPath`" north star — but ONLY after confirming the
> collapse difference is harmless for sparse-checkout. Optional / low-priority: a justified no-op is acceptable if the
> divergence is load-bearing.
> Status: draft → self-reviewed ×3 → ready for ADR conversation
> Scope: behaviour-preserving internal refactor — no new git surface, no public-API change, no on-disk-state change.

## Context

`applySparseCheckout` (`src/application/commands/internal/apply-sparse-checkout.ts`) re-shapes the working tree to a
`SparseMatcher`. To probe each entry's on-disk presence it joins the entry's index-relative path onto the workdir
with a **private** helper (L59):

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

It is already imported cross-file by the sibling primitive `apply-changeset.ts` (L29; used L93, L157). So today there
are **two** workdir-join variants for the working-tree-write surface — the shared collapsing one and the sparse
non-collapsing copy — plus a **third inline non-collapsing copy** in the same shared file: `removeWorkingTreeFile`
(L96) bypasses the helper with bare `` `${ctx.layout.workDir}/${path}` ``.

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
  shared `joinPath` from `primitives/internal/write-working-tree-file.ts` is therefore legal with precedent.
- **CLAUDE.md coding style:** DRY, small single-purpose functions, no duplicated logic in touched code. The change
  *removes* a helper definition; it adds no surface.

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

1. `apply-sparse-checkout.ts` has **no** private `joinPath`; it uses the shared collapsing `joinPath` exported from
   `primitives/internal/write-working-tree-file.ts`. (The "exactly ONE working-tree-write `joinPath`" north star is
   met for the sparse path.)
2. The sparse-checkout behaviour is **unchanged**: same files materialised / removed / retained, same index
   skip-worktree bits, same `status` truthfulness — under cone AND non-cone, on memory AND node.
3. No public surface / option change; `api.json`, command surfaces, and ADR-249 untouched.
4. The existing sparse-checkout unit + interop suites stay green **unchanged** (they are the behaviour-preservation
   guard), and touched code keeps 100% line/branch coverage + 0 surviving mutants.

## Design

The change is a **one-helper deletion + one import**:

- Delete the private `joinPath` (`apply-sparse-checkout.ts:59`) and its now-redundant doubled-separator comment.
- Import `joinPath` from `../../primitives/internal/write-working-tree-file.js` (legal per the dependency rule; same
  module `apply-changeset.ts` already imports it from).
- The two call sites (L84, L140) are **unchanged** — `joinPath(workdir, entry.path)` now resolves to the shared
  collapsing helper. Signatures are identical (`(workDir: string, path: FilePath) => string` vs the sparse copy's
  `(workdir: string, rel: FilePath) => string` — same shape, `FilePath` arg), so no call-site edit is needed.

Net source delta: **−1 helper definition, −1 comment, +1 named import**. No logic moves. The collapsing branch the
shared helper carries is the only behavioural difference, and it is provably unreachable-or-equivalent (above).

The optional sweep of the **fourth** copy (`removeWorkingTreeFile`'s inline `` `${ctx.layout.workDir}/${path}` ``) is
weighed in D2 — it belongs to the *same file* and the *same north star*, but is a distinct one-line edit; surfaced as
a decision, not silently folded in.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **D1 — where the unified `joinPath` lives** | The sparse path needs the one shared collapsing join; which module owns it. | **(a)** Import the existing shared `joinPath` from `primitives/internal/write-working-tree-file.ts` into `apply-sparse-checkout.ts` as-is (minimal: −1 helper, +1 import). **(b)** Extract `joinPath` into a new tiny module (e.g. `primitives/internal/join-working-tree-path.ts`) that BOTH `write-working-tree-file.ts` and `apply-sparse-checkout.ts` import — cleaner cohesion (a path util imported from a file named "write-working-tree-file" reads awkward). **(c)** No-op — keep the private copy if the divergence is load-bearing. | **(a)** | Harmlessness is proven (above), so **(c)** is ruled out — the divergence is not load-bearing. Between (a) and (b): the shared helper is **already** imported cross-file from `write-working-tree-file.ts` by `apply-changeset.ts`, so (a) follows the *established* precedent and is the truly minimal diff (matches "diff-minded, not full-file rewrites"). (b) is *cohesively* nicer but moves a symbol other code already depends on, churning `write-working-tree-file.ts` + `apply-changeset.ts`'s import for a naming nicety — disproportionate for a one-helper item, and it widens the blast radius beyond the sparse file the brief scoped. If the file-name awkwardness is judged worth fixing, (b) is a clean follow-up of its own, not a rider on this refactor. **Recommend (a); flag (b) as an optional cohesion follow-up for the user to weigh.** |
| **D2 — fold `removeWorkingTreeFile`'s inline 4th copy?** | `removeWorkingTreeFile` (`write-working-tree-file.ts:96`) inlines a non-collapsing `` `${ctx.layout.workDir}/${path}` `` instead of calling the shared `joinPath` in its own file. | **(a)** Fold it into the shared `joinPath` in THIS PR (trivial one-liner, same file, same north star, same harmlessness proof — `removeWorkingTreeFile` only feeds `rmIfExists` → `ctx.fs.lstat`/`rm`, pure FS, never a matcher; callers `merge.ts`/`apply-merge-to-worktree.ts`/`stash.ts` all pass `ctx.layout.workDir`). **(b)** Leave it; record a follow-up backlog note. **(c)** Leave it, no follow-up (truly out of the item's title — "the third sparse copy"). | **(a) — but the user decides** | It is genuinely trivial and in-scope-adjacent: same file, same `joinPath`, the identical "north star" of "one join", and the same harmlessness argument applies verbatim (`removeWorkingTreeFile`'s path also only reaches pure FS ops via `rmIfExists`, and both adapters `//`-normalise). Folding it makes the shared file *self-consistent* (no copy bypassing its own helper). Counter-argument: the item's title scopes "the third copy" (sparse); adding the fourth widens the diff and the per-file mutation/coverage surface (`removeWorkingTreeFile` has its own unit tests at `write-working-tree-file.test.ts:357,373`). Per the discuss-follow-ups-first rule this is a three-way user call (do it now / record follow-up / drop). **Recommend (a)** — the cost is one line and one already-covered call site, and leaving a known 4th copy in the *same file as the canonical helper* is the more surprising end-state. Defer to the user. |
| **D3 — test strategy for a behaviour-preserving refactor** | What proves the refactor preserves behaviour, and whether any NEW test is warranted. | **(a)** No new test — lean entirely on the existing `apply-sparse-checkout.test.ts` (unit) + `sparse-checkout.test.ts` / `sparse-checkout-file-interop.test.ts` / `sparse-reset-merge.test.ts` (integration/interop) as the regression authority; they stay green unchanged. **(b)** (a) PLUS keep/repurpose the existing trailing-slash unit test as the explicit collapsing-branch guard. **(c)** (a) PLUS a brand-new unit test asserting sparse-checkout works when `workDir` ends in `/`. | **(b)** | The existing unit test at `apply-sparse-checkout.test.ts:376-398` — "Given a workdir path that ends with a slash … Then working-tree paths still resolve" — already hand-constructs a trailing-slash `Context` and its comment says it "exercises the `joinPath` slash branch". Today, against the *non-collapsing* sparse copy, that test passes only because the adapter normalises `//` (the copy has no slash branch). **After** routing to the shared *collapsing* helper, this same test becomes the genuine branch-coverage + mutation-kill test for `workDir.endsWith('/') === true`; every other test in the file (non-slash workDir) covers the `=== false` branch. So **both** branches of the shared `joinPath` get covered with **no new test** — the existing test was evidently written in anticipation of this unification. **(b)** = recommendation: explicitly retain that test (do not delete it as "now redundant"); it is the load-bearing guard for the surviving collapse branch. **(c)** would duplicate it. **Mutation implication:** removing the dead non-collapsing branch *reduces* the mutation surface in the sparse file (one fewer string-concat to mutate); the collapse branch's mutants are killed by the existing slash + non-slash tests in `write-working-tree-file.test.ts` (the helper's home) AND the sparse trailing-slash test. No new mutation risk is introduced; if anything the surviving-mutant budget improves. |

No load-bearing choice is decided here. D1 and D3 carry a recommendation the ADR conversation can ratify; D2 is the
three-way follow-up call (do-now / follow-up / drop) for the user.

## Test strategy

Behaviour-preserving refactor → the **existing** suites are the regression authority; they must stay green
**unchanged** (changing them would mask a regression):

- **Unit — `test/unit/application/commands/internal/apply-sparse-checkout.test.ts`.** The full partition / changeset
  / skip-worktree / retained-dirty coverage, including the trailing-slash `Context` test (L376-398) that becomes the
  explicit collapsing-branch guard (D3). 100% line/branch on the touched file is preserved: deleting the private
  helper removes its lines from the coverage denominator; the shared helper's branches are covered by this file's
  slash + non-slash tests and by the helper's own unit suite.
- **Integration / interop — `test/integration/sparse-checkout.test.ts` (multi-adapter parity, drives the real
  command surface through memory; final `describe.skipIf` cross-checks index + pattern file against canonical
  `git`), `sparse-checkout-file-interop.test.ts`, `sparse-reset-merge.test.ts`.** These build the same graph and
  assert observable state (files on disk, skip-worktree flags, committed tree path set, `status` cleanliness). If the
  unification changed any sparse on-disk/index outcome, one of these goes red — that is the behaviour-preservation
  gate.
- **Helper home — `test/unit/application/primitives/internal/write-working-tree-file.test.ts`** already exercises the
  shared `joinPath`'s slash + non-slash branches (via `writeWorkingTreeFile` / `writeWorkingTreeEntry`); unchanged.

**No new interop pin** — there is no new git behaviour. The faithfulness obligation is discharged by the harmlessness
proof + the unchanged green suites, not by a fresh `git`-probe matrix (running one would be theatre: nothing in
git's observable behaviour changes).

**Property tests — DO NOT APPLY.** `joinPath` is a single-line string concat behind an I/O orchestration command, not
a parser / matcher / round-trip pair / counting invariant (CLAUDE.md: "I/O wrappers, command facades belong in
integration / parity tests, not property tests").

**If D2 = (a):** the `removeWorkingTreeFile` fold is covered by its existing unit tests
(`write-working-tree-file.test.ts:357,373` — file-gone + no-op-on-absent) plus the merge / stash interop suites; the
collapse branch is already covered by the helper's slash/non-slash unit tests. No new test needed.

## Slicing hint for the planner

This is small enough for **one** atomic slice; split only if D2 is taken (then two):

**Slice 1 — unify the sparse `joinPath` onto the shared collapsing helper (the whole item).**
- Pre-chewed context:
  - File to edit: `src/application/commands/internal/apply-sparse-checkout.ts`.
  - Delete the private `joinPath` const + its comment at **L54-59** (the doc-comment L54-58 and the helper L59).
  - Add to the import block (alongside the existing `../../primitives/*` imports, ~L16-18):
    `import { joinPath } from '../../primitives/internal/write-working-tree-file.js';`
  - Call sites that now resolve to the shared helper (UNCHANGED — verify, do not edit): L84
    `const absPath = joinPath(workdir, entry.path);` and L140
    `await ctx.fs.exists(joinPath(workdir, entry.path))`.
  - Shared helper being imported: `joinPath` at `src/application/primitives/internal/write-working-tree-file.ts:35`,
    signature `(workDir: string, path: FilePath): string`.
  - Regression guard tests (run, expect green unchanged): unit
    `test/unit/application/commands/internal/apply-sparse-checkout.test.ts` (esp. the trailing-slash test L376-398,
    which now guards the collapse branch); integration `test/integration/sparse-checkout.test.ts`,
    `sparse-checkout-file-interop.test.ts`, `sparse-reset-merge.test.ts`.
- TDD note: behaviour-preserving, so RED is not a *new failing* test — the existing suite is GREEN before and after;
  the slice's correctness gate is "all existing suites still green + `npm run validate` clean + 0 new surviving
  mutants on the touched file". The trailing-slash unit test is the assertion that the *collapsing* branch is now
  the live code path (it already passes; after the edit it exercises the real `endsWith('/')` branch).
- Gate: `npm run validate` green; `npm run test:mutation` scoped to `apply-sparse-checkout.ts` shows 0 new survivors
  (the deleted branch *reduces* surface).

**Slice 2 (only if D2 = (a)) — fold `removeWorkingTreeFile`'s inline join onto the shared `joinPath`.**
- Pre-chewed context:
  - File: `src/application/primitives/internal/write-working-tree-file.ts`.
  - Edit `removeWorkingTreeFile` (**L95-98**): replace the inline `` `${ctx.layout.workDir}/${path}` `` (L96) with
    `joinPath(ctx.layout.workDir, path)` (the helper is in the same module — no import).
  - Regression guard: `test/unit/application/primitives/internal/write-working-tree-file.test.ts` (`removeWorkingTreeFile`
    tests at L357 file-gone / L373 no-op-on-absent) + merge/stash interop (`merge.ts`, `apply-merge-to-worktree.ts`,
    `stash.ts` are the callers).
  - Harmlessness: identical to the sparse case — `removeWorkingTreeFile`'s path only feeds `rmIfExists` →
    `ctx.fs.lstat`/`rm` (pure FS), never a matcher; both adapters `//`-normalise; `ctx.layout.workDir` never ends
    with `/`.
- Gate: `npm run validate` green; behaviour-preserving (collapse branch unreachable in practice, equivalent when
  reached).

Each slice gates on the full `npm run validate`; both lean on the named existing suites as the
behaviour-preservation guard.

## Out of scope

- **`walk-submodules.ts:106` / `walk-working-tree.ts:108` / `mv.ts:327` `joinPath` definitions** — a *different* join
  (path-segment → repo-relative `FilePath` for tree-walk prefixing), not the workdir-onto-relative absolute-path join.
  Not part of the "one working-tree-write `joinPath`" north star; untouched.
- **`removeWorkingTreeFile`'s inline copy** — IN scope only if D2 resolves to (a); otherwise a recorded follow-up
  (D2 (b)) or dropped (D2 (c)). The user decides.
- **Extracting `joinPath` to its own module (D1 (b))** — an optional cohesion follow-up, not taken under the
  recommendation (a); flagged for the user.
- **Any public surface / option / on-disk-state change** — none. This is a pure internal de-duplication; `api.json`,
  command surfaces, refusal conditions, reflogs, and structured output are untouched (ADR-249/226 unaffected).
- **New empirical git pins** — not needed; no git behaviour changes (the harmlessness proof + unchanged green suites
  discharge faithfulness).
