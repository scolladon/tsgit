# Design — checkout: replace a symlink with a regular file

> Brief: `checkout`'s working-tree writer (`apply-changeset.ts` `writeFileEntry`) cannot replace an occupying symlink with a regular file — it throws `PERMISSION_DENIED` where git succeeds. Mirror the merge-side `rmIfExists`-then-write fix, pin the symlink→file branch switch against real git, and drop the now-redundant `unlinkSync` test workarounds.
> Status: draft → self-reviewed ×3 → accepted

## Context

`checkout` (branch switch) flows `checkout → switchBranch → materializeTree → applyChangeset → applyEntry → writeFileEntry`
(`src/application/commands/checkout.ts`, `src/application/primitives/apply-changeset.ts`). `writeFileEntry` is
the single working-tree writer for a checkout: it branches on `FileMode`.

- `SYMLINK` (120000): `rmIfExists(ctx, absPath)` then `ctx.fs.symlink(target, absPath)`.
- `GITLINK` (160000): `ctx.fs.mkdir(absPath)`.
- regular fallthrough (100644 / 100755): `ctx.fs.write(absPath, content)` then `ctx.fs.chmod(...)` — **no `rmIfExists` first.**

The node adapter's `write` runs under `'creation'` containment. Its leaf check (`interpretCreationLstat`,
`src/adapters/node/node-file-system.ts` ≈ L210-236) rejects with `PERMISSION_DENIED` when the leaf is already a
symlink ("Success + symlink → reject … don't write through a pre-existing symlink"). So when a path's kind changes
symlink → file across a branch switch, the regular fallthrough writes *through* the occupying symlink and the
adapter throws. `git` succeeds: it unlinks the old entry and writes the regular file.

This rejection is **node-adapter-specific**. The memory adapter's `write` (`src/adapters/memory/memory-file-system.ts`
L85-90) overwrites unconditionally and does not reject a symlink-occupied path — so the bug only manifests on a
node-backed working tree, which scopes the failing-first reproduction (see Test strategy).

The merge side already solved the identical problem. `src/application/commands/merge.ts`'s local
`writeWorkingTreeFile` (≈ L667-683) does `rmIfExists(ctx, fullPath)` then `ctx.fs.write(...)` with the comment:
"Remove any existing symlink (including dangling) before writing a regular file — NodeFileSystem.write uses
'creation' mode and would throw PERMISSION_DENIED if a symlink already occupies the path." `rmIfExists`
(`src/application/primitives/internal/write-working-tree-file.ts` L19-25) probes with `lstat` (no symlink follow),
so dangling symlinks are removed too. **`rmIfExists` is already imported** into `apply-changeset.ts` (L28) and
already used by its own `SYMLINK` branch (L129) and the `delete` branch in `applyEntry` (L174).

Constraints that bind this change:

- **ADR-226 (git-faithfulness prime directive):** replicate git's observable on-disk state byte-for-byte. The
  symlink→file switch must leave a regular file with the committed content + mode and no leftover symlink, exactly
  as git does. Pinned empirically below.
- **ADR-249 (structured data only):** the library emits no display string; faithfulness binds data and on-disk
  state. The interop test reconstructs git's view from structured probes (`lstat`/`readlink`/`readFile`/
  `ls-files --stage`), never from rendered stdout.
- **CLAUDE.md coding style:** immutability, small functions, no smells. The fix adds one statement to an existing
  small function — no new surface, no new option.

## Requirements

When this ships:

1. A branch switch that changes a tracked path's kind **symlink → regular file** replaces the symlink with the
   regular file: correct content, correct mode (644 or 755), no leftover symlink, working tree clean — identical to
   canonical `git checkout`.
2. The same holds for `checkout --force -- <path>` (path-restore) when a **dangling** symlink squats the path:
   the dangling symlink is removed and the regular file is written.
