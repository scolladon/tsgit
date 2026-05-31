# Design — `revert` (single + range)

> On-disk behaviour in this doc is **empirically derived** from real `git`
> 2.54 (probed against `.git/sequencer/*`, `REVERT_HEAD`, `MERGE_MSG`, reflog,
> and range/empty/merge output), not inferred. Every byte-format claim is pinned
> by the interop suite (§10). Signing was disabled for every golden probe
> (`-c commit.gpgsign=false`).

## 1. Goal

Record one or more new commits that **undo** the changes introduced by existing
commits, onto the current `HEAD`. `revert` is the **inverse of `cherry-pick`**
(22.1) and reuses the same sequencer / state-machine / merge machinery; this doc
specifies only the deltas. Faithful to `git revert`:

- Each new commit is a **single-parent** commit (parent = the advancing `HEAD`).
- Both **author and committer become the current identity** (config `user.*`,
  current time) — *not* preserved from the reverted commit. This is the
  load-bearing difference from `cherry-pick` (which preserves the source author).
- The default message is `Revert "<subject>"\n\nThis reverts commit <full-oid>.\n`
  where `<subject>` is the **first line only** of the reverted commit (§4).
- The patch is the **reverse** 3-way merge: `base = C`, `ours = HEAD`,
  `theirs = parent(C)` (root commit → empty `theirs`). This is cherry-pick's
  merge with `base`/`theirs` swapped, applied through the same shared
  `applyMergeToWorktree` primitive. Conflicts persist on disk (markers +
  stage-1/2/3 entries) under a dedicated `REVERT_HEAD` machine.
- A **range** (`A..B`) or **multi-arg list** expands **newest-first** (the
  opposite of cherry-pick — to undo a span you revert its tip first) and is
  applied one commit at a time. A conflict / empty / merge-commit stop is
  resumable: `continue` finalises and picks up the rest, `skip` drops the
  current one, `abort` resets to the pre-sequence `HEAD`.
- The multi-revert **sequencer state is git-byte-faithful and bidirectionally
  cross-tool resumable** (ADR-218 lineage): a tsgit-started range resumes under
  `git revert --continue/--skip/--abort` and vice-versa. The todo command
  keyword is `revert` (not `pick`).

Non-goals for 22.2 (deferred — §11): reverting merge commits **with** a chosen
mainline (`-m`); `--signoff` (`-s`); `--edit` / `--no-edit` (we always use the
default message); `--gpg-sign`; `A...B` / multi-`^` range forms (rejected, not
mis-expanded); `--quit`.

## 2. Faithful data model (git on-disk, verified)

### 2.1 In-progress single-revert state

| File | Bytes | Written when | Cleared when |
|---|---|---|---|
| `.git/REVERT_HEAD` | `<oid>\n` (40-hex + LF) | a revert **conflicts** | continue / skip / abort / resolving commit |
| `.git/MERGE_MSG` | `Revert "…"` draft (§2.3) | same | same |
| index stage 1/2/3 | base/ours/theirs unmerged entries | a revert conflicts | `add` resolves → stage 0 |
| working tree | `<<<<<<<` conflict markers | a revert conflicts | user edits |

`REVERT_HEAD` is already in `PENDING_MARKERS` (`repo-state.ts`) and
`OPERATION_IN_PROGRESS` / `NO_OPERATION_IN_PROGRESS` already carry `'revert'`.
A **single-commit** revert writes *only* these files on a conflict — **no**
`.git/sequencer/` dir (verified). Unlike cherry-pick, an **empty** single revert
writes **nothing** (§2.4).

### 2.2 Multi-revert sequencer state

Written only by a **range / multi-arg** run, only **on a stop**. Identical files
and bytes to cherry-pick (`head` / `todo` / `abort-safety` / `opts`, no `done`,
`opts` absent when all options default), with the single difference that **todo
lines start with `revert`**:

```
revert <oid> <subject>
```

