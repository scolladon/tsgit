# Implementation plan — `rebase` (non-interactive)

TDD per slice (Red → Green → Refactor), `npm run validate` green before each
atomic commit. GWT describe/it split, AAA, `sut`, 100% coverage, 0 killable
mutants. Slices are ordered bottom-up (domain → primitive → state → command →
wiring → interop) so each compiles and tests in isolation.

## Verified reference (git 2.54, `GIT_*` scrubbed, signing off)

**Ref mechanics**
- Detach (symbolic→onto): `updateRef(HEAD,…)` reads `oldId = ZERO` for a symbolic
  HEAD, so detach explicitly: `old = resolveRef(HEAD)`;
  `refStore.writeLoose(HEAD, onto)`; `recordRefUpdate(HEAD, old, onto,
  'rebase (start): checkout <ontoName>')`.
- Pick (commit on detached HEAD): `createCommit({parents:[prev], author:C.author,
  committer:currentId, message:C.message})`; `updateRef(HEAD, id, {expected:prev,
  reflogMessage:'rebase (pick): <subject>'})` — HEAD already direct, so oldId is
  read correctly and `logCoupledHead` no-ops (HEAD not symbolic).
- Finish (reattach): `updateRef(branch, newTip, {expected:origTip,
  reflogMessage:'rebase (finish): refs/heads/<b> onto <ontoOid>'})` (HEAD still
  detached → no coupled-HEAD entry); then `writeSymbolicRef(HEAD, branch)` +
  `recordRefUpdate(HEAD, newTip, newTip, 'rebase (finish): returning to <name>')`.
  `writeOrigHead(origTip)`.
- Abort: `hardResetWorktreeToCommit(origTip)`;
  `updateRef(branch, origTip, {…})` only if branch moved (it never does → skip);
  `writeSymbolicRef(HEAD, branch)` (or writeLoose for detached) +
  `recordRefUpdate(HEAD, cur, origTip, 'rebase (abort): returning to <name>')`;
  `clearRebaseState`.

**HEAD reflog**: `rebase (start): checkout <ontoName>` · `rebase (pick):
<subject>` · `rebase (continue): <subject>` (first commit made by continue) ·
`rebase (finish): returning to <head-name>` · `rebase (abort): returning to
<head-name>`. **Branch reflog**: single `rebase (finish): refs/heads/<b> onto
<onto-full-oid>` on success; **none** on abort.

**Decision procedure**: `mb = mergeBase([upstream, head])`; `onto === mb` →
up-to-date no-op (no reflog); else `mb === head` → fast-forward (reflog dance, no
picks); else replay `(mb..head)` oldest-first minus cherry-equivalents of
`(mb..upstream)`.

**`.git/rebase-merge/` files (byte-exact, `od -c` verified)**: `head-name`
=`refs/heads/<b>\n`|`detached HEAD\n`; `onto`/`orig-head`=`<40hex>\n`;
`git-rebase-todo`+`done`=`pick <40hex> # <subject>\n`; `git-rebase-todo.backup`
=full todo + header + help block; `message`=`<subject>\n\n# Conflicts:\n#\t<p>\n`;
`author-script`=`GIT_AUTHOR_NAME='<n>'\nGIT_AUTHOR_EMAIL='<e>'\nGIT_AUTHOR_DATE='@<unix> <tz>'\n`;
`end`/`msgnum`=`<n>\n`; `interactive`=``; `rewritten-list`=`<old> <new>\n`;
`patch`=unified diff; `drop_redundant_commits`/`no-reschedule-failed-exec`=``;
`stopped-sha`=`<40hex>\n`. Plus `.git/REBASE_HEAD`=`<40hex>\n`.

## Slices

### 1 — `domain/rebase/todo.ts` (rebase todo grammar)
- **Red** `domain/rebase/todo.test.ts`: `serializeRebaseTodo([{oid,subject}])` →
  `pick <oid> # <subject>\n`; many entries; `parseRebaseTodo` round-trips; blank
  + `#`-comment lines ignored; a non-`pick` / malformed line → `invalidSequencerTodo`.
- **Green**: `RebaseTodoEntry = { oid: string; subject: string }`;
  `RE = /^pick (\S+) # (.*)$/`. (Distinct from `domain/sequencer/todo` — the `# `.)
