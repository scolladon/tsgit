# Design — `cherry-pick` (single + range)

> On-disk behaviour in this doc is **empirically derived** from real `git`
> (probed against git's actual `.git/sequencer/*`, `CHERRY_PICK_HEAD`,
> `MERGE_MSG`, reflog, and `-x`/`-n` output), not inferred. Every byte-format
> claim is pinned by the interop suite (§10).

## 1. Goal

Apply the change introduced by one or more existing commits onto the current
`HEAD`, creating one new commit per picked commit. Faithful to `git cherry-pick`:

- Each new commit **preserves the original author** (name/email/timestamp/tz
  verbatim) and **the original message**; the **committer** becomes the current
  identity (config `user.*`, current time).
- The new commit is a **single-parent** commit (parent = the advancing `HEAD`),
  *not* a two-parent merge commit. This is the load-bearing difference from
  `merge` (which makes a two-parent commit via `MERGE_HEAD`).
- The patch is a **3-way merge**: `base = parent(C)`, `ours = HEAD`, `theirs = C`
  (root commit → empty base). Conflicts persist on disk (markers + stage-1/2/3
  index entries) under a dedicated `CHERRY_PICK_HEAD` machine, parallel to but
  distinct from the 20.4 `MERGE_HEAD` machine.
- A **range** (`A..B`) or **multi-arg list** expands oldest-first and is applied
  one commit at a time. A conflict / empty / merge-commit stop is **resumable**:
  `continue` finalises and picks up the rest, `skip` drops the current one,
  `abort` resets to the pre-sequence `HEAD`.
- The multi-pick **sequencer state is git-byte-faithful and bidirectionally
  cross-tool resumable** (decision via ADR): a tsgit-started range can be
  resumed by `git cherry-pick --continue/--skip/--abort`, and a git-started
  range can be resumed by `repo.cherryPick.*`.

Non-goals for 22.1 (deferred — §11): picking merge commits **with** a chosen
mainline (`-m`), `--signoff`, `--edit`, `--ff`, `--keep-redundant-commits`,
`A...B` / multi-`^` range forms.

## 2. Faithful data model (git on-disk, verified)

### 2.1 In-progress single-pick state (read by `git status`)

| File | Bytes | Written when | Cleared when |
|---|---|---|---|
| `.git/CHERRY_PICK_HEAD` | `<oid>\n` (40-hex + LF) | a pick conflicts or stops empty | continue / skip / abort / resolving commit |
| `.git/MERGE_MSG` | message draft (§2.3) | same | same |
| index stage 1/2/3 | base/ours/theirs unmerged entries | a pick conflicts | `add` resolves → stage 0 |
| working tree | `<<<<<<<` conflict markers | a pick conflicts | user edits |

`CHERRY_PICK_HEAD` is already in `PENDING_MARKERS`; `OPERATION_IN_PROGRESS` /
`NO_OPERATION_IN_PROGRESS` already carry `'cherry-pick'`. A **single-commit**
pick writes *only* these single-pick files — **no** `.git/sequencer/` dir
(verified: `git cherry-pick <one>` on conflict leaves only `CHERRY_PICK_HEAD`).

### 2.2 Multi-pick sequencer state (git-byte-faithful)

Written only by a **range / multi-arg** run, and only **on a stop** (a fully
clean range applies all commits and leaves no dir — matching git's net
create-then-remove). All files match git's exact bytes:

| File | Bytes (verified) | Purpose |
|---|---|---|
| `.git/sequencer/head` | pre-sequence `HEAD` `<oid>\n` | `abort` reset target (immutable for the whole sequence) |
| `.git/sequencer/todo` | `pick <oid> <subject>\n` per line; **line 0 = current/next** instruction, completed picks removed from the front | `continue`/`skip` work-list |
| `.git/sequencer/abort-safety` | current `HEAD` `<oid>\n` (advances per completed pick) | detect external HEAD movement before an `abort` rollback |
| `.git/sequencer/opts` | git-config `[options]` section, TAB-indented `key = value`; only **non-default** keys (`no-commit`, `record-origin`, `allow-empty`) | resume options |

