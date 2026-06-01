# Design — `rebase` (non-interactive)

## Goal

`repo.rebase.{run,continue,skip,abort}` — replay the commits unique to the
current branch on top of another base, faithfully to canonical `git rebase`
(the **merge backend**, default since git 2.26). This is the third command in
the Phase 22 history-rewrite chain (after `cherry-pick` 22.1 and `revert` 22.2)
and the third `*-abort` consumer, which triggers extraction of the shared
abort-reset helper deferred by 22.2b.

Non-interactive only — `pick`/`reword`/`edit`/`squash`/`fixup`/`drop` editing
(`rebase -i`) is 22.4.

## Faithfulness is the prime directive (ADR-226)

Every observable byte must match real `git`: replayed commit SHAs (preserved
author + new committer, single parent), the `refs/heads/<branch>` and `HEAD`
reflog lines, the on-disk `.git/rebase-merge/` state files, `.git/REBASE_HEAD`,
`.git/ORIG_HEAD`, refusal conditions, and the set of commits dropped as
already-upstream. Verified against git 2.54 with `GIT_*` scrubbed and signing
off; pinned by cross-tool interop (a tsgit-started rebase finished under
`git rebase --continue`, and vice-versa) and unit goldens.

## Scope (v1)

Confirmed by the ADR conversation (max-faithfulness across all three axes):

**In**
- `repo.rebase.run({ upstream, onto? })` — plain `git rebase <upstream>` and
  `git rebase --onto <newbase> <upstream>`.