3. The existing reverse direction (regular file → symlink) and the symlink → symlink retarget continue to work
   (already handled by the `SYMLINK` branch's `rmIfExists`).
4. The fix is local to `writeFileEntry` and mirrors the merge-side precedent — no behavioural change to GITLINK or
   to any path that does not have an occupying entry.
5. A cross-tool interop test pins the symlink→file switch (and the reverse + dangling-squat edges) against real
   `git`, asserting byte-for-byte parity of the resulting worktree state.
6. The `unlinkSync` test workarounds that the fix makes redundant are removed; the tests pass *because* tsgit now
   self-heals, not because the test pre-deletes the squatter.

## Design

### The fix

In `writeFileEntry` (`src/application/primitives/apply-changeset.ts`), add `await rmIfExists(ctx, absPath)` before
the regular-file write, mirroring `merge.ts`'s `writeWorkingTreeFile`:

```ts
  // (SYMLINK and GITLINK branches unchanged)
  // Remove any existing entry (including a dangling symlink) before writing a
  // regular file — the node adapter's `write` uses 'creation' mode and throws
  // PERMISSION_DENIED if a symlink already occupies the path. (lstat-probing.)
  await rmIfExists(ctx, absPath);
  await ctx.fs.write(absPath, content);
  await ctx.fs.chmod(absPath, mode === FILE_MODE.EXECUTABLE ? MODE_EXEC_PERM : MODE_REGULAR_PERM);
```

Why faithful + minimal:

- **Faithful.** Empirically git unlinks the occupying entry and writes the regular file (matrix below). `rmIfExists`
  + `write` produces exactly that on-disk state. `rmIfExists` is a no-op when nothing occupies the path
  (`lstat` → not found → no `rm`), so the common case (writing a fresh file, or overwriting a regular file the
  adapter already permits) is unchanged in observable effect.
- **Minimal.** One statement added to one function. `rmIfExists` is already imported and already the established
  idiom in this exact file and in `merge.ts`. No new dependency, no new option, no signature change.
- **Idempotent / safe.** `rmIfExists` swallows only the existence probe; a failing `rm` propagates. A regular file
  already at the path is removed then rewritten — same final bytes/mode, so no observable regression (git itself
  rewrites unconditionally on a kind-unchanged forced restore).

Note on the regular-over-regular case: today the adapter *permits* writing over an existing regular file
(`interpretCreationLstat`: "Success + non-symlink → no-op (overwrite is fine)"), so `rmIfExists` is strictly
required only for the symlink-squat. Adding it unconditionally (rather than guarding "only if a symlink occupies")
is the deliberate choice the merge side already made: it is simpler, matches the precedent verbatim, and removes a
class of leaf-state assumptions. This uniformity is a Decision-candidate input (see below), not a silent choice.

### Pinned faithfulness matrix (empirical — git 2.54.0)

Probed in a `mktemp -d` throwaway repo (isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed, signing
off). NEVER run in the worktree — a worktree shares `.git/config` with the main checkout and all siblings via the
common dir.

| # | Setup (graph) | Command | Resulting worktree state of `p` | Index (`ls-files --stage`) | `git status` |
|---|---|---|---|---|---|
| A | base+main: symlink `the-target`; `feat`: regular `regular file content\n` (644). On disk: symlink (HEAD=main). | `git checkout feat` | regular file, content `regular file content\n`, mode **644**, **not a symlink** | `100644 … p` | clean |
| B | (continuing A, on `feat` = regular) | `git checkout main` | symlink → `the-target`, **not a regular file** | `120000 … p` | clean |
| C | `feat` has regular `p`; disk has a **dangling** symlink `/nonexistent/dangling` squatting `p` | `git checkout --force -- p` | regular file `regular file content\n`, **not a symlink** | unchanged | clean |
| D | base+main: symlink `tgt`; `feat`: executable regular `#!/bin/sh…` (755). On disk: symlink (HEAD=main). | `git checkout feat` | regular file, mode **755**, **not a symlink** | `100755 … p` | clean |

Take-aways the fix must satisfy: symlink→file leaves a regular file with the committed content and mode (644 *or*
755), no residual symlink, clean status (A, D); the reverse (B) is git's symlink-over-file replace that tsgit
already does; dangling-symlink squat (C) is removed by the lstat-probing `rmIfExists` (no follow).

### Sibling writers (awareness — consolidation deferred to the refactor/ADR phase)

There are 3-4 near-duplicate mode-aware working-tree writers, each handling the symlink-squat slightly differently:

| Writer | File | Symlink branch rms? | Regular branch rms? |
|---|---|---|---|
| `writeFileEntry` | `apply-changeset.ts` | yes (`rmIfExists`) | **no — this bug** → yes after fix |
| `writeWorkingTreeEntry` | `internal/write-working-tree-file.ts` | yes (`rmIfExists`) | **no** (regular branch `write`+`chmod`, no rm) |
| `writeWorkingTreeFile` (merge-local) | `merge.ts` | n/a (regular-only) | yes (`rmIfExists`) |
| `writeWorkingTreeFile` (primitive) | `internal/write-working-tree-file.ts` | n/a (regular-only) | **no** |

`writeWorkingTreeEntry` (used by `apply-merge-to-worktree`) has the *same latent gap* in its regular branch as
`writeFileEntry` had — it is not exercised by 24.9p's reproduction, so whether to fix/consolidate it now is a
scope question, not a settled fact. This is the load-bearing decision candidate.

### Test workarounds to remove

`test/integration/distinct-types-with-base-interop.test.ts` carries six `unlinkSync(path.join(pair.ours, 'p'))`
calls plus three `unlinkSync(… 't'/'p')` calls. Each was classified by reasoning about *what occupies the path*
and *which writer runs* at that moment:

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

The four removable workarounds (214, 504, 662, 720) all sit on the symlink→file checkout the fix now self-heals;
once removed, the tests still pass because tsgit unlinks the squatter itself — which is the assertion. The `import`
of `unlinkSync` must stay (lines 1285/1300/1382 still use it).

**Discrepancy with the brief, flagged for the ADR/plan phase.** The brief named "setupWithBase/S8/P1/Q6 and P5".
Empirically: (a) S5 is also a removable squat-workaround (the brief omitted it); (b) Q6 and P5's `unlinkSync`
calls are symlink-retargeting *mechanics* (rm-then-ln within a commit, no intervening checkout) — **not** this
bug's workarounds, and removing them would break the test setup. The verified set to remove is **214, 504, 662,
720** (setupWithBase, S5, S8, P1). This doc's table is the authority the implementer follows, not the brief's
enumeration.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Scope of the fix** | (a) Local one-line fix to `writeFileEntry` only, mirroring `merge.ts`; pin + drop the 4 redundant test workarounds. (b) Same as (a) **plus** fix the twin gap in `writeWorkingTreeEntry`'s regular branch (add `rmIfExists`) in the same change. (c) Consolidate all 3-4 mode-aware writers into one shared helper now. | **(a)** | 24.9p is a scoped bug fix with a verified reproduction only through `writeFileEntry`. (a) is minimal, faithful, mirrors the ADR-blessed precedent, and is fully covered by the interop matrix. (b) widens to an unproven path with no failing test (risk of an unpinned change). (c) is a structural refactor — it belongs to the engine's dedicated refactor phase (whole-codebase lens), not a bug-fix slice. Note the `writeWorkingTreeEntry` gap explicitly so the refactor phase can pick it up. |
| 2 | **Unconditional `rmIfExists` vs guard-on-symlink** | (a) Always `rmIfExists` before the regular write (verbatim merge-side precedent). (b) Only `rmIfExists` when an lstat shows a symlink occupies the path. | **(a)** | (a) matches the shipped, ADR-reviewed `merge.ts` idiom byte-for-byte, is simpler, and has no observable downside (git rewrites unconditionally too). It is also the only cross-adapter-correct option: the **memory** adapter's `write` silently overwrites a symlink-squat path by setting a `files` entry **without deleting the stale `symlinks` entry** (see node-vs-memory note below), leaving both maps populated at one path — `rmIfExists` is what clears the symlink entry. (b) adds a branch + an extra lstat for a micro-optimisation that buys nothing observable, diverges from the precedent, and would leave the memory adapter's corrupt dual-entry state unfixed. |

The designer does not decide these; the user decides in the ADR phase.

## Test strategy

- **New cross-tool interop test:** `test/integration/checkout-replace-symlink-with-file-interop.test.ts`, twin
  git/tsgit, using `interop-helpers.ts` (`makePeerPair`, `runGit` with scrubbed env, `lsStage`). One shared
  `beforeAll`-style peer/ours pair per the heavy-interop convention; 60s timeout. `@proves` header in the
  established style (`surface: repo.checkout`, `bucket: cross-tool-interop`,
  `interopSurface: checkout`).
- **Edge matrix (mirrors the pinned matrix; reconstruct git's view via structured probes, ADR-249):**
  1. **symlink → regular file (644)** branch switch — assert `p` is a regular file, content matches, mode 644,
     `!lstatSync(p).isSymbolicLink()`, `lsStage(ours) === lsStage(peer)`, status clean. (Matrix A)
  2. **symlink → executable file (755)** branch switch — same, mode 755, stage `100755`. (Matrix D)
  3. **regular file → symlink** branch switch (reverse) — assert `p` is a symlink with the right target on both
     tools (guards the already-working path against regression). (Matrix B)
  4. **dangling-symlink squat** then `checkout --force -- p` (or branch switch with force) — assert the dangling
     symlink is removed and the regular file is written. (Matrix C)
  - Parity is asserted by comparing tsgit's worktree/index to canonical git's, not against literals alone — both
    tools build the same graph and the assertion is `ours === peer`.
- **RED reproduction must be node-backed.** The bug is the node adapter's `'creation'` containment rejecting a
  symlink leaf (`interpretCreationLstat`). The **memory** adapter's `write` does *not* reject a symlink-squat path
  (it `files.set`s and leaves the stale `symlinks` entry), so a memory-adapter unit/parity test **cannot**
  reproduce the `PERMISSION_DENIED`. The failing-first test therefore lives in the node-backed
  integration/interop harness: it switches symlink→file and asserts the call no longer throws and the worktree
  matches git. Make it GREEN with the one-line fix.
- **Cross-adapter consistency (bonus the fix buys).** On the memory adapter the fix also removes the latent
  dual-entry corruption (a `symlinks` entry surviving under a new `files` entry at the same path). A memory-adapter
  parity/unit test can assert that after a symlink→file write, `lstat` reports a regular file (not a symlink) — this
  guards Decision candidate 2(a) and kills the mutant that drops `rmIfExists`.
- **Mutation:** the added `rmIfExists` statement must be killed — the node-backed symlink→file test fails (throws
  `PERMISSION_DENIED`) if the statement is removed, and the memory-adapter consistency assert fails (still a
  symlink) too; both target the exact line.
- **Workaround removal is itself a test:** dropping lines 214/504/662/720 and keeping the suite green proves the
  self-heal. No new asserts needed there beyond what the scenarios already check.
- **Property tests:** not applicable — `writeFileEntry` is single-purpose I/O orchestration, not a
  parser/matcher/round-trip pair (CLAUDE.md "when property tests are NOT appropriate": I/O wrappers / command
  facades belong in integration tests).

## Out of scope

- **Consolidating the duplicate mode-aware writers** (`writeFileEntry`, `writeWorkingTreeEntry`, the two
  `writeWorkingTreeFile`s) — structural refactor for the refactor phase; flagged above.
- **Fixing `writeWorkingTreeEntry`'s regular-branch squat gap** — same latent bug class but no 24.9p reproduction
  through it; deferred (Decision candidate 1b/1c) unless the user widens scope in the ADR phase.
- **Q1/Q2/Q6/P5 `unlinkSync` calls** — verified NOT redundant with this fix (regular→regular checkout, or
  symlink-retargeting mechanics); left untouched.
- **Memory/browser adapter symlink semantics** — the bug is specific to the node adapter's 'creation' containment;
  the fix is adapter-agnostic (`rmIfExists` is a port call) and changes no adapter code.