- **Property** `todo.properties.test.ts`: `parse(serialize(x)) ≡ x` (numRuns 200).
- `feat(rebase): git-rebase-todo grammar`

### 2 — `domain/rebase/author-script.ts`
- **Red**: `serializeAuthorScript({name,email,date})` → the 3-line `GIT_AUTHOR_*`
  block with `@<unix> <tz>` date; `sqQuote` wraps in `'…'` and escapes embedded
  `'`→`'\''`; `parseAuthorScript` round-trips; a missing key → specific error.
- **Green**: `sqQuote` + serialize/parse over `GitIdentity` (name/email/`when`).
- **Property** `author-script.properties.test.ts`: round-trip (numRuns 200).
- `feat(rebase): author-script serialize/parse`

### 3 — `domain/rebase/todo-help.ts` (backup help block)
- **Red**: `rebaseTodoBackup(entries, { shortBase, shortTip, shortOnto, count })`
  equals the captured git byte-golden (todo lines + blank + `# Rebase
  <base>..<tip> onto <onto> (<n> commands)` + the `# Commands:` block).
- **Green**: the constant help block + header assembly.
- `feat(rebase): git-rebase-todo backup block`

### 4 — `primitives/patch-id.ts`
- **Red** `patch-id.test.ts`: `computePatchId(ctx, commit)` — equal for two
  commits whose diff content is identical at different line offsets; differs on
  different content; file-order independent; root commit (no parent → diff vs
  empty tree). Guard cases isolated.
- **Green**: diff `parent(C)..C` via `diffTrees`; per file (sorted by path)
  feed content lines (`+`/`-`/` ` kept, intra-line whitespace removed; `@@` /
  `diff`/`index`/`---`/`+++` excluded) into a SHA-1; return hex (internal key).
- **Property** `patch-id.properties.test.ts`: equal tree pair → equal id.
- `feat(rebase): patch-id equivalence key`

### 5 — `commands/internal/rebase-state.ts`
- **Red** `rebase-state.test.ts`: each writer emits byte-exact content (od
  goldens); readers round-trip; `readRebaseHead`/`writeRebaseHead`/`clearRebaseHead`
  on `.git/REBASE_HEAD`; `clearRebaseState` removes the whole dir (idempotent on
  absent); `readRebaseState` aggregates head-name/onto/orig-head/todo/done/author.
- **Green**: path helpers + per-file r/w + `writeRebaseStop(state)` composite +
  `clearRebaseState`. Reuse `domain/rebase/*` serializers + `oid-file` helpers.
- `feat(rebase): byte-faithful rebase-merge state`

### 6 — `commands/rebase.ts` — `rebaseRun` (up-to-date / FF / clean replay)
- **Red** `rebase.test.ts`: clean linear replay (2 commits) → `kind:'rebased'`,
  preserved author, current committer, single parent, branch tip + HEAD/branch
  reflog goldens; up-to-date → `kind:'up-to-date'`, no reflog change; FF →
  branch at onto, reflog dance, no picks; refusals (dirty/in-progress/unborn/bare)
  with specific `.data.code` (each guard isolated).
- **Green**: `rebaseRun(ctx, {upstream, onto?})`: assert repo/notBare/noPending;
  resolve head/upstream/onto/mergeBase; branch the decision; `detachHead` →
  `replayLoop` → `finishRebase`. Replay reuses `applyMergeToWorktree`
  (base=parent, ours=detached HEAD tree, theirs=C).
- `feat(rebase): run — replay, fast-forward, up-to-date`

### 7 — `rebaseRun` conflict stop
- **Red**: a conflicting commit → `kind:'conflict'` (commit, conflicts, remaining)
  + `.git/rebase-merge/` written byte-faithful + `.git/REBASE_HEAD` + `.git/HEAD`
  detached at the last good pick; multi-commit done/todo split + `rewritten-list`.
- **Green**: on `applyMergeToWorktree` conflict, persist `writeRebaseStop` and
  return; HEAD stays detached at the running parent.
- `feat(rebase): conflict stop persists rebase-merge state`

### 8 — cherry-equivalent pre-drop
- **Red**: a commit whose change is already upstream is absent from the result and
  not replayed (no reflog entry); an empty post-merge replay is also dropped.
- **Green**: build `patchIds(mb..upstream)`; filter `toReplay` by patch-id before
  the loop; in the loop drop a pick whose merged tree == parent tree.
