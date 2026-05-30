# Design — `cherry-pick` (single + range)

## 1. Goal

Apply the change introduced by one or more existing commits onto the current
`HEAD`, creating one new commit per picked commit. Faithful to `git cherry-pick`:

- Each new commit **preserves the original author** (name/email/timestamp/tz
  verbatim) and **the original message**; the **committer** becomes the current
  identity (config `user.*`, current time).
- The new commit is a **single-parent** commit (parent = the advancing `HEAD`),
  *not* a two-parent merge commit. This is the load-bearing difference from
  `merge` (which produces a two-parent commit via `MERGE_HEAD`).
- The patch is computed by a **3-way merge**: `base = parent(C)`, `ours = HEAD`,
  `theirs = C`. Conflicts are persisted on disk (markers + stage-1/2/3 index
  entries) under a dedicated `CHERRY_PICK_HEAD` state machine, parallel to the
  20.4 `MERGE_HEAD` machine but distinct from it.
- A **range** (`A..B`, or any rev-list range arg) expands to its constituent
  commits, oldest-first, and is applied one commit at a time. A conflict/empty
  stop midway is **resumable**: `continue` picks up the remaining commits,
  `skip` drops the current one and resumes, `abort` resets to the pre-sequence
  `HEAD`.

Non-goals for 22.1 (deferred — see §11): picking merge commits (`-m`/mainline),
`--signoff`, `--edit`, `--no-commit`, cross-tool resume (start in tsgit,
`git cherry-pick --continue`).

## 2. Faithful data model (git on-disk, not invented)

### 2.1 In-progress single-pick state (read by `git status`)

| File | Contents | Written when | Cleared when |
|---|---|---|---|
| `.git/CHERRY_PICK_HEAD` | picked commit oid `+ \n` | a pick conflicts or stops empty | continue / skip / abort / the resolving commit |
| `.git/MERGE_MSG` | picked commit's message draft | same | same |
| index stage 1/2/3 | base/ours/theirs unmerged entries | a pick conflicts | `add` resolves → stage 0 |
| working tree | `<<<<<<<` conflict markers | a pick conflicts | user edits |

`CHERRY_PICK_HEAD` is already registered in `PENDING_MARKERS`
(`primitives/internal/repo-state.ts`) and the `OPERATION_IN_PROGRESS` /
`NO_OPERATION_IN_PROGRESS` error unions already carry `'cherry-pick'`. `commit`
must learn to treat `CHERRY_PICK_HEAD` like it treats `MERGE_HEAD` for the
"resolving commit is allowed to clear the marker" exception — but **without**
adding a second parent (cherry-pick stays single-parent).

### 2.2 Multi-pick sequencer state (range / list resume)

| File | Contents | Purpose |
|---|---|---|
| `.git/sequencer/head` | pre-sequence `HEAD` oid `+ \n` | `abort` reset target |
| `.git/sequencer/todo` | `pick <oid> <subject>\n` per *remaining* commit | `continue`/`skip` work list |
| `.git/sequencer/opts` | tsgit key=value (`recordOrigin`, `allowEmpty`) | resume options (§5.1) |

**Faithfulness boundary (ADR — sequencer is tsgit-internal):** the *conflict
state* that external git tooling reads mid-operation (`CHERRY_PICK_HEAD`,
`MERGE_MSG`, the conflicted index, the markers) is byte-faithful, so
`git status` on a tsgit cherry-pick-in-progress is correct. The
`.git/sequencer/*` files are tsgit's own work-list bookkeeping; we match git's
**observable resume behavior**, not git's sequencer byte format. Cross-tool
resume is explicitly out of scope (§11). A single-commit pick that conflicts
writes **no** sequencer dir (matches git: a 1-commit `cherry-pick` leaves only
`CHERRY_PICK_HEAD`).

## 3. API surface — nested namespace `repo.cherryPick.*`

Per ADR-181/192/193 (frozen, non-callable nested namespace) and the ADR-210
stash precedent. Four verbs:

```ts
repo.cherryPick.run(input: CherryPickRunInput): Promise<CherryPickResult>
repo.cherryPick.continue(input?: CherryPickContinueInput): Promise<CherryPickResult>
repo.cherryPick.skip(): Promise<CherryPickResult>
repo.cherryPick.abort(): Promise<CherryPickAbortResult>
```

### 3.1 Inputs / results

```ts
interface CherryPickRunInput {
  /**
   * Revisions to pick, in argument order — exactly git's argv. A single
   * commit-ish ('abc123', 'feature', 'HEAD~2') picks one commit; an entry of the
   * form 'A..B' is a range expanded oldest-first. Results are concatenated in
   * argument order. '...' / multi-'^' forms are rejected in v1 (§7), not
   * mis-expanded.
   */
  readonly commits: ReadonlyArray<string>;
  /** -x: append `(cherry picked from commit <oid>)` to each message. */
  readonly recordOrigin?: boolean;
  /** --allow-empty: a pick that introduces no change creates an empty commit
   *  instead of stopping. */
  readonly allowEmpty?: boolean;
}

interface CherryPickContinueInput {
  /** Fallback for a single-pick resume only; a multi-pick sequence reads its
   *  persisted `.git/sequencer/opts`, which takes precedence (see §5.1). */
  readonly allowEmpty?: boolean;
  readonly recordOrigin?: boolean;
}

interface CherryPickedCommit {
  /** The source commit that was picked. */
  readonly source: ObjectId;
  /** The new commit created on the branch. */
  readonly created: ObjectId;
}

type CherryPickResult =
  | { readonly kind: 'picked'; readonly commits: ReadonlyArray<CherryPickedCommit> }
  | {
      readonly kind: 'conflict';
      readonly commit: ObjectId;              // the source commit that conflicted
      readonly conflicts: ReadonlyArray<CherryPickConflict>;
      readonly remaining: number;             // picks still queued after this one
    }
  | {
      readonly kind: 'empty';                 // stopped: pick is redundant
      readonly commit: ObjectId;
      readonly remaining: number;
    };

interface CherryPickConflict {
  readonly path: FilePath;
  readonly type: ConflictType;
}

interface CherryPickAbortResult {
  readonly head: ObjectId;                    // sequencer head HEAD now points at
  readonly branch: RefName;
}
```

`kind: 'picked'` carries every commit applied in *this call* (so a `continue`
that finishes the range returns only the commits it completed — the caller
already saw the earlier ones). `kind: 'conflict'` and `kind: 'empty'` are
returned, never thrown (consistent with `merge` / `stash apply`).

### 3.2 Refusals (thrown `TsgitError`)

| Condition | Code | Notes |
|---|---|---|
| `run` while any pending op marker exists | `OPERATION_IN_PROGRESS` | `assertNoPendingOperation` |
| `run` with a dirty index (index tree ≠ HEAD tree) | `WORKING_TREE_DIRTY` (paths) | git: "cannot cherry-pick: Your index contains uncommitted changes" |
| `run` with unmerged index entries | `MERGE_HAS_CONFLICTS` | git refuses to start over an unresolved state |
| a pick would overwrite dirty working-tree paths | `WORKING_TREE_DIRTY` (paths) | from `applyMergeToWorktree` `would-overwrite` |
| picking a merge commit (≥2 parents) | `CHERRY_PICK_MERGE_NO_MAINLINE` | new code; git: "is a merge but no -m option" |
| `continue`/`skip` with no pick in progress | `NO_OPERATION_IN_PROGRESS` (`cherry-pick`) | no `CHERRY_PICK_HEAD` |
| `continue` with unresolved index (stage>0) | `MERGE_HAS_CONFLICTS` | reuse `commit`'s `rejectUnmergedIndex` |
| `abort` with no sequence / no `CHERRY_PICK_HEAD` | `NO_OPERATION_IN_PROGRESS` (`cherry-pick`) | |
| detached HEAD | `UNSUPPORTED_OPERATION` (`cherry-pick`) | matches `merge`'s detached refusal |
| unborn branch (no HEAD commit) | `NO_INITIAL_COMMIT` | nothing to pick onto |

