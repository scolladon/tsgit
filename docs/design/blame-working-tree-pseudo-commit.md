# Design — `blame` working-tree pseudo-commit ("Not Committed Yet")

> Extends `blame` (committed-rev only, ADR-258) with git's bare-`git blame <file>`
> behaviour: lines matching the committed history blame to their real commits;
> **uncommitted** lines (modified or added vs `HEAD`) blame to a synthetic
> zero-oid pseudo-commit. The library still returns **structured data only**
> (ADR-249) — it emits no `00000000 (Not Committed Yet …)` line. Reconstructing
> that text from the structured fields is the caller's concern (and is exactly
> what the interop test does).

## 1. What git computes (grounded against real `git`)

Isolated env (scrubbed `GIT_*`, signing off). The findings below fix the design.

### 1.1 The pseudo-commit (`git blame --porcelain f.txt`, dirty tree)

A two-line file committed as `a / b / c`; the working tree is edited to
`a / b-DIRTY / c / d-NEW`:

```
<sha-c1> 1 1 1            # line 1 unchanged → real commit
…author/committer/summary c1 … boundary … filename f.txt
	a
0000000000000000000000000000000000000000 2 2 1
author Not Committed Yet
author-mail <not.committed.yet>
author-time <NOW>          # current wall-clock time
author-tz <local-tz>
committer Not Committed Yet … committer-time <NOW> … committer-tz <local-tz>
summary Version of f.txt from f.txt
previous <sha-c1> f.txt
filename f.txt
	b-DIRTY
<sha-c1> 3 3 1
	c
0000000000000000000000000000000000000000 4 4 1
	d-NEW
```

Fixed facts about the pseudo-commit:

- **oid** = `0000000000000000000000000000000000000000` (40 zeros).
- **identity** = `Not Committed Yet <not.committed.yet>` at the **current
  wall-clock time** / local tz — git *fabricates* this; it is not real authorship.
- **summary** = `Version of <path> from <path>` (both the queried final path).
- **previous** = `<HEAD-oid> <path>` — present when the path is tracked in HEAD.
- **boundary** = absent (the pseudo-commit has a parent: HEAD).
- **filename** = the queried path.
- The content shown is the **working-tree** bytes.

### 1.2 One pseudo-commit, diffed against HEAD

Staging a change (`b → b-staged`) *and* then editing the worktree further
(`c → c-worktree`) collapses into **one** zero pseudo-commit: both `b-staged`
and `c-worktree` blame to `00000000`; only lines equal to HEAD (`a`) blame to the
committed history. So the algorithm is: **diff the working-tree blob against
HEAD's blob**; lines common to both pass into the normal committed walk, lines
differing from HEAD finalize on the pseudo-commit. The index is *not* a separate
pseudo-commit — staged-but-uncommitted content is simply "not committed".

### 1.3 Tracking gate (which paths are blame-able)

- **untracked** (not in HEAD, not in index) → `fatal: no such path '<p>' in HEAD`.
- **staged-new** (in index, not in HEAD) → all lines blame to `00000000`, with
  **no `previous`** and **no `boundary`** (summary still `Version of <p> from <p>`).
- **`rm --cached`** (in HEAD, not in index), worktree copy present → blames
  against HEAD normally (the index is irrelevant once HEAD has the path).
- **missing on disk** (tracked, file deleted from the worktree) →
  `fatal: Cannot lstat '<p>'`.
- **unborn HEAD** (no commits) → `fatal: no such ref: HEAD` (refuses regardless
  of index/worktree state).

So the gate is: the working file must **exist on disk**, and the path must be in
**HEAD or the index**. In-HEAD ⇒ `previous = HEAD` + diff-against-HEAD; in-index-
only ⇒ everything is uncommitted (no `previous`); in neither ⇒ refuse.

### 1.4 Rename following for the pseudo-commit

A pure `git mv f g` (staged, **no** content edit), then `git blame g` →
all lines blame to the **real** committing history under the old path `f`
(git follows the exact-content rename via the index). A `git mv` **with** an edit
in the same uncommitted change → the rename is *not* followed (treated as a new
file: all lines to `00000000`, no `previous`). This mirrors the committed walk's
existing exact-content-only rename following (rename-with-edit already deferred,
ADR-258/§6). v1 here follows the **simpler, bounded** subset (§6): it resolves the
pseudo-commit's parent (HEAD) by **direct path lookup only**; following a rename
whose new name is absent from HEAD is **deferred** (documented faithful divergence).

### 1.5 Clean tree ⇒ identical to HEAD blame

`git blame f` and `git blame HEAD -- f` are **byte-identical on a clean tree**
(the divergence is only over uncommitted lines). So working-tree mode on a clean
tree returns exactly today's committed-HEAD result — every existing committed-rev
test that commits then blames stays valid.

## 2. What exists already (reused, not rebuilt)

