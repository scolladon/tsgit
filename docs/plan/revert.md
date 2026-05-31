# Plan — `revert` (single + range)

TDD per slice (Red → Green → Refactor). `npm run validate` green before each
commit. One slice = one atomic conventional commit. Unit tests call command /
primitive functions directly with `ctx` (the established pattern), so the
namespace + facade wiring lands once (Slice 12) before interop/parity (13–14).

Design: `docs/design/revert.md`. Decisions: ADR-223 (empty semantics), ADR-224
(abort reflog); reuses ADR-215/217–222 machinery.

Revert is the inverse of cherry-pick (22.1) and **reuses unchanged**:
`resolveOidPrefix`, `clean-work-tree`, `resolveCommitIsh`, `sequencer-state`
(head/abort-safety/opts), `apply-merge-to-worktree`, `reset-worktree`,
`index-update`, `conflictMergeMsg`. New code is small; the bulk is faithful
wiring of the reverse merge + the revert message + the empty/abort deltas.

## Dependency graph

```
1 todo grammar (pick|revert) ─┐
2 error REVERT_MERGE_NO_MAINLINE ─┼─► 4 run:clean ─► 5 conflict ─► 6 empty+root ─► 7 range/seq ─► 8 continue ─► 9 skip/abort ─► 10 -n
3 revert-state ────────────────┘                                                     │
11 commit.ts recognises REVERT_HEAD                                                   │
12 namespace + facade wiring ◄────────────────────────────────────────────────────────┘
13 interop ◄─ 12      14 parity scenario ◄─ 12
```

Slices 1–3 are independent (parallel-safe). 4→10 sequentially extend
`revert.ts`. 11 (commit.ts) is independent of the namespace; 12 wires the public
surface; 13–14 (interop / parity) are last and need the public surface.

---

## Slice 1 — generalise sequencer `todo` grammar to `pick | revert`

**Files:** `src/domain/sequencer/todo.ts`;
`src/application/commands/internal/sequencer-state.ts` (`ResolvedTodoEntry`);
`test/unit/domain/sequencer/todo.test.ts` + `todo.properties.test.ts` +
`arbitraries.ts`; `test/unit/application/commands/internal/sequencer-state.test.ts`.

- **Red:** `todo.test.ts` — `serializeTodo([{command:'revert',…}])` → `revert <oid> <subj>\n`;
  `parseTodo('revert <oid> s')` → `command:'revert'`; mixed `pick`/`revert` lines
  round-trip; an unknown keyword line → `INVALID_SEQUENCER_TODO`. Extend
  `todo.properties.test.ts`: the arbitrary draws `command ∈ {pick, revert}`;
  `parseTodo(serializeTodo(x)) ≡ x` (200 runs). `sequencer-state.test.ts`: a
  `revert`-keyword todo resolves through `readSequencerTodo` preserving `command`.
- **Green:** `TodoEntry.command: 'pick' | 'revert'`; `serializeTodo` emits
  `${e.command} `; `PICK_LINE → /^(pick|revert) (\S+) (.*)$/` capturing the
  keyword; `ResolvedTodoEntry.command` widened and threaded.
- **Refactor:** none expected. **Verify + Commit:**
  `feat(domain): sequencer todo supports the revert command keyword`.

## Slice 2 — `REVERT_MERGE_NO_MAINLINE` error

**Files:** `src/domain/commands/error.ts` (union member + `revertMergeNoMainline`
factory); `test/unit/domain/commands/error.test.ts`.

- **Red:** `revertMergeNoMainline(oid).data` → `{ code:'REVERT_MERGE_NO_MAINLINE',
  commit: oid }` (assert `.code` **and** `.commit`, per mutation-resistant rule).
- **Green:** add the union member (mirror `CHERRY_PICK_MERGE_NO_MAINLINE`) +
  factory.
- **Verify + Commit:** `feat(error): REVERT_MERGE_NO_MAINLINE`.

## Slice 3 — `revert-state` (REVERT_HEAD + revert message)

**Files:** `src/application/commands/internal/revert-state.ts` (new);
`test/unit/application/commands/internal/revert-state.test.ts`.