Verified omissions: git writes **no `done` file** for cherry-pick (completed
picks vanish from the front of `todo`); `opts` is **absent** when all options are
default.

**OID width in `todo` (the one deliberate deviation):** git writes 7-char
abbreviated oids; tsgit writes **full 40-hex** oids. Verified that
`git cherry-pick --continue` resumes a full-oid todo unchanged (git re-resolves
each oid), so this preserves tsgit→git resumability while being unambiguous and
abbreviation-drift-free. The reverse (git→tsgit) requires tsgit to resolve git's
abbreviated oids → the new `resolveOidPrefix` primitive (§8).

### 2.3 `MERGE_MSG` draft on conflict (verified bytes)

```
<source message>

# Conflicts:
#	<path-1>
#	<path-2>
```

i.e. `messageDraft(C, opts)` + `"\n\n# Conflicts:\n"` + one `"#\t<path>\n"` per
conflicted path (note the literal TAB). `messageDraft` already folds in the `-x`
line (§4) so the persisted draft is exactly what `continue` commits.

## 3. API surface — nested namespace `repo.cherryPick.*`

Frozen, non-callable nested namespace (ADR-193) + ADR-210 stash precedent. Run
verb = `run` (per ADR). Four verbs:

```ts
repo.cherryPick.run(input: CherryPickRunInput): Promise<CherryPickResult>
repo.cherryPick.continue(input?: CherryPickContinueInput): Promise<CherryPickResult>
repo.cherryPick.skip(): Promise<CherryPickResult>
repo.cherryPick.abort(): Promise<CherryPickAbortResult>
```

### 3.1 Inputs / results

```ts
interface CherryPickRunInput {
  /** Revisions to pick, in argument order — exactly git's argv. A single
   *  commit-ish ('abc123', '9dac856', 'feature', 'HEAD~2') picks one commit; an
   *  'A..B' entry is a range expanded oldest-first. Concatenated in arg order.
   *  '...'/multi-'^' forms are rejected (§7), not mis-expanded. */
  readonly commits: ReadonlyArray<string>;
  /** -x: append `(cherry picked from commit <full-oid>)` to each message. */
  readonly recordOrigin?: boolean;
  /** --allow-empty: a redundant pick creates an empty commit instead of stopping. */
  readonly allowEmpty?: boolean;
  /** -n / --no-commit: apply to index + working tree only; never commit, never
   *  persist sequencer/CHERRY_PICK_HEAD state (§6). */
  readonly noCommit?: boolean;
}

interface CherryPickContinueInput {
  /** Single-pick resume fallback only; a multi-pick sequence reads its persisted
   *  `.git/sequencer/opts`, which takes precedence (§5.1). */
  readonly allowEmpty?: boolean;
  readonly recordOrigin?: boolean;
}

interface CherryPickedCommit { readonly source: ObjectId; readonly created: ObjectId; }
interface CherryPickConflict { readonly path: FilePath; readonly type: ConflictType; }

type CherryPickResult =
  | { readonly kind: 'picked'; readonly commits: ReadonlyArray<CherryPickedCommit> }
  | { readonly kind: 'no-commit'; readonly sources: ReadonlyArray<ObjectId> }       // -n: staged, uncommitted
  | { readonly kind: 'conflict'; readonly commit: ObjectId;
      readonly conflicts: ReadonlyArray<CherryPickConflict>; readonly remaining: number }
  | { readonly kind: 'empty'; readonly commit: ObjectId; readonly remaining: number };

interface CherryPickAbortResult { readonly head: ObjectId; readonly branch: RefName; }
```

`kind:'picked'` lists commits applied in *this call* (a `continue` returns only
what it completed). `conflict`/`empty`/`no-commit` are returned, never thrown
(consistent with `merge`/`stash`).

### 3.2 Refusals (thrown `TsgitError`)