- `.continue()` / `.skip()` / `.abort()` resolution verbs.
- Fast-forward (HEAD is an ancestor of `onto`) and the up-to-date no-op.
- Cherry-pick-equivalent **pre-drop** via patch-id (git's default).
- Detached-HEAD rebase (`head-name` = `detached HEAD`).
- Full byte-faithful `.git/rebase-merge/` state dir → bidirectional cross-tool
  resume parity with the merge backend.

**Out (deferred, logged in BACKLOG)**
- `rebase -i` and its instruction grammar (22.4).
- `--autosquash`, `--exec`, `--keep-empty`/`--empty=`, `--root`, `--merge`
  strategy/option flags, `--rebase-merges`.
- `pull --rebase` wiring (a thin composition over this command — separate
  follow-up; ADR-198 reserved the hook).

## Background — how the merge backend works (verified)

A clean `git rebase main` from `topic`:

```
HEAD reflog                         branch (refs/heads/topic) reflog
  rebase (start): checkout main       (unchanged during replay — HEAD is detached)
  rebase (pick): t1                   …
  rebase (pick): t2
  rebase (finish): returning to       rebase (finish): refs/heads/topic onto <onto-full-oid>
                   refs/heads/topic
```

The backend **detaches HEAD at `onto`**, replays each commit as a cherry-pick on
the detached HEAD (`rebase (pick): <subject>`), then on success **updates the
branch ref** to the new tip (single branch reflog entry
`rebase (finish): refs/heads/<b> onto <onto-oid>`) and **reattaches HEAD**
(`rebase (finish): returning to <head-name>`). `.git/ORIG_HEAD` is set to the
original branch tip. Because the replay runs on a detached HEAD, the branch ref
never moves until `finish` — this is observable: mid-rebase `.git/HEAD` holds a
raw oid, and an abort touches `HEAD`, not the branch.

This detached-HEAD model is the key structural difference from `cherry-pick` /
`revert` (which commit directly on the branch). tsgit must replicate it to be
faithful.

### Decision procedure (what `run` computes)

```
upstream  = resolveCommitIsh(input.upstream)
onto      = input.onto !== undefined ? resolveCommitIsh(input.onto) : upstream
head      = resolveHead()                       // symbolic branch or detached oid
mergeBase = mergeBase([upstream, head])          // the fork point (single base)

if onto === mergeBase:                          // head already sits on onto
    → "up to date" no-op: NO reflog, NO state change, exit clean
else if mergeBase === head:                      // head is fully contained in upstream
    → fast-forward: move branch/HEAD to onto via the rebase reflog dance, no picks
else:
    toReplay = (mergeBase..head) oldest-first, minus cherry-equivalents of
               (mergeBase..upstream) by patch-id
    detach HEAD at onto; replay each commit; finish or stop
```

The predicate ordering is load-bearing and verified against git 2.54:
`onto === mergeBase` catches *up to date* first (incl. `head === onto` and an
upstream that is an ancestor of head with no `--onto` redirect); `mergeBase ===
head` then catches *fast-forward*; everything else replays. `--onto <newbase>`
where `newbase !== mergeBase` always replays (the base genuinely moves).

The replay of one commit `C` onto the running detached HEAD `P` is exactly
cherry-pick semantics through the shared `applyMergeToWorktree` primitive
(ADR-215): `base = tree(parent(C))`, `ours = tree(P)`, `theirs = tree(C)`. A
clean merge commits `{ tree: merged, parents: [P], author: C.author,
committer: currentIdentity, message: C.message }`; the result advances `P`.

### Cherry-pick-equivalent dropping (patch-id)

git drops commits whose change is already present upstream (the default;
`--no-reapply-cherry-picks` is **not** set). The dropped commit appears in
**neither** the todo nor `done` nor the reflog — it is removed from `toReplay`
*before* the replay loop. Verified: a `dup` commit cherry-picked onto `main`
beforehand is silently absent from the rebased history.

tsgit computes a **patch-id** for each candidate (`mergeBase..head`) and for each
commit the upstream introduced since the fork (`mergeBase..upstream`) and drops a
candidate whose patch-id collides. The patch-id replicates git's *equivalence
semantics* — per
file (sorted by path), the diff content with hunk `@@` headers and the
`diff`/`index`/`---`/`+++` marker lines excluded, line numbers ignored,
intra-line whitespace removed — so tsgit's equivalence **classes** match git's.

The patch-id is an **internal equivalence key**: it is never persisted to a
state file and never surfaced in the API, so byte-identity with `git patch-id`'s
hex output is *not* a faithfulness requirement (and is brittle to reproduce
across git versions). What is observable — *which commits get dropped* — is
pinned by a **drop-set parity** interop test: a tsgit rebase and a git rebase
over the same fixture drop the identical commits. See ADR-231.

## On-disk state — `.git/rebase-merge/` (full byte-faithful)

Written atomically on a conflict stop, consumed by `--continue` / `--skip`,
removed on finish/abort. Byte-faithful to the merge backend (verified `od -c`):

| file | bytes | role |
|---|---|---|
| `head-name` | `refs/heads/<b>\n` or `detached HEAD\n` | what `finish`/`abort` reattaches |
| `onto` | `<onto-full-oid>\n` | the new base |
| `orig-head` | `<orig-tip-oid>\n` | abort target + `ORIG_HEAD` + finish reflog |
| `git-rebase-todo` | `pick <full-oid> # <subject>\n`… | remaining instructions (line 0 = next) |
| `git-rebase-todo.backup` | full todo + the `# Commands:` help block | recovery copy (not consumed by resume) |
| `done` | `pick <full-oid> # <subject>\n`… | completed instructions incl. the stopped one |
| `message` | `<subject>\n\n# Conflicts:\n#\t<path>\n` | the stopped commit's draft message |
| `author-script` | `GIT_AUTHOR_NAME='…'\nGIT_AUTHOR_EMAIL='…'\nGIT_AUTHOR_DATE='@<unix> <tz>'\n` | the stopped commit's author (preserved by `continue`) |
| `end` | `<N>\n` | total instruction count |
| `msgnum` | `<i>\n` | current (stopped) instruction number |
| `interactive` | `` (empty) | the merge backend always writes this |
| `rewritten-list` | `<old-oid> <new-oid>\n`… | per completed pick (old→replayed) |
| `patch` | unified diff of the failed pick | cosmetic (`git status`); not consumed |
| `drop_redundant_commits` | `` (empty) | flag marker |
| `no-reschedule-failed-exec` | `` (empty) | flag marker |
| `stopped-sha` | `<stopped-oid>\n` | mirrors `REBASE_HEAD` |

`.git/REBASE_HEAD` (`<stopped-oid>\n`) is written alongside — it is the marker
`assertNoPendingOperation` already recognises (`repo-state.ts`). `author-script`
uses git's shell single-quoting (`sq_quote`: wrap in `'…'`, escape embedded `'`
as `'\''`) and the `@<unix> <tz>` internal date format.

`author-script` and the `# Commands:` help block in `git-rebase-todo.backup` are
git-version-sensitive cosmetic text; the resume-critical files (`head-name`,
`onto`, `orig-head`, `git-rebase-todo`, `done`, `message`, `author-script`) are
the ones `git rebase --continue` actually reads, and those are pinned by the
bidirectional cross-tool interop.

## Reflog catalogue (HEAD, verified)

| step | `HEAD` reflog subject |
|---|---|
| start | `rebase (start): checkout <onto-name>` |
| each clean pick | `rebase (pick): <subject>` |
| first commit made by `--continue` | `rebase (continue): <subject>` |
| picks after a continue | `rebase (pick): <subject>` |
| finish | `rebase (finish): returning to <head-name>` |
| abort | `rebase (abort): returning to <head-name>` |

Branch (`refs/heads/<b>`) reflog: a **single** `rebase (finish): refs/heads/<b>
onto <onto-full-oid>` on success; **no** entry on abort (the branch never moved
— the replay was on a detached HEAD). `<onto-name>` is the argument as given
(`main`, `newbase`); `<head-name>` is `refs/heads/<b>` or, for a detached
rebase, the original detached oid.

## Resolution verbs

- **`continue`** — reject an unmerged index (`mergeHasConflicts`); commit the
  resolved tree as the stopped commit (`author-script` author, current
  committer, `message` with comments stripped), reflog `rebase (continue):
  <subject>` on HEAD, append `rewritten-list`, drop the stopped instruction from
  the todo, then replay the remaining todo (`rebase (pick)` each) and finish. A
  resolution that yields no net change drops the commit (git's empty handling).
- **`skip`** — discard the conflicted commit: hard-reset the working tree+index
  to the current detached HEAD (the last good pick), drop the stopped
  instruction, replay the rest, finish. No commit, no reflog for the skipped one.
- **`abort`** — reattach `head-name`, hard-reset working tree+index+branch to
  `orig-head`, reflog `rebase (abort): returning to <head-name>` on HEAD, remove
  `.git/rebase-merge/` + `REBASE_HEAD`. Refuses when no rebase is in progress.

All three refuse with `NO_OPERATION_IN_PROGRESS` when `.git/rebase-merge/` is
absent (mirrors cherry-pick/revert).

## API surface

Nested namespace `repo.rebase.*` (ADR-181/192/210 precedent), bound through
`bindRebaseNamespace(ctx, guard)`, frozen, guard-first — identical shape to
`repo.cherryPick.*` / `repo.revert.*`.

```ts
interface RebaseRunInput {
  readonly upstream: string;        // commit-ish; the fork point side
  readonly onto?: string;           // --onto <newbase>; defaults to upstream
}
type RebaseResult =
  | { kind: 'rebased';   commits: ReadonlyArray<RebasedCommit> }   // incl. fast-forward
  | { kind: 'up-to-date' }
  | { kind: 'conflict';  commit: ObjectId; conflicts: ReadonlyArray<RebaseConflict>; remaining: number };
interface RebaseAbortResult { readonly head: ObjectId; readonly headName: string; }
```

`run`/`continue`/`skip` return `RebaseResult`; `abort` returns
`RebaseAbortResult`. `RebasedCommit = { source, created }`; a dropped
cherry-equivalent contributes no entry.

## Module layout (hexagonal)

- `domain/rebase/` — pure git formats with zero platform deps:
  - `todo.ts` — `pick <oid> # <subject>` grammar (serialize/parse); distinct
    from the `domain/sequencer` grammar (`pick <oid> <subject>`, no `#`).
  - `author-script.ts` — `sq_quote` + the `GIT_AUTHOR_*` author-script
    serialize/parse and the `@<unix> <tz>` date format.
  - `todo-help.ts` — the `# Commands:` help-block constant for the `.backup`.
- `application/primitives/patch-id.ts` — `computePatchId(ctx, commit)`: the
  internal equivalence key over the commit's diff (reuses `diffTrees` + the
  unified-diff atoms from 20.3).
- `application/commands/internal/rebase-state.ts` — byte-faithful
  `.git/rebase-merge/` + `REBASE_HEAD` reader/writers, `clearRebaseState`.
- `application/commands/rebase.ts` — `rebaseRun` / `rebaseContinue` /
  `rebaseSkip` / `rebaseAbort` (Context-aware).
- `application/commands/internal/rebase-namespace.ts` — `bindRebaseNamespace`.
- Wiring: `commands/index.ts` re-exports; `repository.ts` binds
  `repo.rebase`; `add.ts` adds `'rebase'` to its `assertNoPendingOperation`
  `except` list (staging a rebase conflict resolution is the path forward — the
  current comment already calls this out as the missing case).

Reuses without change: `applyMergeToWorktree`, `mergeBase`, `walkCommits`,
`createCommit`, `resolveCommitIsh`, `resolveCurrentIdentity`,
`hardResetWorktreeToCommit`, `synthesizeTreeFromIndex`, `updateRef`,
`writeSymbolicRef`, `sanitizeMessage`/`stripComments`, `writeOrigHead`.

## The `abortSequencerReset` extraction (22.2b item 2, the rule-of-three)

`cherryPickAbort` and `revertAbort` share a byte-identical body modulo the
`clear<Op>Head` call:

```
target = seqHead ?? resolveRef(branch)
hardResetWorktreeToCommit(target)
updateRef(branch, target, { reflogMessage: `reset: moving to ${target}` })
clear<Op>Head(); clearMergeMsg(); clearSequencer()
return { head: target, branch }
```

Landing `rebase` completes the `*-abort` family (three abort commands now
exist), which is the rule-of-three trigger 22.2b waited for. In the
**architecture-refactor pass** (workflow Step 7) the cherry-pick/revert body is
extracted into a shared `abortSequencerReset(ctx, { branch, target, clearHead })`
helper (behaviour-preserving).

**rebase's abort is faithfully different** and does *not* route through that
helper: git's merge backend reattaches `HEAD` (a symbolic-ref write, since HEAD
was detached) with a `rebase (abort): returning to <name>` reflog and clears
`.git/rebase-merge/` — it does **not** move the branch ref (no
`reset: moving to`) nor touch `.git/sequencer/`. The shared atom rebase *does*
reuse is the already-shared `hardResetWorktreeToCommit`. The refactor note will
record this divergence explicitly so the asymmetry is intentional, not an
oversight.

