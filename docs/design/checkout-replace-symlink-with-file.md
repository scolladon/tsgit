# Design — checkout: replace a symlink with a regular file (via one shared working-tree writer)

> Brief: `checkout`'s working-tree writer (`apply-changeset.ts` `writeFileEntry`) cannot replace an occupying
> symlink with a regular file — it throws `PERMISSION_DENIED` where git succeeds. Mirror the merge-side
> `rmIfExists`-then-write fix, pin the symlink→file branch switch against real git, and drop the now-redundant
> `unlinkSync` test workarounds.
> Status: draft → self-reviewed ×3 → accepted → **revised against ADR-340 / ADR-341** (scope deviated) → self-reviewed ×3
> Decisions: [ADR-340](../adr/340-consolidate-mode-aware-working-tree-writers.md) (consolidate the four writers now),
> [ADR-341](../adr/341-always-unlink-before-regular-working-tree-write.md) (always `rmIfExists` before a regular write).

## Revision note (what ADR-340 / ADR-341 changed)

The original design recommended a **one-line local fix** to `writeFileEntry` and **deferred** consolidating the
duplicated writers to the engine's refactor phase (Decision candidate 1 → recommendation (a)). The user **overrode**
that in the ADR conversation:

- **ADR-340** chose option (c): **consolidate all four mode-aware working-tree writers into one shared helper now**,
  as part of 24.9p. The 24.9p bug and the `writeWorkingTreeEntry` twin gap are fixed as a *property of the single
  helper*, not as two separate one-liners.
- **ADR-341** chose option (a) for the unlink rule: the shared writer **always** `rmIfExists` before a regular write
  — no symlink guard.

This revision rewrites **Design**, **Requirements**, **Test strategy**, **Out of scope**, and **Decision
candidates** (now marked decided, citing the ADRs) to reflect the consolidation. The fix is no longer one line; it
is a **behaviour-preserving refactor** that collapses the duplication AND fixes 24.9p + the twin gap. The pinned
faithfulness matrix (git 2.54.0) and the verified test-workaround set are **unchanged by the scope expansion** and
re-confirmed below.

## Context

`checkout` (branch switch) flows `checkout → switchBranch → materializeTree → applyChangeset → applyEntry →
writeFileEntry` (`src/application/commands/checkout.ts`, `src/application/primitives/apply-changeset.ts`).
`writeFileEntry` branches on `FileMode`:

- `SYMLINK` (120000): `rmIfExists(ctx, absPath)` then `ctx.fs.symlink(target, absPath)`.
- `GITLINK` (160000): `ctx.fs.mkdir(absPath)` — reached when checkout materialises a submodule
  (`applyEntry` passes empty content with GITLINK mode, `apply-changeset.ts` ≈ L182).
- regular fallthrough (100644 / 100755): `ctx.fs.write(absPath, content)` then `ctx.fs.chmod(...)` — **no
  `rmIfExists` first.**

The node adapter's `write` runs under `'creation'` containment. Its leaf check (`interpretCreationLstat`,
`src/adapters/node/node-file-system.ts` ≈ L210-236) rejects with `PERMISSION_DENIED` when the leaf is already a
symlink ("Success + symlink → reject … don't write through a pre-existing symlink"). So when a path's kind changes
symlink → file across a branch switch, the regular fallthrough writes *through* the occupying symlink and the
adapter throws. `git` succeeds: it unlinks the old entry and writes the regular file.

This rejection is **node-adapter-specific**. The memory adapter's `write` (`src/adapters/memory/memory-file-system.ts`
L85-90) overwrites unconditionally and does not reject a symlink-occupied path — but it leaves the **stale
`symlinks` entry** in place under the new `files` entry, so the path ends up dual-populated. The node bug scopes the
failing-first reproduction (Test strategy); the memory dual-entry corruption is the cross-adapter consistency the
fix also closes (ADR-341).

### Why consolidation, not a one-liner (the writer survey)