- The whole **scoreboard** (`commands/blame.ts`): priority queue, `processSuspect`,
  `splitAgainstParent`, `finalize`, rename-aware `resolveInParent`. Working-tree
  mode is a *new seed* feeding the **same** committed walk — no walk changes.
- `splitAgainstParent(entries, diffLines(headBlob, workingBlob))` — the pure core
  already splits an entry set against a parent diff. The pseudo-commit's single
  "pass to HEAD" step is exactly this call.
- `resolveCommitIsh(ctx, 'HEAD')` + `readCommitData` → the HEAD **oid**, committer
  **date** (priority-queue key), and root **tree**; unborn HEAD surfaces as the
  existing `REVPARSE_UNRESOLVED`/`NO_INITIAL_COMMIT` refusal (no special-casing).
- `flattenTree(ctx, headTree)` → `path → { id, mode }` for the HEAD-side blob lookup.
- `readIndex(ctx)` → `GitIndex` — the in-index check for the staged-new gate.
- `compareWorkingTreeDelta`/`hashBlob` patterns — reading a working file via the
  `FileSystem` port (`ctx.fs.lstat`/`read`/`readlink`, `ctx.layout.workDir`),
  symlink-aware, size-guarded.
- `splitLines` / `diffLines` (`domain/diff/line-diff.ts`), `subjectLine`,
  `resolveCommitIsh` — unchanged.

## 3. Public surface