- `feat(rebase): drop cherry-pick-equivalent commits`

### 9 — `--onto` + detached-HEAD rebase
- **Red**: `--onto newbase upstream` replays `mb(upstream,head)..head` onto
  newbase, branch reflog `… onto <newbaseOid>`; detached HEAD → `head-name`
  =`detached HEAD`, finish/abort target an oid.
- **Green**: `onto` defaulting + `head-name` from head kind.
- `feat(rebase): --onto and detached-HEAD support`

### 10 — `rebaseContinue`
- **Red**: resolve a conflict + `repo.add` → `continue` commits the stopped
  commit (author from author-script, current committer, `message` comments
  stripped), HEAD reflog `rebase (continue): <subject>`, advances todo, replays
  the rest (`rebase (pick)`), finishes; unmerged index → `mergeHasConflicts`; no
  state → `noOperationInProgress`; empty resolution drops the commit.
- **Green**: `rebaseContinue` reads state, commits, appends rewritten-list,
  resumes `replayLoop` from `done`/`todo`, finishes.
- `feat(rebase): continue`

### 11 — `rebaseSkip`
- **Red**: `skip` discards the conflicted commit (hard-reset to running HEAD), no
  commit/reflog for it, replays the rest, finishes; refusal when no state.
- **Green**: `rebaseSkip` drops `todo[0]`/the stopped commit, resumes.
- `feat(rebase): skip`

### 12 — `rebaseAbort`
- **Red**: `abort` reattaches `head-name`, hard-resets worktree+index to
  orig-head, HEAD reflog `rebase (abort): returning to <name>`, **branch reflog
  untouched**, `.git/rebase-merge/` + `REBASE_HEAD` cleared; detached variant
  targets the oid; refusal when no state.
- **Green**: `rebaseAbort` per the verified abort mechanics.
- `feat(rebase): abort`

### 13 — namespace + wiring + `add` except
- **Red** `rebase-namespace.test.ts` (guard-first, frozen);
  `repository.test.ts` exposes `repo.rebase`; `add.test.ts` allows staging while
  `.git/rebase-merge/` present.
- **Green**: `bindRebaseNamespace`; `commands/index.ts` re-exports; `repository.ts`
  binds `repo.rebase`; `add.ts` adds `'rebase'` to `assertNoPendingOperation`
  `except`. Regenerate `reports/api.json` (prepush gate).
- `feat(rebase): repo.rebase namespace + wiring`

### 14 — interop (`test/integration/rebase-interop.test.ts`, `@writes surface: rebase`)
- clean rebase tree/author/parent parity (`git write-tree` readback);
- bidirectional cross-tool resume (tsgit stop → `git rebase --continue`; git stop
  → `repo.rebase.continue`);
- abort reflog parity (HEAD `rebase (abort): returning to …`; branch untouched);
- drop-set parity (tsgit + git drop the identical cherry-equivalent commit).
- `test(rebase): cross-tool interop`

## Post-implementation (workflow Steps 6–9)
- Review ×3 (typescript / security / tests), fix-all-until-converged.
- **Architecture refactor** (ADR-232): extract `abortSequencerReset` for
  cherry-pick + revert; record rebase's faithful divergence. Re-review the
  refactor diff.
- Mutation: `stryker run --mutate` per touched file; 0 killable.
- Docs: README / RUNBOOK / CONTRIBUTING / `docs/use/*`; flip BACKLOG 22.3; PR.

## Module inventory (created / touched)
- New: `domain/rebase/{index,todo,author-script,todo-help}.ts`,
  `primitives/patch-id.ts`, `commands/internal/{rebase-state,rebase-namespace}.ts`,
  `commands/rebase.ts`, plus tests + property + interop siblings.
- Touched: `commands/index.ts`, `repository.ts`, `commands/add.ts`,
  `reports/api.json`, `docs/BACKLOG.md`, docs pages.
- Reused unchanged: `applyMergeToWorktree`, `mergeBase`, `walkCommits`,
  `createCommit`, `resolveCommitIsh`, `resolveCurrentIdentity`,
  `hardResetWorktreeToCommit`, `synthesizeTreeFromIndex`, `updateRef`,
  `writeSymbolicRef`, `recordRefUpdate`, `getRefStore`, `writeOrigHead`,
  `sanitizeMessage`/`stripComments`, `diffTrees`.