## Refusal conditions (verified, faithful)

- Dirty working tree / unstaged or uncommitted changes → refuse before any
  state change (`assertCleanWorkTree` against HEAD's tree, as cherry-pick does;
  git: "cannot rebase: You have unstaged changes").
- A rebase / merge / cherry-pick / revert already in progress →
  `OPERATION_IN_PROGRESS` (`assertNoPendingOperation`).
- Unborn branch (no commits) → `noInitialCommit`.
- Bare repository → `bareRepository`.
- `upstream`/`onto` that resolve to non-commits → the commit-ish resolver's
  existing errors.

## Test strategy

GWT describe/it split, AAA body, `sut`, 100% line/branch/function/statement,
0 killable mutants — per `CLAUDE.md`.

**Unit** (`test/unit/.../rebase.test.ts` + state/primitive siblings)
- clean replay (linear + multi-commit), preserved author / new committer /
  single parent, branch + HEAD reflog goldens;
- fast-forward and up-to-date no-op (reflog presence/absence);
- conflict stop → full state-dir byte goldens + `REBASE_HEAD`;
- continue (with `rebase (continue)` reflog), skip, abort (HEAD reattach,
  branch-untouched, state cleared) — each guard isolated for mutation;
- `--onto`, detached-HEAD rebase, cherry-equivalent drop;
- refusals (dirty tree, in-progress, unborn, bare) with specific `.data.code`.