- **Red:**
  - `quoteSubject('x')` → `"x"`; `quoteSubject('a"b')` → `"a\"b"`;
    `quoteSubject('a\\b')` → `"a\\b"`; both together (isolated tests per case).
  - `revertMessage(cData, oid)` → `Revert "<subject>"\n\nThis reverts commit <oid>.\n`;
    a multi-line source message uses only line 0; nested revert nests quotes.
  - `writeRevertHead`/`readRevertHead` round-trip; absent → `undefined`; corrupt
    (non-40-hex) → `INVALID_OBJECT_ID`; `clearRevertHead` idempotent.
- **Green:** `readOptionalOidFile`-backed REVERT_HEAD I/O (mirror
  `cherry-pick-state.ts`); pure `quoteSubject` (`s.replace(/([\\"])/g,'\\$1')`)
  + `revertMessage` (subject = `message.split('\n')[0]`). Import
  `conflictMergeMsg` from `cherry-pick-state.ts` (no duplication; Step 7 may
  relocate it to a neutral module if the cherry-pick↔revert coupling warrants).
- **Verify + Commit:** `feat(revert): REVERT_HEAD state + revert message`.

## Slice 4 — `revert.run` clean single revert

**Files:** `src/application/commands/revert.ts` (new: types, `expandRevisions`
single-arg path, `applyOneRevert`, `createRevertCommit`,
`resolveCurrentIdentity`, `runSequence` skeleton with `onEmpty`, `revertRun`);
`test/unit/application/commands/revert.test.ts`.

- **Red:** clean single revert of a non-root commit:
  - result `{ kind:'reverted', commits:[{source, created}] }`;
  - new commit: **author === committer === current identity** (config user, now),
    single parent === prior HEAD, tree === reverse-merge tree, message
    `Revert "<subj>"\n\nThis reverts commit <oid>.\n`;
  - branch advanced; reflog `revert: Revert "<subj>"`;
  - refusals (isolated): `run` on detached HEAD → `UNSUPPORTED_OPERATION`;
    unborn branch → `NO_INITIAL_COMMIT`; pending marker → `OPERATION_IN_PROGRESS`;
    dirty tree → `WORKING_TREE_DIRTY`.
- **Green:** reverse merge `base=tree(C)`, `ours=tree(HEAD)`,
  `theirs=tree(parent(C))`; `createRevertCommit` (current identity both roles via
  a **locally-defined** `resolveCurrentIdentity` — Step 7 will centralise the
  cherry-pick/revert duplication); `runSequence` with `onEmpty:'stop'`,
  single-arg `expandRevisions`. `assertCleanWorkTree` + detached/unborn guards
  reused from the cherry-pick helpers.
- **Verify + Commit:** `feat(revert): clean single revert`.

## Slice 5 — conflict stop (single)

- **Red:** revert a commit that conflicts vs HEAD:
  - result `{ kind:'conflict', commit, conflicts:[{path,type}], remaining:0 }`;
  - `REVERT_HEAD` === source oid; `MERGE_MSG` === `revertMessage` + `# Conflicts:`
    block (assert the literal bytes); index has stage 1/2/3 for the path; working
    file has `<<<<<<<` markers; branch unmoved.
- **Green:** `applyOneRevert` conflict branch commits the unmerged index, returns
  `{kind:'conflict'}`; `persistStop` writes `REVERT_HEAD` + `conflictMergeMsg`
  draft.
- **Verify + Commit:** `feat(revert): conflict stop with REVERT_HEAD + MERGE_MSG`.

## Slice 6 — empty stop (single) + root-commit revert

- **Red:**
  - start-empty single (revert an already-reverted change): `{ kind:'empty',
    commit, remaining:0 }`; **no** `REVERT_HEAD`, **no** `MERGE_MSG`, **no**
    sequencer; working tree clean (=== HEAD); branch unmoved.
  - root-commit revert: deletes every path the root added; result `reverted`;
    tree === empty of the root's files.
- **Green:** `applyOneRevert` clean-&-`mergedTree===oursTree` → `{kind:'empty'}`
  (no state); `runSequence` `onEmpty:'stop'` empty branch → markerless return.
  Root path: `theirsTree = parent ? tree(parent) : await writeTree(ctx, [])`
  (idempotent `EMPTY_TREE_OID`).