Verified: `git revert HEAD~1 HEAD~2` on a conflict writes
`revert <abbrev> <subject>` lines; line 0 is the current/next instruction. tsgit
writes **full** oids (git re-resolves either way — ADR-218); reads resolve git's
abbreviated oids via `resolveOidPrefix`. The `opts` file only ever carries
`no-commit` for revert (the sole non-default flag — §3).

### 2.3 `MERGE_MSG` draft on conflict (verified bytes)

```
Revert "<subject>"

This reverts commit <full-40-hex>.

# Conflicts:
#	<path-1>
```

i.e. `revertMessage(C)` (§4) + the shared `conflictMergeMsg` block (one
`"#\t<path>\n"` per conflicted path, literal TAB) — the **same**
`conflictMergeMsg` helper cherry-pick uses (`cherry-pick-state.ts`).

### 2.4 Empty-revert semantics (the key divergence — ADR-223)

`git revert` has **no `--allow-empty`**. A revert whose reverse-merge yields the
current tree unchanged (`mergedTree === oursTree`) is **empty**. Verified git
2.54 behaviour, faithfully matched:

| Situation | git behaviour (verified) | tsgit |
|---|---|---|
| **single** start-empty (clean, no conflict) | exits 1, *"nothing to commit, working tree clean"*, **no** `REVERT_HEAD`, **no** sequencer | `{ kind:'empty', commit, remaining:0 }`, no state written |
| **multi** start-empty (clean, mid-sequence) | **stops at** the empty commit — sequencer persisted (todo[0]=empty), **no** `REVERT_HEAD`, tree clean | `writeSequencerStop(todo[0]=empty)`, `{ kind:'empty', commit, remaining }` |
| empty stop → `--continue` | re-attempts, still empty → **drops it** and proceeds | continue drops the acknowledged leading empty, resumes (§5) |
| empty stop → `--skip` | drops it and proceeds | existing `skip` (drops todo[0]) |
| conflict resolved **to** empty → `--continue` | exits 1, *"nothing to commit"*, **keeps** `REVERT_HEAD` (await skip / `commit --allow-empty`) | continue re-stops `{ kind:'empty' }`, keeps `REVERT_HEAD` (§5) |
| keep an empty anyway | `git commit --allow-empty` | `repo.commit({ allowEmpty:true })` (clears `REVERT_HEAD`, §9) |

So an empty revert is modelled like cherry-pick's **merge-commit stop**
(markerless, sequencer-in-multi only) — *not* like cherry-pick's empty stop
(which writes `CHERRY_PICK_HEAD` because cherry-pick has `--allow-empty`). The
only extra is `continue` **dropping** the acknowledged leading empty rather than
re-stopping (§5).

### 2.5 Reflog (verified, git 2.54)

| Path | reflog message |
|---|---|
| clean auto-revert | `revert: Revert "<subject>"` (the **new** commit's subject) |
| `revert --continue` resolution | `commit: Revert "<subject>"` (plain `commit:`) |
| manual `git commit` resolution | `commit: Revert "<subject>"` (plain `commit:`) |
| `revert --abort` | `reset: moving to <full-oid>` |

Two consequences vs cherry-pick: (a) the resolved-revert reflog is **plain
`commit:`** (cherry-pick uses `commit (cherry-pick):`), so `commit.ts` needs **no
reflog change** for the revert path — the default `commit:` branch is already
correct; (b) `abort` writes git's `reset: moving to <oid>` (cherry-pick's tsgit
code emits a non-faithful `cherry-pick: aborted`; revert is faithful — see ADR-224).

## 3. API surface — nested namespace `repo.revert.*`

Frozen, non-callable nested namespace (ADR-193 / ADR-210 / ADR-217 lineage). Run
verb = `run`. Four verbs, mirroring `repo.cherryPick.*`:

```ts
repo.revert.run(input: RevertRunInput): Promise<RevertResult>
repo.revert.continue(): Promise<RevertResult>
repo.revert.skip(): Promise<RevertResult>
repo.revert.abort(): Promise<RevertAbortResult>
```

