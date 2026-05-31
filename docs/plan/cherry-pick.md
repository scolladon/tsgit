# Plan — `cherry-pick` (single + range)

TDD per slice (Red → Green → Refactor). `npm run validate` green before each
commit. One slice = one atomic conventional commit. Slices are ordered by
dependency; unit tests call command/primitive functions directly with `ctx`
(the established pattern), so the namespace + facade wiring lands once near the
end (Slice 14) before interop (Slice 15).

Design: `docs/design/cherry-pick.md`. Decisions: ADR-217…222.

## Dependency graph

```
1 resolveOidPrefix ──┐
2 todo grammar ──────┼─► 4 sequencer-state ─► 13 range/sequence ─► 14 wiring ─► 15 interop
3 cherry-pick-state ─┘                          ▲
5 clean-work-tree ──────────► 8 run:clean ──────┤
6 resolveCommitIsh (uses 1) ─► 8 run:clean      │
7 (error code, in 8) ───────► 8 ─► 9 -x ─► 10 conflict+continue ─► 11 commit.ts
                                              └─► 12 empty ─► 13
                                  16 (in 8..13) -n no-commit
```

Slices 1–6 are mutually independent (parallel-safe). 8→9→10→11→12→13 are
sequential (each extends `cherry-pick.ts`). 14→15 are last.

---

## Slice 1 — `resolveOidPrefix` primitive (ADR-222)

**Files:** `src/application/primitives/resolve-oid-prefix.ts` (new);
`src/domain/commands/error.ts` (+`AMBIGUOUS_OID_PREFIX`);
`src/application/commands/rev-parse.ts` (wire `resolveBase`);
`src/application/primitives/index.ts` (export).

- **Red:** `resolve-oid-prefix.test.ts` — unique loose; unique pack; spanning
  loose+pack; ambiguous (≥2) → `AMBIGUOUS_OID_PREFIX` with `.data.candidates`;
  none → `objectNotFound`; full-40-hex short-circuits (no scan); length <4
  rejected. Plus `rev-parse.test.ts`: `rev-parse <7-hex>` resolves; ambiguous
  throws.
- **Green:** scan loose (`<2>/<38>`) via `fs.readdir` + pack-index fanout
  (reuse `pack-registry` lookup surface) for hex-prefix matches; cap candidate
  list; full-hex returns immediately.
- **Verify:** `npm run validate`. **Commit:** `feat(primitive): resolveOidPrefix abbreviated-oid resolution`.

## Slice 2 — sequencer `todo` grammar (domain)

**Files:** `src/domain/sequencer/todo.ts` (new); `src/domain/sequencer/index.ts`;
`todo.test.ts` + `todo.properties.test.ts` + `arbitraries.ts`.

- **Red:** example encodings (`pick <oid> <subject>\n`; multi-line; empty list →
  `''`; subject with spaces); parse rejects malformed (`INVALID_*`); property
  `parseTodo(serializeTodo(x)) ≡ x` (200 runs).
- **Green:** pure `serializeTodo(entries)` (full oids) / `parseTodo(text)`
  (returns `{command:'pick', oid, subject}` — oid left raw for the command to
  resolve).
- **Verify + Commit:** `feat(domain): sequencer todo serialize/parse`.

## Slice 3 — `cherry-pick-state` (CHERRY_PICK_HEAD + MERGE_MSG draft)

**Files:** `src/application/commands/internal/cherry-pick-state.ts` (new) + test.

- **Red:** write/read/clear `CHERRY_PICK_HEAD` (`<oid>\n`); absent → undefined;
  corrupt → `INVALID_OBJECT_ID`; idempotent clear. `conflictMergeMsg(draft,
  paths)` produces `draft + "\n\n# Conflicts:\n" + "#\t<p>\n"…` (verified bytes).
- **Green:** thin `fs` wrappers reusing `ObjectId.from` validation (mirror
  `merge-state.ts`).
- **Verify + Commit:** `feat(commands): cherry-pick state (CHERRY_PICK_HEAD + conflict MERGE_MSG)`.

## Slice 4 — `sequencer-state` (git-byte-faithful dir I/O) (ADR-218)

**Files:** `src/application/commands/internal/sequencer-state.ts` (new) + test.
Depends on Slices 1 (prefix) + 2 (todo) + config `*InText` helpers.

- **Red:** round-trip `head`/`abort-safety` (`<oid>\n`); `writeSequencerTodo` →
  full-oid lines; `readSequencerTodo` resolves full **and** 7-hex abbreviated
  oids (via `resolveOidPrefix`) → full `ObjectId`s; `opts` writes git-config
  `[options]` with only non-default keys, reads them back; `clearSequencer`
  removes the dir; absent reads → undefined. Byte-layout assertions
  (TAB-indent, ` = `).
- **Green:** compose `todo` + config text helpers + `fs`.
- **Verify + Commit:** `feat(commands): git-faithful sequencer state I/O`.

## Slice 5 — `assertCleanWorkTree` (require_clean_work_tree)