The structured result gains a discriminator for the not-committed-yet line; the
committed shape is unchanged. **(Both the source selector and the line shape are
ADR decisions — see §8; this section reflects the recommended choices, revised to
the user's ruling before implementation.)**

```ts
export interface BlameOptions {
  readonly rev?: string;            // committed rev (default HEAD when no worktree selector)
  readonly worktree?: boolean;      // select the working-tree pseudo-commit (recommended: explicit opt-in)
  readonly range?: { readonly start: number; readonly end: number };
}

/** Fields shared by every blamed line, committed or not. */
interface BlameLineBase {
  readonly finalLine: number;       // 1-based position in the queried (working) file
  readonly sourceLine: number;      // 1-based position in the originating blob
  readonly sourcePath: FilePath;
  readonly content: Uint8Array;
  /** Where the committed base lives; absent for a staged-new file (not in HEAD). */
  readonly previous?: { readonly commit: ObjectId; readonly path: FilePath };
}

export interface CommittedBlameLine extends BlameLineBase {
  readonly committed: true;
  readonly commit: ObjectId;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly summary: string;
  readonly boundary: boolean;
}

/** The "Not Committed Yet" pseudo-commit line — zero-oid, no fabricated identity. */
export interface UncommittedBlameLine extends BlameLineBase {
  readonly committed: false;
}

export type BlameLine = CommittedBlameLine | UncommittedBlameLine;

export interface BlameResult {
  readonly path: FilePath;
  readonly lines: ReadonlyArray<BlameLine>;
}
```

The pseudo-commit's fabricated `00000000` oid, `Not Committed Yet`, `<NOW>`
timestamp, and `Version of <p> from <p>` summary are **git's rendering of "not
committed"**, not authorship data — per ADR-249 they are the caller's to
reconstruct from `committed: false`. The library emits none of them; the interop
renderer (and any consumer mimicking `git blame`) supplies them. This also sheds
the otherwise-unavoidable **non-determinism** of git's `<NOW>` timestamp from the
library's data.

## 4. Algorithm — seed-time projection (the pseudo-commit never enters the queue)

The pseudo-commit is resolved entirely in a new **working-tree seed**; the
committed walk is untouched.

```
seedWorkingTree(board, path):
  head        = resolveCommitIsh(ctx, 'HEAD') + readCommitData   # unborn ⇒ refuses FIRST
  workingBlob = readWorkingFile(ctx, path)            # absent ⇒ refuse (Cannot lstat)
  N           = splitLines(workingBlob).length
  if N == 0: return                                   # empty file ⇒ no lines
  headTree    = flattenTree(ctx, head.tree)
  headEntry   = headTree.get(path)
  whole       = [{ finalStart: 0, count: N, sourceStart: 0 }]
  if headEntry exists:
    headBlob  = readBlob(headEntry.id)
    { passed, kept } = splitAgainstParent(whole, diffLines(headBlob, workingBlob))
    schedule(board, head.oid, path, head.committerDate, headBlob, passed)  # → committed walk
    finalizeUncommitted(board, path, workingBlob, kept, previous = { head.oid, path })
  else:
    if path in readIndex(ctx):                         # staged-new
      finalizeUncommitted(board, path, workingBlob, whole, previous = undefined)
    else:
      refuse(PATH_NOT_IN_TREE('HEAD', path))           # untracked
```

- `passed` lines (common with HEAD) enter the **existing** committed walk via
  `schedule(HEAD, …)` and finalize at their real last-touching commits exactly as
  today — including their normal `previous` (the committed parent), *not* the
  pseudo-commit's.
- `kept` lines (differ from HEAD, or the whole file when staged-new) finalize as
  `committed: false` lines, denormalizing `previous = HEAD` (or `undefined`).
- `finalizeUncommitted` mirrors `finalize` but emits the `UncommittedBlameLine`
  variant; `sourceLine === finalLine` (the pseudo-commit's blob *is* the working
  file, so positions coincide) and `sourcePath = path`.

`blame(ctx, path, opts)` dispatches: worktree selector → `seedWorkingTree`; else
→ today's committed `seed`. `applyRange`, the queue drain, and result assembly are
shared verbatim (`-L` is a pure output selector over the merged final lines).

Termination & correctness are unchanged — the only addition is one pre-walk
`splitAgainstParent` against HEAD plus a direct finalize; no new graph edges.

## 5. Layering (hexagonal)

```
domain/blame/                 # unchanged (pure split-blame core reused as-is)
application/primitives/…       # readHeadTree, readIndex, readBlob, hashBlob — reused
application/commands/blame.ts  # + seedWorkingTree, finalizeUncommitted, dispatch
```

No new port. Reading the working file uses the existing `FileSystem` port the same
way `status`/`add` do. A small internal `readWorkingFile(ctx, path)` helper
(lstat-guarded, symlink-aware) lifts the `compareWorkingTreeDelta` read pattern; if
it already factors cleanly it is reused rather than duplicated (architecture pass).

## 6. Scope (v1) and deferrals

**In v1:** working-tree blame for a path **present in HEAD** (modified / staged+
worktree / clean), and a **staged-new** path (all-uncommitted, no `previous`);
faithful refusals (untracked, missing-on-disk, unborn HEAD); `-L` selector;
denormalized discriminated result.

**Deferred (documented faithful divergences):**

- **Rename-following for the pseudo-commit** — a pure `git mv` (no edit) blamed by
  the *new* name before committing: git follows it to the old path's history; v1
  resolves the pseudo-commit's HEAD parent by **direct path lookup only**, so a
  worktree-renamed file is treated as staged-new (all uncommitted, no `previous`).
  Bounded by the same exact-content limitation as the committed walk; re-addable
  when working-tree rename detection lands (needs a tree built from the index).
- **Content filters / `core.autocrlf`** — v1 diffs raw working bytes against the
  HEAD blob (tsgit's filter-free baseline everywhere). No new divergence.
- Inherited from ADR-258/§6: `-M`/`-C`, `--reverse`, `-w`, `--ignore-rev`.

## 7. Testing

- **Unit — `commands/blame` (worktree mode):** memory adapter; commit then dirty
  the worktree. Cases: modify-one-line (mix of committed + `committed:false`),
  append-new-line, staged-new file (all `committed:false`, no `previous`), clean
  tree (≡ HEAD blame, all `committed:true`), `-L` spanning committed+uncommitted,
  refusals (untracked → `PATH_NOT_IN_TREE`, missing-on-disk, unborn HEAD), empty
  working file. GWT/AAA, `sut`, 100% + 0 surviving mutants.
- **Interop — `blame-interop`:** new dirty-tree cases reconstruct `git blame
  --porcelain f.txt` byte-for-byte. The renderer fills the pseudo-commit's
  fabricated fields from `committed: false` (zero oid, `Not Committed Yet`,
  `Version of <p> from <p>`, `previous`); the non-deterministic `<NOW>` timestamp
  is supplied by the renderer (the one field git itself makes non-reproducible),
  so the comparison stays deterministic on every other byte.
- **Parity scenario:** worktree-mode blame runs identically on node + memory.
- No property test: working-tree seed is orchestration over the already-property-
  tested `splitAgainstParent` — none of the four lenses fit (no new grammar).

## 8. Open decisions (ADR)

1. **Source selector** — how to ask for working-tree blame.
   - **A** `rev` omitted ⇒ working tree (git-exact); explicit `rev` ⇒ committed.
     Breaking (changes today's omit-rev ⇒ HEAD); refuses on worktree-less adapters.
   - **B (recommended)** explicit opt-in (`worktree: true`), default stays
     committed-HEAD — *preserves ADR-258's "without changing the committed-rev
     semantics"*; non-breaking; no adapter-dependent silent behaviour.
   - **C** hybrid: omit-rev ⇒ worktree-when-a-worktree-exists, else HEAD
     (ADR-258's parenthetical) — silently adapter-dependent.

2. **Pseudo-commit representation.**
   - **1 (recommended)** discriminated union (`committed: true|false`); uncommitted
     lines omit the fabricated identity (ADR-249-clean; illegal states
     unrepresentable; mechanical narrowing in committed-rev tests).
   - **2** flat shape, optional identity fields (`commit?`/`author?`/…) — less
     churn, weaker typing, allows illegal states.
   - **3** fabricate the full synthetic identity (`Not Committed Yet`/`<NOW>`/…) —
     stable shape but injects non-deterministic cosmetics into data (violates
     ADR-249). *Rejected.*
```