The merge side already solved the identical regular-write-over-symlink problem in a **private copy** of the writer
(`merge.ts`'s local `writeWorkingTreeFile`, ≈ L666-682: `rmIfExists` then `write`, with the explanatory comment).
The writer survey found **four** near-duplicate mode-aware working-tree writers, each handling the symlink-squat
differently — the duplication is the root cause: the fix had to be re-derived per writer, and two writers still
carry the unpinned gap. ADR-340 collapses them into one.

| Writer | File | Path arg | mkdir parent | SYMLINK branch | GITLINK branch | Regular branch |
|---|---|---|---|---|---|---|
| `writeFileEntry` | `apply-changeset.ts` (L118-138) | `absPath` (pre-joined by caller via `joinPath(workdir, path)`) | no | `rmIfExists`+`symlink` | `mkdir` | `write`+`chmod` — **24.9p gap (no rm)** |
| `writeWorkingTreeEntry` | `internal/write-working-tree-file.ts` (L54-71) | `path` (joins `ctx.layout.workDir`) | yes | `rmIfExists`+`symlink` | **none** | `write`+`chmod` — **twin latent gap (no rm)** |
| `writeWorkingTreeFile` (merge-local) | `merge.ts` (L666-682) | `path` (joins) | yes | n/a (regular-only) | n/a | `rmIfExists`+`write` — already fixed |
| `writeWorkingTreeFile` (primitive) | `internal/write-working-tree-file.ts` (L37-46) | `path` (joins) | yes | n/a (regular-only) | n/a | `write` (no rm) |

`rmIfExists` (`internal/write-working-tree-file.ts` L19-25) probes with `lstat` (no symlink follow), so dangling
symlinks are removed too. It is already imported into `apply-changeset.ts` and already used by `writeFileEntry`'s
SYMLINK branch and `applyEntry`'s `delete` branch.

Constraints that bind this change:

- **ADR-226 (git-faithfulness prime directive):** replicate git's observable on-disk state byte-for-byte. The
  symlink→file switch must leave a regular file with the committed content + mode and no leftover symlink, exactly
  as git does. Pinned empirically below.
- **ADR-249 (structured data only):** the library emits no display string; faithfulness binds data and on-disk
  state. The interop test reconstructs git's view from structured probes (`lstat`/`readlink`/`readFile`/
  `ls-files --stage`), never from rendered stdout.
- **ADR-340 / ADR-341 (this change):** one shared mode-aware writer; always `rmIfExists` before a regular write.
- **CLAUDE.md coding style:** immutability, small functions (<20 lines), no smells, DRY. The consolidation
  *removes* surface (collapses four writers into one), it does not add an option or a public symbol — all four
  writers are internal.

## Requirements

When this ships:

1. A branch switch that changes a tracked path's kind **symlink → regular file** replaces the symlink with the
   regular file: correct content, correct mode (644 or 755), no leftover symlink, working tree clean — identical to
   canonical `git checkout`.
2. The same holds for `checkout --force -- <path>` (path-restore) when a **dangling** symlink squats the path: the
   dangling symlink is removed and the regular file is written.