`continue` / `skip` take **no arguments** — revert has no resume-time options
(no `allowEmpty` / `recordOrigin`), so there is no `RevertContinueInput` (an
empty interface would also trip biome). Future flags would slot into `run` only.

### 3.1 Inputs / results

```ts
interface RevertRunInput {
  /** Revisions to revert, in argument order — exactly git's argv. A commit-ish
   *  ('abc123', 'HEAD~2', 'feature') reverts one commit; 'A..B' is a range
   *  expanded NEWEST-first. '...' / multi-'^' forms are rejected (§7). */
  readonly commits: ReadonlyArray<string>;
  /** -n / --no-commit: apply to index + working tree only; never commit, never
   *  persist REVERT_HEAD / sequencer state (§6). */
  readonly noCommit?: boolean;
}

interface RevertedCommit { readonly source: ObjectId; readonly created: ObjectId; }
interface RevertConflict { readonly path: FilePath; readonly type: ConflictType; }

type RevertResult =
  | { readonly kind: 'reverted'; readonly commits: ReadonlyArray<RevertedCommit> }
  | { readonly kind: 'no-commit'; readonly sources: ReadonlyArray<ObjectId> }      // -n
  | { readonly kind: 'conflict'; readonly commit: ObjectId;
      readonly conflicts: ReadonlyArray<RevertConflict>; readonly remaining: number }
  | { readonly kind: 'empty'; readonly commit: ObjectId; readonly remaining: number };

interface RevertAbortResult { readonly head: ObjectId; readonly branch: RefName; }
```

`kind:'reverted'` lists commits created in *this call* (a `continue` returns only
what it completed). `conflict` / `empty` / `no-commit` are returned, never thrown
(consistent with `cherryPick` / `merge` / `stash`).

### 3.2 Refusals (thrown `TsgitError`)

| Condition | Code | git parity |
|---|---|---|
| `run` while any pending-op marker exists | `OPERATION_IN_PROGRESS` | `assertNoPendingOperation` |
| `run` with a dirty index/work-tree | `WORKING_TREE_DIRTY` (paths) | `require_clean_work_tree` |
| a revert would overwrite a dirty path | `WORKING_TREE_DIRTY` (paths) | `applyMergeToWorktree` `would-overwrite` |
| reverting a merge commit (≥2 parents) | `REVERT_MERGE_NO_MAINLINE` (commit) | "is a merge but no -m option was given" |
| ambiguous abbreviated oid arg / todo line | `AMBIGUOUS_OID_PREFIX` (prefix, candidates) | "short SHA1 … is ambiguous" |
| `continue`/`skip` with nothing in progress | `NO_OPERATION_IN_PROGRESS` (`revert`) | "no revert in progress" |
| `continue` with unresolved index (stage>0) | `MERGE_HAS_CONFLICTS` | `rejectUnmergedIndex` |
| `abort` with nothing in progress | `NO_OPERATION_IN_PROGRESS` (`revert`) | |
| detached HEAD | `UNSUPPORTED_OPERATION` (`revert`) | mirrors `cherry-pick` |
| unborn branch | `NO_INITIAL_COMMIT` | nothing to revert onto |

### 3.3 Wiring

`bindRevertNamespace(ctx, guard)` (mirrors `bindCherryPickNamespace`);
`repo.revert` slot in `repository.ts` between `reset` and `rm` (alphabetical),
typed `commands.RevertNamespace`. Exported from `commands/index.ts`.

## 4. The revert message — `revertMessage(C)`

```
revertMessage(cData, C) =
  `Revert ${quoteSubject(subjectOf(cData.message))}\n\nThis reverts commit ${C}.\n`
```

- `subjectOf` = first line only (`message.split('\n')[0]`) — body lines are
  dropped (verified).