**Files:** `src/application/commands/internal/clean-work-tree.ts` (new) + test.

- **Red:** clean → ok; index tree ≠ HEAD tree → `WORKING_TREE_DIRTY` (paths);
  worktree ≠ index → `WORKING_TREE_DIRTY`; stage>0 → dirty. **Isolated** test
  per branch (mutation rule).
- **Green:** `synthesizeTreeFromIndex` vs HEAD tree + `compareWorkingTreeEntry`
  per stage-0 entry; collect dirty paths.
- **Verify + Commit:** `feat(commands): assertCleanWorkTree (require_clean_work_tree)`.

## Slice 6 — extract `resolveCommitIsh` (+ prefix) (ADR-222)

**Files:** `src/application/commands/internal/commit-ish.ts` (new) + test;
`src/application/commands/merge.ts` (import it, delete local `resolveTarget`).

- **Red:** `commit-ish.test.ts` — 40-hex; abbreviated (via `resolveOidPrefix`);
  ref DWIM; annotated-tag peel; not-found. Existing `merge.test.ts` stays green
  (behaviour-preserving move).
- **Green:** move `resolveTarget` → `resolveCommitIsh`, insert the prefix branch;
  `merge` re-imports.
- **Verify + Commit:** `refactor(commands): extract resolveCommitIsh with abbreviated-oid support`.

## Slice 7 — `cherry-pick.ts` skeleton: single clean pick (ADR-217/220)

**Files:** `src/application/commands/cherry-pick.ts` (new — `cherryPickRun`
+ types); `cherry-pick.test.ts`.

- **Red:** clean single pick onto HEAD: author preserved verbatim, committer =
  config user, single parent = old HEAD, branch advanced, tree == 3-way merge,
  index staged, reflog `cherry-pick: <subject>`; root-commit pick (empty base);
  refusals: detached HEAD, unborn branch, dirty tree (`assertCleanWorkTree`),
  pending op.
- **Green:** `run` → `expandRevisions` (single arg only for now via
  `resolveCommitIsh`) → `assertCleanWorkTree` → `applyOnePick` clean path →
  `createPickCommit`. `{multiPick:false}`.
- **Verify + Commit:** `feat(cherry-pick): single clean pick`.

## Slice 8 — `-x` record-origin (ADR-219)

- **Red:** `recordOrigin:true` appends `(cherry picked from commit <full-40-hex>)`
  with the verified blank-line separation; without `-x` the message is verbatim.
- **Green:** `appendCherryPickOrigin` in `commit-ish`/message helper; `messageDraft`.
- **Verify + Commit:** `feat(cherry-pick): -x record-origin line`.

## Slice 9 — single conflict stop + `continue` (ADR-220)

- **Red:** conflicting pick → `{kind:'conflict', commit, conflicts, remaining:0}`,
  `CHERRY_PICK_HEAD` set, `MERGE_MSG` = draft + conflicts block, stage1/2/3
  entries, working-tree markers, **no** sequencer dir; `continue` with resolved
  index → single-parent commit, author preserved, reflog
  `commit (cherry-pick):`, state cleared; `continue` with stage>0 →
  `MERGE_HAS_CONFLICTS`; `continue`/`skip`/`abort` with nothing →
  `NO_OPERATION_IN_PROGRESS`; empty-on-continue re-stop.
- **Green:** `applyOnePick` conflict branch + `persistStop` (single-pick) +
  `cherryPickContinue` (`commitResolvedPick`).
- **Verify + Commit:** `feat(cherry-pick): conflict stop and continue`.

## Slice 10 — `commit.ts`: clear CHERRY_PICK_HEAD without a second parent (ADR-220)

**Files:** `src/application/commands/commit.ts` + `commit.test.ts` additions.

- **Red:** resolving a cherry-pick via `repo.commit` → single parent (not two),
  `CHERRY_PICK_HEAD`+`MERGE_MSG` cleared, reflog `commit (cherry-pick): <subj>`;
  a normal commit and a merge-resolving commit are unchanged (regression).
- **Green:** read both markers; `except` selection; `buildParents` excludes
  cherry-pick; reflog branch; clear on success.
- **Verify + Commit:** `feat(commit): clear CHERRY_PICK_HEAD without a second parent`.

## Slice 11 — empty stop + `--allow-empty` (ADR-219)

- **Red:** redundant pick (merged tree == HEAD tree) without `allowEmpty` →
  `{kind:'empty', commit, remaining}`, state persisted; with `allowEmpty` → empty
  commit created, branch advanced.
- **Green:** `applyOnePick` empty branch; `allowEmpty` gate in clean + continue.
- **Verify + Commit:** `feat(cherry-pick): empty-pick stop and --allow-empty`.

## Slice 12 — `-n` no-commit (ADR-219)

- **Red:** `noCommit:true` single → index+worktree staged, HEAD unchanged, no
  state, `{kind:'no-commit', sources}`; range → cumulative index; `-n` conflict →
  `{kind:'conflict'}` with **no** `CHERRY_PICK_HEAD`/sequencer; `continue` after
  `-n` → `NO_OPERATION_IN_PROGRESS`.