- **Verify + Commit:** `feat(revert): empty stop + root-commit revert`.

## Slice 7 — range / multi-arg sequence

- **Red:**
  - `expandRevisions(['A..B'])` newest-first (assert oid order);
    `A...B` / `^` → `INVALID_OPTION`.
  - clean range: N revert commits, newest-first, all single-parent.
  - range conflict on the first commit: `{kind:'conflict', remaining:N-1}`;
    sequencer persisted — `todo` lines start `revert `, line 0 = current,
    `head`/`abort-safety` set, **no** `opts` file; `REVERT_HEAD` set.
  - merge commit in a range: earlier picks commit, stop **at** the merge
    (sequencer `todo[0]`=merge, **no** `REVERT_HEAD`), throw
    `REVERT_MERGE_NO_MAINLINE` (assert `.commit`).
- **Green:** `expandRange` = walk `to` minus `from`-ancestors, **no reverse**;
  `runSequence` multi branch: `writeSequencerStop(todo.slice(i))` on conflict
  (with `REVERT_HEAD`) / empty / merge (markerless); `buildTodoEntries` emits
  `command:'revert'`.
- **Verify + Commit:** `feat(revert): range + sequencer persistence`.

## Slice 8 — `revert.continue`

- **Red:**
  - conflict → resolve index → `continue` → `{kind:'reverted'}`, `commit:`
    reflog (plain), `REVERT_HEAD`/`MERGE_MSG` cleared, remaining picks finished.
  - conflict resolved **to** empty → `continue` → `{kind:'empty'}`, `REVERT_HEAD`
    **kept** (assert still present).
  - start-empty multi stop → `continue` → **drops** the empty, finishes,
    sequencer cleared.
  - `continue` with nothing in progress → `NO_OPERATION_IN_PROGRESS('revert')`;
    unresolved index (stage>0) → `MERGE_HAS_CONFLICTS`.
- **Green:** `finaliseInProgressRevert` (index tree; empty re-stop keeping
  `REVERT_HEAD`; else `commitResolvedRevert` plain `commit:` reflog + clear);
  source-absent path → `runSequence(fullTodo, onEmpty:'drop')`; source-set path →
  finalise + `runSequence(rest, onEmpty:'stop')`, prepend finalised.
- **Verify + Commit:** `feat(revert): continue (resume, drop-empty, keep-on-empty-resolve)`.

## Slice 9 — `revert.skip` + `revert.abort`

- **Red:**
  - `skip` (mid-range conflict): drops `todo[0]`, hard-resets worktree to HEAD,
    clears `REVERT_HEAD`/`MERGE_MSG`, resumes rest; lone stop → `{kind:'reverted',
    commits:[]}`, all state cleared.
  - `abort` (single + sequence): worktree/index/branch reset to sequencer `head`
    / current HEAD; reflog **`reset: moving to <full-oid>`** (ADR-224); all state
    cleared; returns `{head, branch}`.
  - `skip`/`abort` with nothing in progress → `NO_OPERATION_IN_PROGRESS('revert')`.
- **Green:** mirror `cherryPickSkip`/`cherryPickAbort`; the **only** delta is the
  abort `reflogMessage: 'reset: moving to ' + target`.
- **Verify + Commit:** `feat(revert): skip + abort`.

## Slice 10 — `-n` / `--no-commit`

- **Red:** `run({commits:[…], noCommit:true})` accumulates reverse merges into the
  index + working tree, **no** commit, HEAD unmoved, **no** `REVERT_HEAD`/
  sequencer; `{kind:'no-commit', sources}`. Conflict under `-n`: `{kind:'conflict'}`
  with **no** state. Merge commit under `-n` → `REVERT_MERGE_NO_MAINLINE`.
- **Green:** `runNoCommit` (mirror cherry-pick's; reverse merge with accumulating
  `oursTree = synth(currentIndex)`).
- **Verify + Commit:** `feat(revert): -n no-commit`.

## Slice 11 — `commit.ts` recognises `REVERT_HEAD`

**Files:** `src/application/commands/commit.ts`;
`test/unit/application/commands/commit.test.ts` (regression).