| Condition | Code | git parity |
|---|---|---|
| `run` while any pending-op marker exists | `OPERATION_IN_PROGRESS` | `assertNoPendingOperation` |
| `run` with a dirty index/work-tree | `WORKING_TREE_DIRTY` (paths) | `require_clean_work_tree` |
| a pick would overwrite a dirty path | `WORKING_TREE_DIRTY` (paths) | `applyMergeToWorktree` `would-overwrite` |
| picking a merge commit (≥2 parents) | `CHERRY_PICK_MERGE_NO_MAINLINE` (commit) | "is a merge but no -m option was given" |
| ambiguous abbreviated oid arg / todo line | `AMBIGUOUS_OID_PREFIX` (prefix, candidates) | "short SHA1 … is ambiguous" |
| `continue`/`skip` with nothing in progress | `NO_OPERATION_IN_PROGRESS` (`cherry-pick`) | "no cherry-pick … in progress" |
| `continue` with unresolved index (stage>0) | `MERGE_HAS_CONFLICTS` | `commit`'s `rejectUnmergedIndex` |
| `abort` with nothing in progress | `NO_OPERATION_IN_PROGRESS` (`cherry-pick`) | |
| detached HEAD | `UNSUPPORTED_OPERATION` (`cherry-pick`) | mirrors `merge` |
| unborn branch | `NO_INITIAL_COMMIT` | nothing to pick onto |

### 3.3 Wiring

`bindCherryPickNamespace(ctx, guard)` (mirrors `bindStashNamespace`);
`repo.cherryPick` slot between `checkout` and `clone` (alphabetical), typed
`commands.CherryPickNamespace`.

## 4. `run` algorithm

```
run(input):
  assertRepository; assertNotBare('cherry-pick'); assertNoPendingOperation
  head = readHeadRaw
  if head not symbolic -> unsupportedOperation('cherry-pick', 'detached HEAD')
  ourId = resolveHeadCommit(head)               // NO_INITIAL_COMMIT if unborn
  todo  = expandRevisions(input.commits)        // resolveCommitIsh per arg; A..B oldest-first
  assertCleanWorkTree(ourId)                     // git's require_clean_work_tree
  if input.noCommit: return runNoCommit(todo, input)         // §6 — never touches the state machine
  return runSequence(todo, head.target, ourId, input, { multiPick: todo.length > 1, sequenceHead: ourId })
```

`runSequence` (shared by run / continue / skip):

```
runSequence(todo, branch, ourId, opts, seq):
  applied = []
  for i in 0..todo.length:
    C = todo[i]
    if isMergeCommit(C):                         // partial-apply: earlier picks already committed
      if seq.multiPick: writeSequencer(seq.sequenceHead, todo.slice(i), ourId, opts)  // todo[0]=merge, NO CHERRY_PICK_HEAD
      throw cherryPickMergeNoMainline(C)         // single merge-commit pick writes no dir (matches git)
    outcome = applyOnePick(C, branch, ourId, opts)
    if outcome.kind == 'committed':
      applied.push({ source: C, created: outcome.id }); ourId = outcome.id; continue
    // conflict | empty -> persist resume state and stop
    persistStop(C, todo.slice(i), seq, ourId, opts)            // CHERRY_PICK_HEAD + MERGE_MSG; if seq.multiPick also writeSequencer(todo[0]=C)
    return { kind: outcome.kind, commit: C, conflicts?, remaining: todo.length-(i+1) }
  clearAllState()                                 // whole work-list consumed (no-op if nothing written)
  return { kind: 'picked', commits: applied }
```

`applyOnePick(C, branch, ourId, opts)` (commit path):

```
baseTree   = parent(C) ? tree(parent(C)) : undefined        // root -> empty base
res = within index lock: applyMergeToWorktree({ baseTree, oursTree: tree(ourId), theirsTree: tree(C), currentIndex })
  if res == would-overwrite -> throw workingTreeDirty(res.paths)
  if res == conflict        -> lock.commit(res.indexEntries); return { kind:'conflict', conflicts: res.conflicts }
  // clean
  if res.mergedTree == tree(ourId) && !opts.allowEmpty -> return { kind:'empty' }     // redundant pick
  lock.commit(res.result.newIndexEntries)                   // stage 0 — picked change staged
  id = createPickCommit(C, ourId, res.mergedTree, opts)
  updateRef(branch, id, { expected: ourId, reflogMessage: `cherry-pick: ${subject(C)}` })   // clean auto-pick reflog
  return { kind:'committed', id }
```