### 3.3 Wiring

`bindCherryPickNamespace(ctx, guard)` in
`commands/internal/cherry-pick-namespace.ts`, mirroring
`bindStashNamespace`; `repo.cherryPick` slot in `repository.ts` between
`checkout` and `clone` (alphabetical), typed `commands.CherryPickNamespace`.

## 4. `run` algorithm

```
run(input):
  assertRepository; assertNotBare('cherry-pick'); assertNoPendingOperation
  head = readHeadRaw
  if head not symbolic -> unsupportedOperation('cherry-pick', 'detached HEAD')
  ourId = resolveHeadCommit(head)              // NO_INITIAL_COMMIT if unborn
  todo  = expandRevisions(input.commits)       // ordered oldest-first per arg
  assertNoMergeCommits(todo)                    // validate-all-then-execute (§7.1)
  assertCleanWorkTree(ourId)                    // git's require_clean_work_tree
  return runSequence(todo, head.target, ourId, input, { multiPick: todo.length > 1, sequenceHead: ourId })
```

`assertCleanWorkTree(headId)` (new `commands/internal/clean-work-tree.ts`,
reusable by `revert`/`rebase` later) mirrors git's `require_clean_work_tree`:
the index tree must equal `headId`'s tree **and** no tracked path may differ
between the index and the working tree (no stage>0 entries either). It reuses
`synthesizeTreeFromIndex` for the index-vs-HEAD comparison and
`compareWorkingTreeEntry` (the 21.2c primitive) per tracked entry for the
working-vs-index comparison. A dirty start throws `workingTreeDirty(paths)`
(git: "cannot cherry-pick: Your local changes would be overwritten / Your index
contains uncommitted changes"). After each clean pick the index equals the new
`HEAD`, so the invariant holds for every commit in a range without re-checking.

`runSequence` drives the work-list (shared by `run` / `continue` / `skip`):

```
runSequence(todo, branch, ourId, opts, seq):
  applied = []
  for i in 0..todo.length:
    C = todo[i]
    outcome = applyOnePick(C, branch, ourId, opts)
    if outcome.kind == 'committed':
      applied.push({ source: C, created: outcome.id })
      ourId = outcome.id
      continue
    // conflict | empty -> persist resume state and stop
    persistInProgress(C, todo.slice(i+1), seq, opts, branch)
    return { kind: outcome.kind, commit: C, ..., remaining: todo.length-(i+1) }
  clearSequencer()                               // whole work-list consumed (no-op if none written)
  return { kind: 'picked', commits: applied }
```

`applyOnePick(C, branch, ourId, opts)`:

```
baseTree   = C has a parent ? tree(parent(C)) : undefined   // root commit -> empty base
oursTree   = tree(ourId)
theirsTree = tree(C)
lock = acquireIndexLock
try:
  currentIndex = readIndex
  res = applyMergeToWorktree({ baseTree, oursTree, theirsTree, currentIndex })
  if res.kind == 'would-overwrite' -> throw workingTreeDirty(res.paths)
  if res.kind == 'conflict':
    lock.commit(res.indexEntries)               // stage 1/2/3
    return { kind: 'conflict', conflicts: res.conflicts }
  // clean
  if res.mergedTree == oursTree && !opts.allowEmpty:
    return { kind: 'empty' }                     // redundant pick -> stop
  lock.commit(res.result.newIndexEntries)        // stage 0 (picked changes staged)
  id = createPickCommit(C, ourId, res.mergedTree, opts)
  updateRef(branch, id, { expected: ourId, reflogMessage: `cherry-pick: ${subject(C)}` })
  return { kind: 'committed', id }
finally: lock.release
```

`createPickCommit(C, parentId, tree, opts)`:

```
cData    = readCommit(C)
committer = resolveCommitter(config.user, now)
message   = opts.recordOrigin ? appendCherryPickOrigin(cData.message, C) : cData.message
return createCommit({ tree, parents: [parentId],
                      author: cData.author,         // preserved verbatim
                      committer, message: sanitizeMessage(message), extraHeaders: [] })
```

`persistInProgress(C, remainingTodo, seq, opts, branch)`:

```
writeCherryPickHead(C)
writeMergeMsg(messageDraft(C, opts))                         // opts-aware: -x line baked in here
if seq.multiPick:                                            // the original run had >1 commit
  writeSequencerHead(seq.sequenceHead)
  writeSequencerTodo(remainingTodo)                          // may be empty (last commit stopped)
  writeSequencerOpts({ recordOrigin: opts.recordOrigin, allowEmpty: opts.allowEmpty })  // §5.1
```

`messageDraft(C, opts) = opts.recordOrigin ? appendCherryPickOrigin(C.message, C) : C.message`
— so the persisted `MERGE_MSG` already carries the `-x` provenance line, and
`continue`'s `commitResolvedPick` uses the draft verbatim.

> A single-commit `run` that conflicts writes only `CHERRY_PICK_HEAD` +
> `MERGE_MSG` (no sequencer dir) — faithful to git. A range/list writes the
> sequencer dir (head + todo + opts) so the *remaining* commits **and the
> original `-x` / `--allow-empty` choices** survive the stop. `isMultiPick` is
> tracked on `seq` (set true by `run` when `todo.length > 1`), so even a stop on
> the *last* commit of a range still records the sequencer dir — `continue` then
> finds an empty todo and finalises cleanly.

## 5. `continue` algorithm

```
continue(input):
  assertRepository; assertNotBare('cherry-pick --continue')
  C = readCherryPickHead                                  // may be undefined (resolved via repo.commit)
  todo = readSequencerTodo()                              // may be undefined (single-pick / none)
  if C === undefined && (todo is undefined or empty) -> noOperationInProgress('cherry-pick')
  opts = resolveResumeOpts(input)                         // §5.1: disk opts ?? input
  head = readHeadRaw; ourId = resolveRef(head.target)
  applied = []
  if C !== undefined:                                     // finalise the in-progress pick
    index = readIndex; rejectUnmergedIndex(index.entries) // stage>0 -> MERGE_HAS_CONFLICTS
    if tree(index) == tree(ourId) && !opts.allowEmpty:
        -> re-stop as { kind: 'empty', commit: C, remaining: count(todo) }   // still redundant
    id = commitResolvedPick(C, ourId, index, opts)
    clearCherryPickHead(); clearMergeMsg()
    applied.push({ source: C, created: id }); ourId = id
  // else: C was already committed via repo.commit; resume the remaining todo
  if todo is undefined or empty: clearSequencer(); return { kind:'picked', commits: applied }
  seq = { multiPick: true, sequenceHead: readSequencerHead() }
  rest = runSequence(todo, head.target, ourId, opts, seq)
  return mergePickedLists(applied, rest)
```

`commitResolvedPick` builds the tree from the **resolved index** (not a synthetic
merged tree — the user may have edited the resolution), parent = `ourId`,
author = `C.author` (preserved), committer = current, message = `MERGE_MSG`
draft (or the user override via a future `--edit`; v1 always uses the draft).
This is **not** a thin wrap of `commit` (unlike `continueMerge`): `commit` would
read `MERGE_HEAD` and add a second parent. Cherry-pick reuses `commit`'s
*helpers* (`rejectUnmergedIndex`, tree-from-index, `resolveCommitter`) but owns
its own single-parent commit construction with the preserved author.

### 5.1 Resume options precedence

`continue`/`skip` resume the remaining picks, which need the original
`recordOrigin` / `allowEmpty`. `resolveResumeOpts(input)`:

- **multi-pick** (a `.git/sequencer/opts` exists): read it; it is the source of
  truth (matches git, which does not re-accept `-x`/`--allow-empty` on
  `--continue`). The `input` is ignored when opts are on disk.
- **single-pick** (no sequencer dir — a lone conflicting/empty pick): there is
  nothing left to resume, so the only option that matters is `allowEmpty` for an
  empty-stop finalisation, taken from `input` (`recordOrigin` is irrelevant — the
  `-x` line, if requested, was already in the persisted `MERGE_MSG` draft).

`writeSequencerOpts` is a tsgit-internal key=value file (`recordOrigin`,
`allowEmpty` booleans) — part of the §2.2 "sequencer is tsgit-internal"
faithfulness boundary, not git's `opts` format.

## 6. `skip` / `abort`

`skip`:
```
  C = readCherryPickHead; if undefined -> noOperationInProgress('cherry-pick')
  // discard the current pick: hard-reset index+worktree to HEAD (drop the
  // half-applied resolution), clear CHERRY_PICK_HEAD + MERGE_MSG
  resetIndexAndWorktreeTo(tree(HEAD))
  clearCherryPickHead(); clearMergeMsg()
  remaining = readSequencerTodo()
  if empty: clearSequencer(); return { kind:'picked', commits: [] }
  return runSequence(remaining, branch, HEADid, opts, { sequenceHead: readSequencerHead() })
```

`abort`:
```
  C = readCherryPickHead; if undefined -> noOperationInProgress('cherry-pick')
  head = readHeadRaw; if not symbolic -> unsupportedOperation
  seqHead = readSequencerHead() ?? resolveRef(head.target)   // multi-pick: pre-sequence HEAD; single: current HEAD
  resetToCommit(seqHead)                       // hard reset worktree+index+ref to seqHead's tree
  updateRef(head.target, seqHead, { reflogMessage: 'cherry-pick: aborted' })
  clearCherryPickHead(); clearMergeMsg(); clearSequencer()
  return { head: seqHead, branch: head.target }
```

`abort`'s hard-reset machinery mirrors `abortMerge`'s inlined `resetToOrigHead`
(materializeTree with `force + forceRewriteAll`, sparse matcher honored), so it
can bypass `assertNoPendingOperation` (which would fire on the very
`CHERRY_PICK_HEAD` it clears). For a **single**-commit pick (no sequencer dir),
`abort` resets to `CHERRY_PICK_HEAD`'s parent? No — to `HEAD` itself, since a
single conflicting pick never advanced `HEAD`. So `seqHead` falls back to the
current `HEAD` when no sequencer head is on disk: `seqHead = readSequencerHead()
?? ourId`. This keeps single-pick `abort` working (resets the conflicted working
tree to HEAD).

## 7. Revision expansion — `expandRevisions`

Each `commits[]` arg:
- **no range operator** (`..`, `...`, leading `^`) → resolve one commit-ish via
  the shared `resolveTarget` ladder (40-hex | `refCandidates` DWIM | tag peel),
  reused from `merge.ts` (extract to `commands/internal/commit-ish.ts`).
- **`A..B`** → commits reachable from `B` but not `A`, **oldest-first**. Compute
  via `walkCommits` from `B`, excluding the ancestor set of `A`, then reverse.
- **`A...B`** (symmetric) and bare `^A B` forms → v1 supports `A..B` and single
  revs; `...`/multi-`^` are deferred (§11) and rejected with `INVALID_OPTION`
  rather than silently mis-expanding.

Expansion is capped by `walkCommits`'s existing `MAX_WALK_QUEUE_SIZE`.

### 7.1 Merge commits — upfront rejection (deliberate divergence)

`assertNoMergeCommits(todo)` reads every queued commit and throws
`CHERRY_PICK_MERGE_NO_MAINLINE` (carrying the first offending oid) if any has
≥2 parents — **before any pick is applied**. Git instead applies up to the merge
commit and *then* stops, leaving a partially-advanced HEAD. tsgit follows its own
**validate-all-then-execute** idiom (as in `mv` / `rm` / `stash`): a range that
cannot complete cleanly applies *nothing*, so the operation is atomic. This is a
conscious, safety-motivated divergence from git's partial-apply — recorded as a
design decision (→ ADR) rather than a faithfulness bug.

## 8. New / changed modules

**New:**
- `src/application/commands/cherry-pick.ts` — `cherryPickRun/Continue/Skip/Abort`
  + result/input types. ~Mirrors `merge.ts` + `abort-merge.ts` in size; extract
  shared helpers to keep each function < 20 lines.
- `src/application/commands/internal/cherry-pick-state.ts` —
  `writeCherryPickHead`/`readCherryPickHead`/`clearCherryPickHead` +
  `writeSequencerHead`/`readSequencerHead`/`writeSequencerTodo`/
  `readSequencerTodo`/`writeSequencerOpts`/`readSequencerOpts`/`clearSequencer`.
  (`MERGE_MSG` helpers reused from `internal/merge-state.ts`.)
- `src/application/commands/internal/clean-work-tree.ts` — `assertCleanWorkTree`
  (git's `require_clean_work_tree`: index tree == HEAD tree && working tree ==
  index, no stage>0). Reusable by `revert`/`rebase`.
- `src/application/commands/internal/cherry-pick-namespace.ts` —
  `bindCherryPickNamespace` + `CherryPickNamespace`.
- `src/application/commands/internal/commit-ish.ts` — `resolveCommitIsh`
  (extracted from `merge.ts`'s `resolveTarget`; `merge` re-imports it).
- `src/domain/sequencer/todo.ts` — pure `serializeTodo(entries)` /
  `parseTodo(text)` for the `pick <oid> <subject>` grammar (round-trip pair →
  property test per CLAUDE.md).

**Changed:**
- `commit.ts` — extend the MERGE_HEAD "resolving commit may clear its marker"
  exception so a cherry-pick resolution committed via `repo.commit` (the manual
  path: edit, `add`, `commit`) also clears `CHERRY_PICK_HEAD` and does **not**
  add a second parent. (Cherry-pick's own `continue` is the primary path; this
  keeps the manual git workflow faithful.)
- `domain/commands/error.ts` — add `CHERRY_PICK_MERGE_NO_MAINLINE`.
- `commands/internal/repo-state.ts` already lists `CHERRY_PICK_HEAD`; no change.
- `commands/index.ts`, `repository.ts` — export + bind the namespace.
- `merge.ts` — import `resolveCommitIsh` from the extracted module (no behavior
  change; pure move, re-validated by existing merge tests).

## 9. `commit.ts` change — clearing `CHERRY_PICK_HEAD` without a second parent

`commit` currently special-cases `MERGE_HEAD`: it reads it, allows the pending-op
check to pass for `merge`, adds it as a second parent, and clears merge state.
For cherry-pick the marker must be *cleared* but **not** promoted to a parent.
Refactor:

```
mergeHead       = readMergeHead()
cherryPickHead  = readCherryPickHead()
except = mergeHead ? 'merge' : cherryPickHead ? 'cherry-pick' : undefined
assertNoPendingOperation(ctx, except ? { except } : {})
...
parents = buildParents(parentId, mergeHead)      // cherryPickHead is NOT a parent
...
if (mergeHead) clearMergeState()
if (cherryPickHead) { clearCherryPickHead(); clearMergeMsg() }  // + sequencer? No — manual
```

The manual `commit` path resolves **one** pick; it does not own the sequencer
work-list (that is `cherryPick.continue`'s job). So `commit` clears only the
single-pick markers and leaves the sequencer dir intact. A user who resolves a
mid-range conflict with `repo.commit` instead of `cherryPick.continue` then calls
`cherryPick.continue` — which, finding `CHERRY_PICK_HEAD` already cleared but the
sequencer todo non-empty (§5), resumes the remaining commits. This makes the
manual path faithful to git (`git commit` then `git cherry-pick --continue`).
The reflog message for a cherry-pick resolved via `commit` stays `commit:` —
only `cherryPick.run/continue`'s own commits use `cherry-pick:`.

## 10. Testing strategy

- **Unit** (`test/unit/application/commands/cherry-pick.test.ts`): clean single
  pick (author preserved, committer current, single parent, branch advanced,
  reflog `cherry-pick:`); `-x` origin line; conflict stop (CHERRY_PICK_HEAD +
  MERGE_MSG + stage1/2/3 + markers, `remaining`); empty stop + `allowEmpty`
  commit; range clean (N commits, order); range conflict → continue → finish;
  skip; abort (single + sequence); every refusal in §3.2 (isolated guard tests
  per CLAUDE.md mutation rules); root-commit pick (empty base).
- **State unit** (`cherry-pick-state.test.ts`): each read/write/clear; absent →
  undefined; corrupt oid → INVALID_OBJECT_ID; idempotent clear.
- **Sequencer todo** (`domain/sequencer/todo.test.ts` + `.properties.test.ts`):
  example encodings + round-trip property `parse(serialize(x)) ≡ x` (round-trip
  pair lens, 200 runs).
- **commit.ts** regression: resolving a cherry-pick via `repo.commit` clears
  `CHERRY_PICK_HEAD`, single parent, no MERGE behavior leakage.
- **Interop** (`test/integration/cherry-pick-interop.test.ts`): tsgit
  `cherryPick.run` vs real `git cherry-pick` — compare resulting HEAD tree,
  commit author/committer/message, parent count, and index/worktree via the
  `interop-helpers` readback (`git ls-files --stage`, `git rev-parse`,
  `git cat-file commit`). Co-refusal proofs (merge-commit without `-m`; dirty
  index). `-x` provenance-line byte-parity. Range pick parity. Register
  `cherryPick` as a `@writes` surface for `audit-write-surfaces`.
- **Coverage** 100% line/branch/func/stmt; **mutation** 0 killable.

## 11. Deferred (explicitly out of 22.1 scope)

- Picking merge commits (`-m <parent>` / mainline). Rejected with a faithful
  error today; `revert` (22.2) and `rebase` (22.3) will revisit.
- `--signoff`, `--edit`, `--no-commit`, `--ff`, `--keep-redundant-commits`.
- `A...B` symmetric-difference and multi-`^` range forms (single rev + `A..B`
  ship; others rejected, not mis-expanded).
- Cross-tool resume (start in tsgit → `git cherry-pick --continue`). The
  *conflict state* git reads is faithful; the sequencer work-list is not git's
  byte format.
- Git's native `.git/sequencer/opts` byte format. tsgit persists its **own**
  key=value opts file (recordOrigin/allowEmpty) for multi-pick resume (§5.1); it
  is not git's format and is not cross-tool readable.

## 12. Key design decisions (→ ADRs)

1. **Namespace `repo.cherryPick.{run,continue,abort,skip}`** vs single callable —
   nested namespace (ADR-181 lineage). → ADR.
2. **Range continuation via a tsgit-internal `.git/sequencer/` work-list**;
   faithful conflict state, non-faithful sequencer bytes; no cross-tool resume.
   → ADR.
3. **v1 flag set** = `recordOrigin` (-x) + `allowEmpty`; mainline/signoff/edit/
   no-commit deferred. → ADR.
4. **Dedicated `CHERRY_PICK_HEAD` state machine** (single-parent commit,
   preserved author) distinct from the `MERGE_HEAD` machine; `commit` clears the
   marker without promoting it to a parent. → ADR.
5. **Validate-all-then-execute for merge commits in a range** — reject the whole
   range upfront if any commit is a merge, applying nothing (atomic), a
   deliberate divergence from git's partial-apply-then-stop (§7.1). → ADR.