- **Red:** with `REVERT_HEAD` set + a resolved (stage-0) index:
  - `commit({message:''})` → single parent, `MERGE_MSG` fallback message, plain
    `commit:` reflog, `REVERT_HEAD`+`MERGE_MSG` cleared, **no** second parent;
  - empty manual revert commit → `NOTHING_TO_COMMIT` (`REVERT_HEAD` kept);
  - `commit({allowEmpty:true})` on an empty revert → commits + clears the marker;
  - starting any other op during a revert → `OPERATION_IN_PROGRESS`;
  - no MERGE / cherry-pick leakage.
- **Green:** `readPendingMarkers` reads `revertHead`; a `pendingMarkerKind` helper
  selects `merge` / `cherry-pick` / `revert` (flat, early-return);
  `pendingExceptOf` returns `'revert'`; `usePendingDraft` true when `revertHead`
  set; `clearResolvedState` clears `REVERT_HEAD`+`MERGE_MSG`; `buildParents`
  unchanged (revertHead is **not** a parent); **no** reflog change (default
  `commit:`).
- **Verify + Commit:** `feat(revert): commit recognises REVERT_HEAD`.

## Slice 12 — wiring: namespace + facade

**Files:** `src/application/commands/internal/revert-namespace.ts` (new);
`src/application/commands/index.ts`; `src/repository.ts`; surface test.

- **Red:** `repo.revert.{run,continue,skip,abort}` exist, frozen, guarded
  (disposed repo throws); `run` reverts through the public surface.
- **Green:** `bindRevertNamespace` + `RevertNamespace` (mirror cherry-pick); slot
  `repo.revert` between `reset` and `rm` (alphabetical); export from
  `commands/index.ts`.
- **Verify + Commit:** `feat(revert): bind repo.revert namespace`.

## Slice 13 — cross-tool interop

**Files:** `test/integration/revert-interop.test.ts` (new, `@writes surface: revert`).

- tsgit `run` vs `git revert`: HEAD tree (`git write-tree` readback),
  author/committer/message (`Revert "…"`), parent count, index/worktree;
  range parity (newest-first); co-refusals (merge w/o -m, dirty tree);
  **bidirectional resume** — tsgit-started range conflict finished by
  `git revert --continue/--skip/--abort`, and vice-versa. Goldens with signing
  **off** (`-c commit.gpgsign=false`), `GIT_*` scrubbed.
- **Verify + Commit:** `test(revert): cross-tool interop`.

## Slice 14 — parity scenario (browser/memory surface)

**Files:** `test/parity/scenarios/revert.scenario.ts` (new) + registration.

- A bundled scenario exercising `repo.revert.run` (clean + conflict) so the
  Playwright surface-coverage audit (19.5a) covers the new namespace.
- **Verify** (incl. `npm run validate` running the surface audit) **+ Commit:**
  `test(revert): cross-adapter parity scenario`.

---

## Post-implementation (workflow Steps 6–10)

- **Step 6** — review ×3 (ts / security / tests), fix-all-until-converged.
- **Step 7** — architecture refactor: **centralise `resolveCurrentIdentity`**
  (cherry-pick's `resolvePickCommitter` + revert's identity → one shared
  `internal/commit-message.ts` helper), behaviour-preserving; re-review scoped to
  the refactor. Also: log a `docs/BACKLOG.md` follow-up to align
  `cherry-pick --abort`'s non-faithful reflog (ADR-224).
- **Step 8** — mutation on `revert.ts` / `revert-state.ts` / `todo.ts` /
  `error.ts` revert paths; 0 killable.
- **Step 9–10** — docs (README command list, any use/understand pages), flip
  BACKLOG `22.2` → `[x]`, PR, CI, admin squash-merge `--delete-branch`, `git sync`.

## Test-convention reminders (CLAUDE.md)

- GWT describe/it split, AAA body, `sut` variable.
- Error assertions assert `.data` fields (code **and** payload), not bare type.
- Each `||` guard (e.g. `source===undefined && (todo===undefined||empty)`) gets
  an **isolated** test per condition.
- The widened todo grammar gets its **property** updated (Slice 1), not just
  examples — a touched parser/serializer in a round-trip pair.
- No phase/ADR refs inside source or test code.