`createPickCommit(C, parentId, tree, opts)`:

```
cData = readCommit(C)
message = messageDraft(C, opts)                             // -x line folded in
return createCommit({ tree, parents: [parentId],
                      author: cData.author,                  // preserved verbatim
                      committer: resolveCommitter(config.user, now),
                      message: sanitizeMessage(message), extraHeaders: [] })

messageDraft(C, opts) = opts.recordOrigin
  ? appendCherryPickOrigin(C.message, C)                    // C.message + "\n\n(cherry picked from commit <full-40-hex>)"
  : C.message
```

`appendCherryPickOrigin` matches git's verified output: a blank line then
`(cherry picked from commit <full-oid>)`, with the standard trailer-adjacency
rule (no extra blank line when the body already ends in a trailer block). Pinned
byte-for-byte by interop (§10).

## 5. `continue` algorithm

```
continue(input):
  assertRepository; assertNotBare('cherry-pick --continue')
  C    = readCherryPickHead                       // may be undefined (merge-stop, or resolved via repo.commit)
  todo = readSequencerTodo()                       // may be undefined (single-pick / none); oids resolved via resolveOidPrefix
  if C === undefined && (todo undefined or empty) -> noOperationInProgress('cherry-pick')
  opts = resolveResumeOpts(input)                  // §5.1
  head = readHeadRaw; ourId = resolveRef(head.target)
  applied = []
  if C !== undefined:                              // finalise the conflicted pick from the resolved index
    index = readIndex; rejectUnmergedIndex(index.entries)
    if tree(index) == tree(ourId) && !opts.allowEmpty -> re-stop { kind:'empty', commit:C, remaining: count(todo)-1 }
    id = commitResolvedPick(C, ourId, index, opts) // reflog `commit (cherry-pick): <subject>`
    clearCherryPickHead(); clearMergeMsg()
    applied.push({ source:C, created:id }); ourId = id
    todo = todo without its line 0 (== C)          // drop the finished instruction
  // else: C already committed (merge-stop / manual repo.commit) -> apply todo[0] fresh
  if todo undefined or empty: clearAllState(); return { kind:'picked', commits: applied }
  rest = runSequence(todo, head.target, ourId, opts, { multiPick:true, sequenceHead: readSequencerHead() })
  return mergePickedLists(applied, rest)
```

`commitResolvedPick` builds the tree from the **resolved index** (the user may
have edited the resolution), parent = `ourId`, author = `C.author` (preserved),
committer = current, message = `MERGE_MSG` draft, **reflog
`commit (cherry-pick): <subject>`** (verified — distinct from the clean auto-pick
`cherry-pick:` reflog). It is **not** a thin wrap of `commit` (which would read
`MERGE_HEAD` and add a second parent); it reuses `commit`'s *helpers*
(`rejectUnmergedIndex`, tree-from-index, `resolveCommitter`) but constructs its
own single-parent commit with the preserved author.

### 5.1 Resume-options precedence

`resolveResumeOpts(input)`: a multi-pick sequence reads `.git/sequencer/opts`
(`record-origin`/`allow-empty`/`no-commit`) — source of truth, matching git
(which does not re-accept these on `--continue`); `input` is ignored when opts
exist. A single-pick resume (no sequencer dir) has nothing left to resume, so
only `allowEmpty` (for an empty-stop finalisation) is taken from `input`. The
opts file is git-config `[options]` format — read/written through the existing
20.6 config text helpers (`*InText`), keeping one config serializer.

## 6. `skip`, `abort`, `runNoCommit`