- **Green:** `runNoCommit` (accumulating-index loop), branched in `run`.
- **Verify + Commit:** `feat(cherry-pick): -n no-commit path`.

## Slice 13 — range expansion + multi-pick sequence (ADR-218)

- **Red:** `expandRevisions` for `A..B` (oldest-first); `A...B`/`^` →
  `INVALID_OPTION`; clean range applies N in order, **no** sequencer dir left;
  range conflict mid-way → sequencer dir written (head/todo[current+rest]/
  abort-safety/opts), `CHERRY_PICK_HEAD` set, `remaining` correct; `continue`
  finishes the rest; `continue` resumes a git-written abbreviated todo (in-repo
  fixture). Multi-arg list concatenation.
- **Green:** `expandRevisions` ranges via `walkCommits`; `runSequence`
  `multiPick` path; `persistStop`/`writeSequencer`; `continue` resume loop +
  `resolveResumeOpts`.
- **Verify + Commit:** `feat(cherry-pick): range expansion and resumable sequence`.

## Slice 14 — `skip` + `abort` (ADR-218)

- **Red:** `skip` drops the current pick (resets index/worktree to HEAD),
  resumes the rest; last-pick skip → `{kind:'picked', commits:[]}`. `abort`
  (single) resets worktree+index to HEAD, clears `CHERRY_PICK_HEAD`; `abort`
  (sequence) resets to `sequencer/head`, clears the dir; detached → unsupported.
- **Green:** `cherryPickSkip` + `cherryPickAbort` (reset mirrors `abortMerge`).
- **Verify + Commit:** `feat(cherry-pick): skip and abort`.

## Slice 15 — merge-commit partial-apply (ADR-221)

**Files:** `cherry-pick.ts`; `src/domain/commands/error.ts`
(+`CHERRY_PICK_MERGE_NO_MAINLINE`).

- **Red:** single merge-commit pick → `CHERRY_PICK_MERGE_NO_MAINLINE` (commit
  oid), no state; range with a merge → earlier picks committed, stop at merge,
  sequencer `todo[0]`=merge, **no** `CHERRY_PICK_HEAD`; `skip` drops the merge
  and resumes; `abort` resets. `-n` merge → throws, no state.
- **Green:** `isMergeCommit` guard in `runSequence` + `runNoCommit`;
  `writeSequencer` (no CHERRY_PICK_HEAD).
- **Verify + Commit:** `feat(cherry-pick): merge-commit partial-apply stop`.

## Slice 16 — namespace + facade wiring (ADR-217)

**Files:** `cherry-pick-namespace.ts` (new); `commands/index.ts`;
`repository.ts` (interface slot + binding).

- **Red:** `repository.test.ts` — `repo.cherryPick.{run,continue,skip,abort}`
  exist, are frozen, run the dispose `guard()`, forward to the commands.
- **Green:** `bindCherryPickNamespace`; export; add `cherryPick:
  commands.CherryPickNamespace` to `Repository` between `checkout`/`clone`.
- **Verify + Commit:** `feat(repository): expose repo.cherryPick namespace`.

## Slice 17 — cross-tool interop (ADR-218, both directions)

**Files:** `test/integration/cherry-pick-interop.test.ts` (new);
`interop-helpers.ts` if a helper is missing; `@writes` surface registration.

- **Red/Assert:** tsgit `run` vs real `git cherry-pick` — HEAD tree, author/
  committer/message, parent count, index+worktree readback; `-x` byte-parity;
  range parity; co-refusals (merge w/o -m, dirty index). **Resume both ways:**
  (a) tsgit range conflict → `git cherry-pick --continue/--skip/--abort`
  finishes; (b) git range conflict → `repo.cherryPick.continue/skip/abort`
  finishes (exercises `resolveOidPrefix` on git's abbreviated todo).
- **Verify + Commit:** `test(interop): cherry-pick cross-tool parity and resume`.

---

## Post-implementation (workflow Steps 6–9)

- **Review ×3** (typescript / security / tests), fix-all-until-converged.
- **Architecture refactor pass** + scoped re-review (new workflow step):
  candidates to weigh — fold `cherry-pick-state` + `sequencer-state` + the
  `merge-state` writers behind one "operation-state" seam if duplication is real;
  unify `applyOnePick` clean/conflict index-lock handling with `merge`'s; share
  `resetToOrigHead`-style hard reset between `abortMerge` and `cherryPickAbort`.
  Only if it removes real duplication (YAGNI/KISS); otherwise record the
  consideration and move on.
- **Mutation** → 0 killable.
- **Docs + PR:** README, RUNBOOK, CONTRIBUTING, `docs/use/`, flip BACKLOG 22.1.

## Risks

- `appendCherryPickOrigin` trailer-adjacency edge cases — pin by interop, expand
  only if a fixture fails.
- `resolveOidPrefix` pack-index scan performance — bounded; not hot.
- Cross-tool resume fixtures need a real `git` on PATH (the interop suite already
  requires it).