**Property** (`domain/rebase/todo.properties.test.ts`,
`author-script.properties.test.ts`) — the todo grammar and author-script are a
parse/serialize pair: `parse(serialize(x)) ≡ x` (round-trip lens, ADR-134/136),
`numRuns: 200`. patch-id gets a composition property (equal trees → equal id;
file-order-independent).

**Interop** (`test/integration/rebase-interop.test.ts`, `@writes surface:
rebase`)
- clean rebase: resulting tree + author + parent-count parity (oids embed the
  committer timestamp, so compare via `git write-tree` readback + author line);
- bidirectional cross-tool resume — tsgit stop finished by `git rebase
  --continue`, and a git stop finished by `repo.rebase.continue` (the proof the
  `.git/rebase-merge/` state is byte-faithful and git-readable);
- abort reflog parity (`rebase (abort): returning to …` on HEAD; branch
  untouched);
- **drop-set parity** — a fixture with a cherry-equivalent commit: tsgit and git
  rebase drop the identical commit (proves the patch-id equivalence relation).

## ADRs (this design raises)

- **ADR-228** — rebase replays on a detached HEAD (merge-backend model), not on
  the branch like cherry-pick/revert.
- **ADR-229** — full byte-faithful `.git/rebase-merge/` state dir + cross-tool
  resume (vs a tsgit-private subset).
- **ADR-230** — `repo.rebase.*` nested-namespace surface + `run` input shape.
- **ADR-231** — patch-id is an internal equivalence key; cherry-equivalent
  drop-faithfulness is pinned by observable drop-set parity, not by hex-identity
  with `git patch-id`.
- **ADR-232** — `abortSequencerReset` extracted for cherry-pick + revert; rebase
  abort faithfully diverges (HEAD reattach) and does not route through it.