`skip`:
```
  C = readCherryPickHead; todo = readSequencerTodo()
  if C undefined && (todo undefined or empty) -> noOperationInProgress('cherry-pick')
  resetIndexAndWorktreeTo(tree(HEAD))             // discard the current pick's half-applied state
  clearCherryPickHead(); clearMergeMsg()
  todo = todo without line 0                       // drop the skipped instruction
  if todo undefined or empty: clearAllState(); return { kind:'picked', commits: [] }
  return runSequence(todo, branch, HEADid, resolveResumeOpts(), { multiPick:true, sequenceHead: readSequencerHead() })
```

`abort`:
```
  C = readCherryPickHead; todo = readSequencerTodo()
  if C undefined && todo undefined -> noOperationInProgress('cherry-pick')
  head = readHeadRaw; if not symbolic -> unsupportedOperation
  seqHead = readSequencerHead() ?? resolveRef(head.target)   // multi: pre-sequence HEAD; single: current HEAD
  resetToCommit(seqHead)                           // hard reset worktree+index+ref (force + forceRewriteAll, sparse-honoring)
  updateRef(head.target, seqHead, { reflogMessage: 'cherry-pick: aborted' })
  clearAllState()
  return { head: seqHead, branch: head.target }
```

`abort`'s reset mirrors `abortMerge`'s inlined `resetToOrigHead`, so it can
bypass `assertNoPendingOperation` (which would fire on the very state it clears).

`runNoCommit(todo, opts)` (`-n` — verified: no commits, no state, even on conflict):
```
  lock = acquireIndexLock
  for C in todo:                                   // ours = the ACCUMULATING index, not a commit
    if isMergeCommit(C) -> throw cherryPickMergeNoMainline(C)
    res = applyMergeToWorktree({ baseTree: tree(parent(C)), oursTree: synth(currentIndex), theirsTree: tree(C), currentIndex })
    if res == would-overwrite -> throw workingTreeDirty(res.paths)
    if res == conflict: lock.commit(res.indexEntries); return { kind:'conflict', commit:C, conflicts, remaining }  // NO CHERRY_PICK_HEAD / sequencer
    lock.commit(res.result.newIndexEntries)        // accumulate into the index
  return { kind:'no-commit', sources: todo }
```

`clearAllState()` removes `CHERRY_PICK_HEAD`, `MERGE_MSG`, and the
`.git/sequencer/` dir; idempotent (missing files are not an error).

## 7. Revision expansion — `expandRevisions`

Per `commits[]` arg:
- **single commit-ish** → `resolveCommitIsh` ladder: 40-hex | **abbreviated oid
  via `resolveOidPrefix`** | `refCandidates` DWIM | tag peel (extracted from
  `merge.ts`'s `resolveTarget`, extended with prefix resolution; `merge`
  re-imports it).