3. The existing reverse direction (regular file → symlink) and the symlink → symlink retarget continue to work
   (the consolidated writer keeps the SYMLINK branch's `rmIfExists`).
4. **All four mode-aware working-tree writers are collapsed into one shared helper** (ADR-340). Every working-tree
   write site (`apply-changeset`/checkout, `merge`, `apply-merge-to-worktree`, `stash`) delegates to it. There is no
   longer a per-writer regular branch in which the unlink rule can be forgotten.
5. **The consolidation is behaviour-preserving for every existing consumer except the 24.9p checkout path it fixes**
   (and the `writeWorkingTreeEntry` twin gap, which is now also closed because the regular branch always unlinks).
   The merge / cherry-pick / rebase / revert / stash on-disk behaviour is unchanged.
6. The shared writer **always** calls `rmIfExists` before a regular-file write — no symlink guard (ADR-341). It is
   `lstat`-probing, hence a no-op on an empty path and a remover of dangling symlinks.
7. A cross-tool interop test pins the symlink→file switch (and the reverse + dangling-squat edges) against real
   `git`, asserting byte-for-byte parity of the resulting worktree state.
8. The `unlinkSync` test workarounds that the fix makes redundant are removed; the tests pass *because* tsgit now
   self-heals, not because the test pre-deletes the squatter.

## Design

### Target shape of the shared helper

ADR-340 fixes that consolidation happens now and leaves the precise shape to this design. Two shapes were possible:

- **(i) One mode-aware helper** all sites call — it dispatches SYMLINK / GITLINK / regular and applies the
  always-unlink rule in every branch.
- **(ii) A layered pair** — a low-level regular writer (`always rm + write + chmod`) plus a mode dispatcher on top
  that adds the SYMLINK / GITLINK branches.

**Chosen: (ii) the layered pair.** The four writers do not all need the mode dispatch — the
two `writeWorkingTreeFile` copies and three of the merge/stash call sites pass **already-resolved regular content**
and never a symlink/gitlink mode. Forcing every regular-only caller to fabricate a `FILE_MODE.REGULAR` argument just
to reach the one dispatch is feature envy. The layered pair gives each caller exactly the entry point its data
shape needs, and there is still exactly **one** place that owns the unlink-before-regular-write rule (the low-level
writer), which is what ADR-340/341 require.

The consolidated module is `src/application/primitives/internal/write-working-tree-file.ts` (the existing home of
`rmIfExists` / `parentDir` / `writeWorkingTreeEntry` / `writeWorkingTreeFile` / `removeWorkingTreeFile`). Target
internal shape:

```
rmIfExists(ctx, fullPath)                  // unchanged — lstat-probe + rm
parentDir(fullPath)                        // unchanged
ensureParent(ctx, fullPath)                // (extracted) mkdir the parent when present
joinPath(workDir, path)                    // trailing-slash-aware (lifted/shared from apply-changeset)

// LOW-LEVEL regular writer — the single owner of the unlink-before-regular-write rule (ADR-341)
writeRegularFile(ctx, fullPath, content, mode?)   // ensureParent → rmIfExists → write → (chmod if mode given)

// MODE DISPATCHER — adds SYMLINK / GITLINK on top of the regular writer
writeWorkingTreeEntry(ctx, path, content, mode)   // joinPath(workDir,path) → SYMLINK | GITLINK | writeRegularFile(...,mode)
writeWorkingTreeFile(ctx, path, content)          // joinPath(workDir,path) → writeRegularFile(...) (regular, default 644)
removeWorkingTreeFile(ctx, path)                  // unchanged — joins workDir → rmIfExists
```

(The dispatcher uses the trailing-slash-aware `joinPath` rather than today's bare `${workDir}/${path}` so checkout's
join is byte-identical to `writeFileEntry`'s — see the path-equivalence section. Migrating the existing internal
writers' bare concatenation to `joinPath` is a no-op for the current non-trailing-slash `workDir` and removes the
latent double-slash edge.)

Resolving the differences between the four writers:

1. **GITLINK branch.** The mode dispatcher (`writeWorkingTreeEntry`) **must** keep a GITLINK branch
   (`mkdir`) — but **only `writeFileEntry`/checkout ever feeds it a GITLINK mode.** Verified empirically: in **both**
   `merge.ts` and `apply-merge-to-worktree.ts`, `gitlink` is a member of `UNSUPPORTED_CONFLICT_TYPES`
   (`merge.ts` L180-183; `apply-merge-to-worktree.ts` L47) — a submodule conflict is **rejected before any
   working-tree write**. So the merge / cherry-pick / rebase / revert / stash consumers of the dispatcher never
   reach the writer with a GITLINK mode; only checkout does. The dispatcher therefore needs **all three** branches
   so it can serve checkout, and the merge family simply never exercises the GITLINK arm (covered as before by its
   own unsupported-conflict rejection tests).

2. **`writeWorkingTreeFile`'s callers always pass already-resolved regular content** — so they need only the
   regular path. Verified: `merge.ts` (resolved-merged / resolved-known clean outcomes, L600/607),
   `apply-merge-to-worktree.ts` (resolved-merged / resolved-known, L231/238), `stash.ts` (restore working blob,
   L379). None passes a mode; the kind is always a plain file. `writeWorkingTreeFile` stays a thin regular-only
   façade over `writeRegularFile` (default 644, no chmod variation needed by these callers — git restores these
   from blobs whose mode is regular).

3. **The path-vs-absPath / workDir-join difference.** `writeFileEntry` takes an **already-absolute** path
   (`applyEntry` pre-joins via `joinPath(workdir, entry.path)`), whereas the internal writers take a repo-relative
   `FilePath` and join `ctx.layout.workDir` themselves. The low-level `writeRegularFile` works on a **fully-resolved
   absolute path** (no joining, no `ctx.layout`). The dispatcher (`writeWorkingTreeEntry`) does the
   `joinPath(ctx.layout.workDir, path)` join (trailing-slash-aware — see the path-equivalence section) and then
   calls `writeRegularFile`. **checkout/`apply-changeset` migrates to call the dispatcher with a repo-relative
   `FilePath`** (passing `entry.path`, not the pre-joined `absPath`), so the join lives in exactly one place.
   `writeFileEntry` is **deleted**; `applyEntry`'s `joinPath(workdir, entry.path)` for the writer call is removed
   (the dispatcher joins `ctx.layout.workDir` instead). Faithfulness check: both `applyChangeset` callers
   (`materialize-tree`, `apply-sparse-checkout`) pass `workdir = ctx.layout.workDir`, and the dispatcher reuses the
   same `joinPath`, so the resolved absolute path is byte-identical — confirmed below.

4. **mkdir-parent uniformity.** `writeFileEntry` did **not** mkdir the parent (checkout's changeset materialises
   directories upstream); the internal writers do. Folding `writeFileEntry`'s checkout call onto the dispatcher
   means checkout now goes through `ensureParent`. This is **behaviour-preserving and strictly safer**:
   `ensureParent` is `mkdir` (recursive, idempotent per the FileSystem port contract — "creating parent directories
   as needed"); when the parent already exists (the checkout case) it is a no-op. The merge-local
   `writeWorkingTreeFile` even Stryker-disables its own `mkdir` as redundant-but-defensive — the consolidated path
   keeps that defensive belt for every caller at zero observable cost.

`removeWorkingTreeFile` is untouched (already a thin `rmIfExists` façade) and `applyEntry`'s `delete` branch keeps
calling `rmIfExists` directly (it is the same primitive the writer's regular branch now also calls).

### Faithfulness of the absolute-path equivalence (read-only verification)

The only behavioural risk in migrating checkout from `writeFileEntry(absPath, …)` to `writeWorkingTreeEntry(path,
…)` is the path the bytes land on. Confirmed read-only in source (no git state written):

- `apply-changeset.ts` `applyEntry` computes `absPath = joinPath(workdir, entry.path)` (L171) where `workdir` is
  `opts.workdir` threaded from `applyChangeset`. `joinPath` (L49-50) is **trailing-slash-aware**:
  `workdir.endsWith('/') ? `${workdir}${rel}` : `${workdir}/${rel}``.
- **Both** `applyChangeset` callers pass `ctx.layout.workDir`: `materialize-tree.ts` (L248, the checkout / branch
  switch path) and `apply-sparse-checkout.ts` (L205). There is no caller that passes a `workdir` ≠
  `ctx.layout.workDir`, so the dispatcher's `ctx.layout.workDir` join reaches the identical base for every
  `applyChangeset` consumer.
- the existing dispatcher (`writeWorkingTreeEntry`) joins with **bare concatenation** `${ctx.layout.workDir}/${path}`.

**Subtle edge — eliminate it by sharing `joinPath`.** Bare `${workDir}/${path}` and `joinPath(workDir, path)`
diverge by **one** case: when `workDir` ends with `/`, bare concatenation yields a double slash (`//`) where
`joinPath` yields a single one. The existing internal writers already use bare concatenation for every merge/stash
path with no observed problem (so `ctx.layout.workDir` does not carry a trailing slash today), but to make the
migration provably byte-identical and remove the latent edge, the design recommends the dispatcher reuse the
**trailing-slash-aware `joinPath`** (lift it into the internal module / share it) rather than bare concatenation.
With that, `writeFileEntry`'s `joinPath(workdir, entry.path)` and the dispatcher's `joinPath(ctx.layout.workDir,
path)` resolve to the **same** absolute string for every `FilePath` a changeset carries. The migration is then a
pure refactor of *where the join happens*, not *what it resolves to*. (If the implementer finds any `FilePath` for
which `joinPath` and bare concat differ beyond the trailing-slash case, surface it as a slice blocker.)

### Every call site and how it changes

| Call site | Today calls | After | Behaviour-preserving? Why |
|---|---|---|---|
| `apply-changeset.ts` `applyEntry` (L180 blob, L182 gitlink empty) | `writeFileEntry(ctx, absPath, content, mode)` | `writeWorkingTreeEntry(ctx, entry.path, content, mode)` (drop the pre-join) | **The 24.9p fix.** Regular branch now `rmIfExists` first (was the gap); SYMLINK/GITLINK branches identical; path resolves identically (above). Pinned by the new checkout interop matrix. |
| `write-distinct-types-sides.ts` (L20 ours, L25 theirs) | `writeWorkingTreeEntry(ctx, path, content, mode)` | unchanged call; dispatcher body now routes regular through `writeRegularFile` | **Yes — and closes the twin gap.** Regular branch previously did `write`+`chmod` with no rm; now always `rmIfExists` first (ADR-341). On-disk result identical except a symlink→file distinct-types write now self-heals instead of throwing on node. Guarded by `distinct-types-with-base-interop` + merge/cherry-pick/rebase/revert/stash interop. |
| `merge.ts` `writeMarkedConflict` (L214) and `writeConflictToTree` (L630) | `writeWorkingTreeEntry(...)` | unchanged call | **Yes** — same as above; twin gap closed. Mode comes from `mergedMode ?? ourMode ?? theirMode`, never gitlink (rejected upstream). |
| `merge.ts` `writeConflictWorktree` (L232/239) + `writeOutcomeToTree` (L600/607) | merge-local `writeWorkingTreeFile` (the private copy) | shared `writeWorkingTreeFile` (primitive) | **Yes** — the merge-local copy already did `rmIfExists`+`write`; the shared `writeWorkingTreeFile` now also does (it delegates to `writeRegularFile`, which always unlinks). **The merge-local copy is deleted** (DRY, ADR-340). Mkdir-parent behaviour identical. |
| `apply-merge-to-worktree.ts` (L231/238) | primitive `writeWorkingTreeFile` (no rm today) | shared `writeWorkingTreeFile` (now rm-then-write) | **Behaviour-preserving in observable state.** Today's primitive `writeWorkingTreeFile` does **not** rm — for cherry-pick/rebase/revert/stash resolved outcomes this never hit a symlink-squat (no failing test), but adding the rm is safe (ADR-341: regular-over-regular is rm-then-rewrite to identical bytes; symlink-squat now self-heals instead of throwing). Guarded by cherry-pick / rebase / revert interop suites. |
| `apply-merge-to-worktree.ts` (L213) `writeWorkingTreeEntry` | `writeWorkingTreeEntry(...)` | unchanged call | **Yes** — twin gap closed as above. |
| `stash.ts` (L379) | primitive `writeWorkingTreeFile` (no rm today) | shared `writeWorkingTreeFile` (now rm-then-write) | **Behaviour-preserving.** Same reasoning as apply-merge; guarded by `stash-interop`. |
| `apply-merge-to-worktree.ts` (L227) / `stash.ts` (L319) `removeWorkingTreeFile` | `removeWorkingTreeFile(...)` | unchanged | No change. |

Net source delta: **delete** `writeFileEntry` (apply-changeset) and the **merge-local** `writeWorkingTreeFile`;
**extract** `writeRegularFile` + `ensureParent` in the internal module; route `writeWorkingTreeEntry`'s regular
branch and `writeWorkingTreeFile` through `writeRegularFile`; migrate `applyEntry` to the dispatcher. No public
surface change (every writer is internal — `repository`/command surfaces and `api.json` untouched; ADR-249
unaffected).

### Pinned faithfulness matrix (empirical — git 2.54.0) — UNCHANGED by the scope expansion

Probed in a `mktemp -d` throwaway repo (isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed, signing
off). NEVER run in the worktree — a worktree shares `.git/config` with the main checkout and all siblings via the
common dir. This matrix remains the authority for the **checkout** path; consolidation does not change any value in
it (the dispatcher's SYMLINK/GITLINK branches are the same code paths as before; the regular branch gains the
always-`rmIfExists` that produces exactly these states).

| # | Setup (graph) | Command | Resulting worktree state of `p` | Index (`ls-files --stage`) | `git status` |
|---|---|---|---|---|---|
| A | base+main: symlink `the-target`; `feat`: regular `regular file content\n` (644). On disk: symlink (HEAD=main). | `git checkout feat` | regular file, content `regular file content\n`, mode **644**, **not a symlink** | `100644 … p` | clean |
| B | (continuing A, on `feat` = regular) | `git checkout main` | symlink → `the-target`, **not a regular file** | `120000 … p` | clean |
| C | `feat` has regular `p`; disk has a **dangling** symlink `/nonexistent/dangling` squatting `p` | `git checkout --force -- p` | regular file `regular file content\n`, **not a symlink** | unchanged | clean |
| D | base+main: symlink `tgt`; `feat`: executable regular `#!/bin/sh…` (755). On disk: symlink (HEAD=main). | `git checkout feat` | regular file, mode **755**, **not a symlink** | `100755 … p` | clean |

What the consolidated writer must satisfy: symlink→file leaves a regular file with the committed content and
mode (644 *or* 755), no residual symlink, clean status (A, D); the reverse (B) is git's symlink-over-file replace
that the SYMLINK branch already does; dangling-symlink squat (C) is removed by the lstat-probing `rmIfExists` (no
follow).

### Merge / stash on-disk behaviour is already pinned — no NEW empirical pin needed

The consolidation does not change the merge-family on-disk behaviour, so no new `git`-probe matrix is required for
those paths — their existing cross-tool interop suites are the authority and the regression guard:

- `test/integration/merge-interop.test.ts`, `merge-conflict-interop.test.ts`, `merge-driver-interop.test.ts`,
  `merge-abort-interop.test.ts`, `conflict-marker-size-and-labels-interop.test.ts`, `add-add-content-interop.test.ts`
  (`surface: repo.merge.run`).
- `test/integration/distinct-types-with-base-interop.test.ts` (distinct-types conflict materialisation — exercises
  `writeWorkingTreeEntry` directly; also home of the workarounds removed below).
- `test/integration/cherry-pick-interop.test.ts`, `rebase-interop.test.ts`, `revert-interop.test.ts`
  (`apply-merge-to-worktree` consumers).
- `test/integration/stash-interop.test.ts` (`stash` consumer).

These all build the same graph with real `git` and assert tsgit's worktree/index `=== peer`. If the consolidation
broke any merge/stash on-disk state, one of these goes red — which is precisely the behaviour-preservation gate.

## Decision candidates — now DECIDED (cite ADR-340 / ADR-341)

| # | Choice | Alternatives (≤3) | Decision | Authority |
|---|---|---|---|---|
| 1 | **Scope of the fix** | (a) Local one-line fix to `writeFileEntry` only; pin + drop the 4 redundant test workarounds; note the twin gap for the refactor phase. (b) Same as (a) **plus** fix the twin gap in `writeWorkingTreeEntry`. (c) Consolidate all four mode-aware writers into one shared helper now. | **(c) — DECIDED by the user.** The original design recommended (a); the user overrode it. | **[ADR-340](../adr/340-consolidate-mode-aware-working-tree-writers.md).** Rationale: the duplication is the root cause (the fix had to be re-derived per writer; two writers still carry the unpinned gap); consolidating makes the 24.9p bug class unable to recur and closes the twin gap as a property of one helper. Negative (wider blast radius into merge/stash) mitigated by behaviour-preservation + the existing interop suites + the feature-scoped review pass. |
| 2 | **Unconditional `rmIfExists` vs guard-on-symlink** | (a) Always `rmIfExists` before the regular write (verbatim merge-side precedent). (b) Only `rmIfExists` when an `lstat` shows a symlink occupies the path. | **(a) — DECIDED.** | **[ADR-341](../adr/341-always-unlink-before-regular-working-tree-write.md).** Rationale: matches the shipped, ADR-reviewed `merge.ts` idiom byte-for-byte; cross-adapter-correct (clears the memory adapter's stale `symlinks` entry so a symlink→file write leaves a single correct entry on node *and* memory); one uniform rule, no per-branch leaf-state assumptions; faithful to git, which rewrites unconditionally on a kind change. (b) buys nothing observable, adds a branch + an extra `lstat`, and leaves the memory dual-entry corruption unfixed. |
| 3 | **Helper shape: single mode-aware helper vs layered pair** | (a) One mode-aware helper every site calls (regular-only callers fabricate a REGULAR mode). (b) Layered pair: low-level `writeRegularFile` (single owner of the unlink rule) + a mode dispatcher on top. | **(b) — designer-resolved within ADR-340's mandate.** | ADR-340 fixes *that* consolidation happens now and leaves the *shape* to this design. (b) avoids forcing regular-only callers (the two `writeWorkingTreeFile` consumers + 3 merge/stash sites) to fabricate a mode (feature envy), keeps exactly one owner of the always-unlink rule, and keeps small single-purpose functions (Object Calisthenics). Surfaced here so the ADR/plan phase can challenge it if desired; it is a structural, not a faithfulness, choice. |

No load-bearing choice remains open. Candidate 3 is a structure-only refinement the designer may resolve under
ADR-340; if the user prefers shape (a), the plan flips one slice (dispatcher-only) without affecting faithfulness or
the test matrix.

## Test strategy

### New cross-tool interop test (the 24.9p faithfulness pin)

`test/integration/checkout-replace-symlink-with-file-interop.test.ts`, twin git/tsgit, using `interop-helpers.ts`
(`makePeerPair`, `runGit` with scrubbed env, `lsStage`). One shared `beforeAll`-style peer/ours pair per the
heavy-interop convention; 60s timeout (per the interop-load flake note). `@proves` header in the established style
(`surface: repo.checkout`, `bucket: cross-tool-interop`, `interopSurface: checkout`).

Edge matrix (mirrors the pinned matrix; reconstruct git's view via structured probes, ADR-249):

1. **symlink → regular file (644)** branch switch — assert `p` is a regular file, content matches, mode 644,
   `!lstatSync(p).isSymbolicLink()`, `lsStage(ours) === lsStage(peer)`, status clean. (Matrix A)
2. **symlink → executable file (755)** branch switch — same, mode 755, stage `100755`. (Matrix D)
3. **regular file → symlink** branch switch (reverse) — assert `p` is a symlink with the right target on both tools
   (guards the already-working path against regression). (Matrix B)
4. **dangling-symlink squat** then `checkout --force -- p` — assert the dangling symlink is removed and the regular
   file is written. (Matrix C)
- Parity is asserted by comparing tsgit's worktree/index to canonical git's, not against literals alone — both
  tools build the same graph and the assertion is `ours === peer`.

### Behaviour-preservation regression guard (the consolidation)

The consolidation is behaviour-preserving, so the **existing merge / cherry-pick / rebase / revert / stash interop
suites must stay green unchanged** — they are the regression guard for the wider blast radius (ADR-340 negative):
`merge-interop`, `merge-conflict-interop`, `merge-driver-interop`, `merge-abort-interop`,
`conflict-marker-size-and-labels-interop`, `add-add-content-interop`, `distinct-types-with-base-interop`,
`cherry-pick-interop`, `rebase-interop`, `revert-interop`, `stash-interop`. Plus the unit suite
`test/unit/application/primitives/internal/write-working-tree-file.test.ts` (covers `writeWorkingTreeEntry` /
`writeWorkingTreeFile` / `removeWorkingTreeFile`) — extended below for the new shape.

### Twin-gap (`writeWorkingTreeEntry`) self-heal — now fixed, add a node-backed assertion

The `writeWorkingTreeEntry` twin gap is closed by routing its regular branch through `writeRegularFile`
(always-`rmIfExists`). Add a **node-backed** assertion that a merge / apply-to-worktree **symlink → file** write
self-heals (does not throw `PERMISSION_DENIED`, leaves a regular file). Either:

- extend `distinct-types-with-base-interop.test.ts` with a scenario where, at the conflict-materialisation moment, a
  **symlink** squats the path that the regular distinct-types side must occupy (the four removed workarounds, below,
  already construct exactly this squat — once the `unlinkSync` pre-delete is dropped, that scenario *is* the
  twin-gap self-heal assertion); **or**
- add a focused node-backed unit/integration test on `writeWorkingTreeEntry(ctx, path, regularBytes, REGULAR)` with
  a pre-existing symlink at `path`, asserting it no longer throws and `lstat` reports a regular file.

The first option is preferred — it reuses the verified squat construction and proves the production path end-to-end.

### Cross-adapter consistency (ADR-341)

On the **memory** adapter, assert that after a symlink→file write, `lstat` reports a **regular file** (not a
symlink) and there is **no stale `symlinks` entry** at the path — i.e. exactly one entry survives. This guards
Decision 2(a) and kills the mutant that drops `rmIfExists` from the regular branch (the memory adapter would
otherwise silently leave the dual-entry corruption, which this assert catches even though it does not throw).

### Unit tests for the new shared-helper branches

Extend `write-working-tree-file.test.ts` for the layered shape:

- `writeRegularFile`: (i) writes content + chmod for the mode given; (ii) **always `rmIfExists` first** — separate
  isolated tests for the two guard conditions per CLAUDE.md "guard clauses need isolated tests": a symlink-occupied
  path (removed then written) and an absent path (`rmIfExists` is a no-op, still writes); (iii) regular-over-regular
  rewrites to identical bytes.
- `writeWorkingTreeEntry` dispatch: SYMLINK branch (rm+symlink), GITLINK branch (mkdir, no write/chmod — the arm
  only checkout reaches), regular branch routes through `writeRegularFile` (twin gap closed).
- `writeWorkingTreeFile`: still a regular-only façade; now `rmIfExists` first.
- Error assertions specific (assert the error's `code`/`reason`, never `toThrow(Error)` alone) per CLAUDE.md.

### Mutation

- The always-`rmIfExists` statement in `writeRegularFile` must be killed: the node-backed symlink→file checkout test
  throws `PERMISSION_DENIED` if removed, and the memory-adapter consistency assert fails (still a symlink / stale
  entry) — both target the exact line.
- GITLINK-branch removal in the dispatcher is killed by checkout's submodule materialisation
  (`submodule-init-sync-deinit-interop` exercises the GITLINK write).
- Watch for an equivalent `ensureParent` `mkdir` mutant — the merge-local copy already Stryker-disables its mkdir as
  provably-equivalent (the FileSystem port creates parents in `write`); if the same equivalence holds for the
  consolidated `ensureParent`, document it rather than writing a contrived test (CLAUDE.md "accept provably
  equivalent mutants").

### Test-workaround removal (verified set — UNCHANGED by the scope expansion)

`test/integration/distinct-types-with-base-interop.test.ts` carries `unlinkSync(path.join(pair.ours, 'p'))` calls.
Each was classified by reasoning about *what occupies the path* and *which writer runs*. The scope expansion does
**not** change this table — re-confirmed against the live file (lines unchanged):

| Line | Scenario | What occupies `p`/`t` at the checkout | Is it THIS bug's squat? | Action |
|---|---|---|---|---|
| 214 | `setupWithBase` (guarded `theirs.kind==='symlink'`) | on `side`, disk holds theirs' **symlink**; `checkout main` writes ours (often a file) | **yes** | **remove** the whole `if (spec.theirs.kind === 'symlink') { unlinkSync … }` block (L211-215) |
| 504 | S5 | on `side`, disk holds **symlink** `target-b`; `checkout main` writes regular `base` | **yes** | **remove** (comment L502-503 + L504) |
| 662 | S8 | on `side`, disk holds **symlink** `target-b`; `checkout main` writes regular `ours` | **yes** | **remove** (comment L660-661 + L662) |
| 720 | P1 | identical to S8 | **yes** | **remove** (comment L718-719 + L720) |
| 1046 | Q1 | on `side`, disk holds a **regular** 644 file (`theirs-644`); `checkout main` writes regular 755 | **no** (regular→regular; adapter already permits) | **keep** — out of scope; brief did not name it |
| 1121 | Q2 | on `side`, disk holds a **regular** 644 file; `checkout main` writes regular 755 | **no** (regular→regular) | **keep** — out of scope |
| 1285 | Q6 peer | `rm symlink` then `ln new-target` (symlink→symlink retarget, **no checkout between**) | **no** (test mechanics) | **keep** |
| 1300 | Q6 ours | symlink→symlink retarget mechanics | **no** | **keep** |
| 1382 | P5 ours | `rm symlink` then `ln target-b` (symlink→symlink retarget within commit B, no checkout) | **no** (test mechanics) | **keep** |

The four removable workarounds (214, 504, 662, 720 = setupWithBase / S5 / S8 / P1) all sit on the symlink→file
checkout the consolidated writer now self-heals; once removed, the tests still pass because tsgit unlinks the
squatter itself — which is the assertion (and, per the twin-gap section, the distinct-types path routes through the
same consolidated regular branch, so these scenarios double as the twin-gap self-heal proof). The `import` of
`unlinkSync` must stay (lines 1285/1300/1382 still use it).

**Discrepancy with the brief, still flagged.** The brief named "setupWithBase/S8/P1/Q6 and P5". Empirically: (a) S5
is also a removable squat-workaround (the brief omitted it); (b) Q6 and P5's `unlinkSync` calls are
symlink-retargeting *mechanics* (rm-then-ln within a commit, no intervening checkout) — **not** this bug's
workarounds, and removing them would break the test setup. The verified set to remove is **214, 504, 662, 720**.
This doc's table is the authority the implementer follows, not the brief's enumeration. Re-confirmed under the
consolidation: the removed workarounds exercise the **same** consolidated regular branch the checkout path now uses,
so the self-heal that makes them removable is the identical fix.

### Property tests

Not applicable — the working-tree writers are single-purpose I/O orchestration, not a parser / matcher /
round-trip pair (CLAUDE.md "when property tests are NOT appropriate": I/O wrappers / command facades belong in
integration tests).

## Slicing hint for the planner

The consolidation is a refactor + a bug fix. Suggested TDD slice order — each slice atomic, gates green
(`npm run validate`), behaviour-preserving except the named bug-fix slice:

1. **RED → GREEN: pin 24.9p AND close the twin gap (one shared regular branch).** Add
   `checkout-replace-symlink-with-file-interop.test.ts` (matrix A–D); extend `write-working-tree-file.test.ts` unit
   branches for the always-unlink regular path (separate isolated tests, symlink-occupied vs absent). Both fail RED
   (node `PERMISSION_DENIED` / missing unlink). Introduce the layered helper — extract `writeRegularFile`
   (`ensureParent → rmIfExists → write → chmod-if-mode`) + `ensureParent`, lift/share the trailing-slash-aware
   `joinPath` into the internal module so the dispatcher uses it, and **route `writeWorkingTreeEntry`'s regular
   branch through `writeRegularFile`** — then **migrate `apply-changeset` `applyEntry` to call
   `writeWorkingTreeEntry`** (delete `writeFileEntry`, drop the pre-join). GREEN. Because
   checkout's regular path and the distinct-types/merge twin-gap path now share the **one** `writeRegularFile`
   regular branch, this single slice fixes 24.9p *and* the `writeWorkingTreeEntry` twin gap together — they are the
   same branch. The distinct-types / merge interop suites stay green.
2. **Route `writeWorkingTreeFile` (the regular-only façade) through `writeRegularFile`** as well (it gains the
   always-rm); unit branch first. This makes the primitive `writeWorkingTreeFile` self-heal on a symlink-squat too,
   ahead of migrating its consumers. Behaviour-preserving (regular-over-regular rewrites identical bytes).
3. **Migrate `merge.ts` to the shared `writeWorkingTreeFile`** — delete the merge-local private copy; the
   merge/merge-conflict/add-add interop suites are the guard (stay green). Behaviour-preserving.
4. **Migrate `apply-merge-to-worktree.ts` and `stash.ts`** to the shared regular writer (they gain the always-rm).
   cherry-pick / rebase / revert / stash interop suites are the guard (stay green). Behaviour-preserving.
5. **Memory-adapter cross-adapter consistency** assert (symlink→file leaves one regular entry, no stale
   `symlinks`) — guards ADR-341 and the `rmIfExists` mutant.
6. **Drop the four test workarounds** (214, 504, 662, 720) in `distinct-types-with-base-interop.test.ts`; suite
   stays green *because* tsgit self-heals (this slice is itself the self-heal assertion + the twin-gap end-to-end
   proof). Keep the `unlinkSync` import.

Slice 1 is the bug fix + twin gap (one shared regular branch); 2–4 are the pure behaviour-preserving migration of
the regular-only writers; 5–6 lock in the cross-adapter correctness and remove the scaffolding. Each gates on the
full validate; the migration slices additionally lean on the named interop suites as the behaviour-preservation
guard.

## Out of scope

- **Q1/Q2/Q6/P5 `unlinkSync` calls** — verified NOT redundant with this fix (regular→regular checkout, or
  symlink-retargeting mechanics); left untouched.
- **Memory/browser adapter symlink *semantics*** beyond clearing the stale `symlinks` entry — the node bug is the
  'creation' containment; the shared writer is adapter-agnostic (`rmIfExists` is a port call) and changes no adapter
  code. (The memory dual-entry *consistency* assert is **in** scope per ADR-341.)
- **GITLINK / submodule merge conflicts** — remain in `UNSUPPORTED_CONFLICT_TYPES` (rejected before any
  working-tree write); the consolidation does not change submodule conflict handling. The dispatcher keeps a GITLINK
  branch only because **checkout** materialises submodules through it.
- **New empirical pins for the merge/stash paths** — not needed: those behaviours are already pinned by their own
  interop suites (named above), which serve as the behaviour-preservation guard.
- **Any public surface / option change** — none; all four writers are internal, `api.json` and the command surfaces
  are untouched (ADR-249 unaffected).