- `quoteSubject(s)` wraps `s` in **double quotes**, backslash-escaping only an
  embedded `"` and `\` (`s.replace(/([\\"])/g, '\\$1')` inside `"…"`) — exactly
  git's C-quoting for this slot, and **not** `JSON.stringify` (which would also
  escape non-ASCII / control bytes git leaves verbatim here). Reverting a revert
  then nests with no special-casing: `Revert "Revert \"x\""`. The pure
  `quoteSubject` atom lives in `internal/revert-state.ts`; pinned by interop (§10).
- The committed message is routed through the existing `sanitizeMessage`
  (`stripspace`, 21.2b) so the commit-object SHA matches git.

The new commit (`createRevertCommit`): `tree = mergedTree`, `parents = [ourId]`,
`author = committer = current identity` (`resolveRevertIdentity` — config
`user.*` + now, the same shape cherry-pick uses for its *committer*, reused for
**both** roles), `message = sanitizeMessage(revertMessage(C))`, `extraHeaders: []`,
reflog `revert: ${subjectOf(message)}` (the **new** commit's subject).

## 5. Algorithms (deltas from cherry-pick §4–§6)

The control flow is **structurally identical** to `cherry-pick.ts`
(`expandRevisions` → `runSequence` → `applyOne…`; `continue`/`skip`/`abort`).
The deltas:

- **`expandRange(from, to)`** — `walkCommits({ from:[to], until:[…from-ancestors] })`
  **without** the trailing `.reverse()` (newest-first). The from-ancestor
  exclusion set and `MAX_WALK_QUEUE_SIZE` cap are unchanged.
- **`applyOneRevert(C)`** — reverse merge: `baseTree = tree(C)`,
  `oursTree = tree(ourId)`, `theirsTree = parent(C) ? tree(parent(C)) : <empty>`.
  - `would-overwrite` → `throw workingTreeDirty`.
  - `conflict` → commit unmerged index; `{ kind:'conflict' }`.
  - clean & `mergedTree === oursTree` → `{ kind:'empty' }` (**always** — no
    `allowEmpty` escape).
  - clean & changed → commit via `createRevertCommit`; `updateRef(branch, id, {
    expected: ourId, reflogMessage: 'revert: ' + subject })`; `{ kind:'committed' }`.
  - **root commit (no parent)**: the reverse merge needs `theirs = <empty tree>`,
    deleting everything the root added (verified: `git revert <root>` removes the
    root's files). `applyMergeToWorktree` *reads* `theirsTree` (unlike `baseTree`
    it is non-optional), and git treats the empty tree as virtual, so tsgit
    materialises it via `writeTree(ctx, [])` (idempotent → `EMPTY_TREE_OID`)
    before passing it as `theirsTree`. No change to the shared primitive.
- **`runSequence`** gains an `onEmpty: 'stop' | 'drop'` parameter:
  - `conflict` → `persistStop` (writes `REVERT_HEAD` + `conflictMergeMsg`
    `MERGE_MSG`); multi → `writeSequencerStop(todo[0]=C)`; return `{ kind:'conflict' }`.
  - `empty` → **markerless** (no `REVERT_HEAD`, no `MERGE_MSG`):
    - `onEmpty==='drop'` at `i===0` → skip this commit, continue the loop
      (the acknowledged leading empty from a `continue`).
    - else → multi: `writeSequencerStop(todo[0]=C)`; return `{ kind:'empty' }`.
  - merge commit → multi: `writeSequencerStop(todo[0]=C)`; throw
    `revertMergeNoMainline(C)` (markerless, partial-apply — cherry-pick's
    pattern, §7.1).
- **`persistStop`** writes only `REVERT_HEAD` + `MERGE_MSG` (no `recordOrigin`
  variants); the draft is `revertMessage(C)`, conflict block appended via the
  shared `conflictMergeMsg`.
- **`run`** → `runSequence(todo, …, { onEmpty:'stop' })`; `noCommit` → `runNoCommit`.
- **`continue`** (two mutually-exclusive resume paths):
  - `source = readRevertHead`, `todo = readSequencerTodo`; both absent →
    `noOperationInProgress('revert')`.
  - **`source` set** (conflict path): `finaliseInProgressRevert` — read index,
    `rejectUnmergedIndex`, build tree-from-index. If `indexTree === tree(ourId)`
    → **re-stop** `{ kind:'empty', commit:source, remaining }` **keeping
    `REVERT_HEAD`** (git's conflict-resolved-to-empty). Else
    `commitResolvedRevert` (single parent, current identity, `MERGE_MSG`
    comments stripped, reflog **`commit: <subject>`**), clear `REVERT_HEAD` +
    `MERGE_MSG`, drop todo[0], then `runSequence(rest, onEmpty:'stop')`; prepend
    the finalised commit to its result list.
  - **`source` absent** (markerless empty / merge stop): `runSequence(fullTodo,
    onEmpty:'drop')` — one call; re-attempting todo[0] either drops the leading
    empty (`i===0`) and proceeds, or (merge) re-throws `REVERT_MERGE_NO_MAINLINE`.
- **`skip`** — identical to cherry-pick: hard-reset worktree to `HEAD`, clear
  `REVERT_HEAD` + `MERGE_MSG`, drop todo[0], `runSequence(rest, onEmpty:'stop')`.
- **`abort`** — identical reset to cherry-pick (`hardResetWorktreeToCommit` to
  the sequencer `head` / current HEAD), but the reflog is git-faithful
  **`reset: moving to <full-oid>`** (ADR-224), then clear all state.
- **`runNoCommit`** — `-n`: accumulate reverse merges into the index across the
  list, no commit, no state, even on conflict; merge / would-overwrite throw as
  in cherry-pick.

Revert threads **no opts object** through the sequence (no `recordOrigin` /
`allowEmpty`), only the `onEmpty` mode — so there is no `resolveResumeOpts`. A
`-n` run persists no sequencer, so the only flag the shared `writeSequencerOpts`
could record (`no-commit`) is never set during a resumable run; the revert
`opts` file is therefore always absent (matching git, verified §2.2).

## 6. New / changed modules

**New:**
- `src/application/commands/revert.ts` — `revertRun/Continue/Skip/Abort` + types
  + `revertMessage` / `createRevertCommit` / `applyOneRevert` / `runSequence` /
  `finaliseInProgressRevert` / `commitResolvedRevert` / `runNoCommit`. Helpers
  kept < 20 lines; mirrors `cherry-pick.ts` structure.
- `src/application/commands/internal/revert-state.ts` —
  `read/write/clearRevertHead` (`.git/REVERT_HEAD`, via the shared
  `readOptionalOidFile`) + the pure `quoteSubject` / `revertMessage` atoms.
  Reuses `conflictMergeMsg` from `cherry-pick-state.ts`.
- `src/application/commands/internal/revert-namespace.ts` —
  `bindRevertNamespace` + `RevertNamespace`.

**Changed:**
- `src/domain/sequencer/todo.ts` — generalise the grammar: `TodoEntry.command:
  'pick' | 'revert'`; `serializeTodo` emits the entry's command keyword;
  `parseTodo` accepts `^(pick|revert) (\S+) (.*)$` and preserves the keyword.
  `sequencer-state.ts` `ResolvedTodoEntry.command` widened the same way and
  threads the parsed command through (cherry-pick writes `'pick'`, revert
  `'revert'`). Round-trip property test extended to both keywords.
- `src/domain/commands/error.ts` — add `REVERT_MERGE_NO_MAINLINE { commit }`
  (parallel to `CHERRY_PICK_MERGE_NO_MAINLINE`) + `revertMergeNoMainline`
  factory.
- `src/application/commands/commit.ts` — recognise `REVERT_HEAD` alongside
  `CHERRY_PICK_HEAD`: `readPendingMarkers` reads `revertHead`; `pendingExceptOf`
  returns `'revert'`; `usePendingDraft` true when `revertHead` set (empty
  message → `MERGE_MSG`); `clearResolvedState` clears `REVERT_HEAD` + `MERGE_MSG`.
  **No** reflog change — a resolved revert is plain `commit:` (§2.5), the default
  branch. `REVERT_HEAD` is **not** a parent (only `mergeHead` is). The existing
  `nothingToCommit` guard faithfully refuses an empty manual revert commit unless
  `allowEmpty` (verified — git's "nothing to commit").
- `src/repository.ts`, `src/application/commands/index.ts` — export + bind the
  namespace.

`resolveOidPrefix`, `clean-work-tree`, `sequencer-state`, `commit-ish`,
`apply-merge-to-worktree`, `reset-worktree`, `index-update` are reused
**unchanged** (the cherry-pick investment pays off here).

## 7. Revision expansion — `expandRevisions`

Per `commits[]` arg, the cherry-pick ladder with one change (range order):
- **single commit-ish** → `resolveCommitIsh` (40-hex | abbrev via
  `resolveOidPrefix` | `refCandidates` DWIM | tag peel) — shared verbatim.
- **`A..B`** → reachable from `B` not `A`, **newest-first** (`expandRange`
  without the reverse). Capped by `MAX_WALK_QUEUE_SIZE`.
- **`A...B` / multi-`^`** → `INVALID_OPTION` (deferred), never mis-expanded.

### 7.1 Merge commits in a range — git-faithful partial-apply

Identical to cherry-pick (verified for revert): revert and **commit** every
non-merge commit *before* the merge, **stop at** the merge (sequencer todo[0]=
merge, no `REVERT_HEAD`), throw `REVERT_MERGE_NO_MAINLINE`. `skip` drops it,
`abort` resets, `continue` re-throws.

## 8. `commit.ts` — clearing `REVERT_HEAD` without a second parent

```
mergeHead   = readMergeHead()
cherryHead  = readCherryPickHead()
revertHead  = readRevertHead()
except = mergeHead ? 'merge' : cherryHead ? 'cherry-pick' : revertHead ? 'revert' : undefined
assertNoPendingOperation(ctx, except ? { except } : {})
...
parents = buildParents(parentId, mergeHead)        // revertHead is NOT a parent
reflog  = commitReflogMessage(...)                 // revert → default `commit:` (no special case)
...
if mergeHead  -> clearMergeState()
else if cherryHead -> { clearCherryPickHead(); clearMergeMsg() }
else if revertHead -> { clearRevertHead(); clearMergeMsg() }
```

At most one marker is ever set (`assertNoPendingOperation` blocks starting a
revert during a merge / cherry-pick). A user who resolves a mid-range revert
conflict with `repo.commit` then calls `revert.continue` resumes the remaining
commits (sequencer todo non-empty, `REVERT_HEAD` cleared) — git's
`git commit` → `git revert --continue` flow. The three-way `mergeHead /
cherryHead / revertHead` selection is extracted into a small
`pendingMarkerKind` helper to keep `commit` flat (early returns, no nested
ternary creep).

## 9. Testing strategy

- **Unit** (`revert.test.ts`): clean single revert (current-identity author+
  committer, single parent, branch advanced, `Revert "…"` message, `revert:`
  reflog); conflict stop (`REVERT_HEAD` + `MERGE_MSG` conflicts block +
  stage1/2/3 + markers + `remaining`); **start-empty single** (no state, tree
  clean, `kind:'empty'`); **start-empty multi** (sequencer stop, no
  `REVERT_HEAD`); root-commit revert (empty `theirs` → deletions); range clean
  (**newest-first** order + N commits); range conflict → continue (`commit:`
  reflog) → finish; empty-stop → continue **drops** → finish; conflict-resolved-
  to-empty → continue **re-stops keeping `REVERT_HEAD`**; skip (single + mid-
  range); abort (single + sequence, `reset: moving to` reflog); merge-commit
  partial-apply stop; `-n` (staged, HEAD unchanged, no state, even on conflict);
  reverting a revert (nested `Revert "Revert \"…\""`); every §3.2 refusal as an
  **isolated** guard test (each `||` guard triggered independently).
- **State unit** (`revert-state.test.ts`): `read/write/clearRevertHead` (absent →
  undefined; corrupt oid → `INVALID_OBJECT_ID`); `quoteSubject` (plain, embedded
  `"`, embedded `\`, both); `revertMessage` byte layout.
- **Sequencer** (`sequencer-state.test.ts` extension): `revert`-keyword todo
  round-trip + mixed `pick`/`revert` parse; the `command` field threads through.
- **Property** (`domain/sequencer/todo.properties.test.ts` extension):
  round-trip `parseTodo(serializeTodo(x)) ≡ x` over the **`pick | revert`**
  command arbitrary (round-trip-pair lens, 200 runs) — the grammar widened, so
  the property widens with it (per CLAUDE.md: a touched parser/serializer gets
  its property updated, not just examples).
- **`commit.ts` regression**: resolving a revert via `repo.commit` clears
  `REVERT_HEAD`, single parent, plain `commit:` reflog, no MERGE/cherry leakage;
  empty manual revert commit → `NOTHING_TO_COMMIT` (keeps `REVERT_HEAD`);
  `repo.commit({allowEmpty:true})` keeps the empty revert + clears the marker.
- **Interop** (`revert-interop.test.ts`, `@writes surface: revert`): tsgit `run`
  vs `git revert` — HEAD tree, commit author/committer/message (`Revert "…"`),
  parent count, index/worktree readback; range parity (newest-first);
  co-refusals (merge w/o -m, dirty tree); **cross-tool resume both ways** — a
  tsgit-started range conflict finished by `git revert --continue/--skip/--abort`
  and vice-versa (proves the `revert`-keyword sequencer is byte-faithful and
  `resolveOidPrefix`-resolvable). Goldens computed with signing **off**.
- **Parity** (`test/parity/scenarios/revert.scenario.ts`): a bundled
  cross-adapter scenario so the browser/memory surfaces exercise `repo.revert`
  (mirrors `cherry-pick.scenario.ts`; keeps the Playwright surface-coverage audit
  green for the new namespace).
- **Coverage** 100% line/branch/function/statement; **mutation** 0 killable.

## 10. Deferred (out of 22.2 scope)

- `-m` / mainline (reverting merge commits with a chosen parent); `--signoff`
  (`-s`); `--edit` / `--no-edit`; `--gpg-sign`; `--strategy` / `-X`.
- `A...B` symmetric-difference & multi-`^` range forms (rejected, not
  mis-expanded).
- `--quit` (leave changes, clear sequencer) — cherry-pick deferred it too.
- git's `core.abbrev` dynamic abbreviation in the todo (tsgit writes full oids;
  git re-resolves — ADR-218).

## 11. Key design decisions (→ ADRs)

1. **Namespace `repo.revert.{run,continue,skip,abort}`**, run verb `run`
   (ADR-193 / 210 / 217 lineage) — pre-decided, no new ADR.
2. **Empty-revert semantics** — git-faithful markerless stop + drop-on-continue,
   no `--allow-empty` flag (§2.4). *Load-bearing → ADR-223.*
3. **`abort` reflog** — git-faithful `reset: moving to <oid>` over tsgit-cherry-
   pick-consistent `revert: aborted` (§2.5). *→ ADR-224.*
4. **Sequencer todo grammar generalised** to `pick | revert` (§6) — the
   bidirectional cross-tool sequencer requires the real keyword; behaviour-
   preserving for cherry-pick. Mechanical, no user judgment.
5. **v1 flag set** = `noCommit` (-n) only; mainline / signoff / edit / quit
   deferred — follows the cherry-pick deferral precedent.
6. **Dedicated `REVERT_HEAD` state machine** (single-parent, current identity,
   plain `commit:` reflog) distinct from `CHERRY_PICK_HEAD` / `MERGE_HEAD`;
   `commit` clears it without adding a parent — follows ADR-220's pattern.