- **`A..B`** → commits reachable from `B` but not `A`, **oldest-first**
  (`walkCommits` from `B` minus `A`'s ancestor set, reversed). Capped by
  `MAX_WALK_QUEUE_SIZE`.
- **`A...B` / multi-`^`** → rejected with `INVALID_OPTION` (deferred, §11) — not
  mis-expanded.

### 7.1 Merge commits in a range — git-faithful partial-apply (verified)

Per ADR, tsgit matches git exactly: it applies and **commits** every non-merge
commit *before* the merge, then **stops at** the merge commit — persisting the
sequencer state (`todo[0]` = the merge, `head`, `abort-safety`, `opts`; **no**
`CHERRY_PICK_HEAD`, since the merge pick never began) — and throws
`CHERRY_PICK_MERGE_NO_MAINLINE`. The partial result stands; the user runs
`skip` (drops the merge, resumes) or `abort` (resets to the pre-sequence HEAD).
`continue` with `CHERRY_PICK_HEAD` absent re-attempts `todo[0]` (the merge) and
re-throws — exactly git's loop.

## 8. New / changed modules

**New:**
- `src/application/commands/cherry-pick.ts` — `cherryPickRun/Continue/Skip/Abort`
  + types. Extract helpers to keep each function < 20 lines.
- `src/application/commands/internal/cherry-pick-state.ts` —
  `read/write/clearCherryPickHead` + `conflictMergeMsg(draft, paths)` (§2.3).
- `src/application/commands/internal/sequencer-state.ts` — git-byte-faithful
  `.git/sequencer/` I/O: `read/writeSequencerHead`, `read/writeSequencerTodo`
  (delegates grammar to `domain/sequencer/todo`, resolves oids via
  `resolveOidPrefix`), `read/writeAbortSafety`, `read/writeSequencerOpts` (via
  config `*InText`), `clearSequencer`. Reusable by `revert`/`rebase`.
- `src/application/commands/internal/clean-work-tree.ts` — `assertCleanWorkTree`
  (`require_clean_work_tree`): index tree == HEAD tree && working tree == index,
  no stage>0. Reuses `synthesizeTreeFromIndex` + `compareWorkingTreeEntry`.
- `src/application/commands/internal/cherry-pick-namespace.ts` —
  `bindCherryPickNamespace` + `CherryPickNamespace`.
- `src/application/commands/internal/commit-ish.ts` — `resolveCommitIsh`.
- `src/application/primitives/resolve-oid-prefix.ts` — `resolveOidPrefix(ctx,
  prefix)`: scan loose objects (`<2>/<38>`) + pack-index fanout for entries with
  the hex prefix; **exactly one** → full `ObjectId`; **>1** →
  `ambiguousOidPrefix(prefix, candidates)`; **0** → `objectNotFound`. Prefix
  length 4–40 (git's `core.abbrev` minimum is 4). Candidate list capped.
- `src/domain/sequencer/todo.ts` — pure `serializeTodo(entries)` /
  `parseTodo(text)` for `pick <oid> <subject>\n` (writes full oids; parses full
  OR abbreviated, leaving resolution to the command). Round-trip property test.

**Changed:**
- `commit.ts` — read `CHERRY_PICK_HEAD`; allow the pending-op check to pass for
  `cherry-pick`; **do not** add it as a parent; clear it (+ `MERGE_MSG`) on
  success; reflog `commit (cherry-pick): <subject>` when it was set (verified).
  Leaves the sequencer dir for `cherryPick.continue` (§9).
- `domain/commands/error.ts` — add `CHERRY_PICK_MERGE_NO_MAINLINE { commit }` and
  `AMBIGUOUS_OID_PREFIX { prefix, candidates }`.
- `merge.ts` — import `resolveCommitIsh` (pure move; existing merge tests guard).
- `rev-parse.ts` — `resolveBase` falls through to `resolveOidPrefix` for a
  4–39-char hex base (bonus faithfulness: `rev-parse <short-oid>` now resolves).
- `commands/index.ts`, `repository.ts` — export + bind the namespace.

## 9. `commit.ts` — clearing `CHERRY_PICK_HEAD` without a second parent

```
mergeHead      = readMergeHead()
cherryPickHead = readCherryPickHead()
except = mergeHead ? 'merge' : cherryPickHead ? 'cherry-pick' : undefined
assertNoPendingOperation(ctx, except ? { except } : {})
...
parents = buildParents(parentId, mergeHead)        // cherryPickHead is NOT a parent
reflog  = cherryPickHead ? `commit (cherry-pick): ${subject}` : commitReflogMessage(...)
...
if mergeHead      -> clearMergeState()
if cherryPickHead -> { clearCherryPickHead(); clearMergeMsg() }   // sequencer dir left intact
```

A user who resolves a mid-range conflict with `repo.commit` (instead of
`cherryPick.continue`) then calls `cherryPick.continue` — which, finding
`CHERRY_PICK_HEAD` cleared but the sequencer `todo` non-empty (§5), resumes the
remaining commits. This is exactly git's `git commit` → `git cherry-pick
--continue` flow. At most one of `mergeHead`/`cherryPickHead` is ever set
(`assertNoPendingOperation` blocks starting a cherry-pick during a merge).

## 10. Testing strategy

- **Unit** (`cherry-pick.test.ts`): clean single pick (author preserved,
  committer current, single parent, branch advanced, `cherry-pick:` reflog);
  `-x` origin line; `--allow-empty`; `-n` (staged, HEAD unchanged, no state);
  conflict stop (`CHERRY_PICK_HEAD` + `MERGE_MSG` conflicts block + stage1/2/3 +
  markers + `remaining`); empty stop; root-commit pick (empty base); range clean
  (order + N commits); range conflict → continue (`commit (cherry-pick):`
  reflog) → finish; skip; abort (single + sequence); merge-commit partial-apply
  stop; every §3.2 refusal as an **isolated** guard test.
- **State units**: `cherry-pick-state` (read/write/clear; absent → undefined;
  corrupt oid → `INVALID_OBJECT_ID`); `sequencer-state` (head/todo/abort-safety/
  opts round-trip; byte layout); `clean-work-tree` (each dirty branch isolated).
- **`resolveOidPrefix`** (`resolve-oid-prefix.test.ts`): unique loose; unique
  pack; spanning both; ambiguous (≥2) → `AMBIGUOUS_OID_PREFIX`; none →
  `objectNotFound`; min/max length bounds.
- **Property** (`domain/sequencer/todo.properties.test.ts`): round-trip
  `parseTodo(serializeTodo(x)) ≡ x` (round-trip pair lens, 200 runs);
  `<oid>/<subject>` arbitraries in a shared `arbitraries.ts`.
- **`commit.ts` regression**: resolving a cherry-pick via `repo.commit` clears
  `CHERRY_PICK_HEAD`, single parent, `commit (cherry-pick):` reflog, no MERGE
  leakage.
- **Interop** (`cherry-pick-interop.test.ts`, register `cherryPick` as a
  `@writes` surface): tsgit `run` vs `git cherry-pick` — HEAD tree, commit
  author/committer/message, parent count, index/worktree readback; `-x`
  byte-parity; range parity; co-refusals (merge w/o -m, dirty tree). **Cross-tool
  resume both ways:** tsgit-started range conflict → `git cherry-pick
  --continue/--skip/--abort` completes it; git-started range conflict →
  `repo.cherryPick.continue/skip/abort` completes it (proves byte-faithful
  sequencer + `resolveOidPrefix`).
- **Coverage** 100%; **mutation** 0 killable.

## 11. Deferred (out of 22.1 scope)

- `-m`/mainline (picking merge commits with a chosen parent); `--signoff`,
  `--edit`, `--ff`, `--keep-redundant-commits`, `--gpg-sign`.
- `A...B` symmetric-difference & multi-`^` range forms (rejected, not
  mis-expanded).
- git's `core.abbrev` dynamic abbreviation in the todo (tsgit writes full oids;
  git re-resolves — §2.2).
- git's `.git/sequencer/done` file (git writes none for cherry-pick — §2.2).

## 12. Key design decisions (→ ADRs)

1. **Namespace `repo.cherryPick.{run,continue,abort,skip}`**, run verb `run`
   (ADR-193/210 lineage).
2. **git-byte-faithful, bidirectionally cross-tool-resumable sequencer**
   (`head`/`todo`/`abort-safety`/`opts`, full-oid todo, no `done`); requires the
   `resolveOidPrefix` primitive for the git→tsgit direction.
3. **v1 flag set** = `recordOrigin` (-x) + `allowEmpty` + `noCommit` (-n);
   mainline/signoff/edit/ff deferred.
4. **Dedicated `CHERRY_PICK_HEAD` state machine** (single-parent commit,
   preserved author, `commit (cherry-pick):` reflog) distinct from `MERGE_HEAD`;
   `commit` clears it without adding a parent.
5. **git-faithful partial-apply for merge commits in a range** (commit earlier
   picks, stop at the merge with sequencer state, no `CHERRY_PICK_HEAD`).
6. **New `resolveOidPrefix` primitive** (abbreviated-oid resolution), also wired
   into `rev-parse` and the cherry-pick commit-ish ladder.
