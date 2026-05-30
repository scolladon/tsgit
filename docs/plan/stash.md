# Plan — `stash` (push / pop / list / drop / apply)

Implements `docs/design/stash.md` per ADRs 210–216. Each slice is one atomic
conventional commit; `npm run validate` green before every commit; TDD
Red→Green→Refactor; GWT/AAA, `sut`, 100% L/B/F/S, mutation-resistant assertions
(assert `.data`, isolate guard clauses).

## Dependency graph

```
S0 fix(rev-parse) refCandidates  ─ independent
S1 error codes ─┐
S2 messages ────┼─ foundation (mutually independent)
S3 stash-ref ───┤
S4 apply-merge ─┘
       │
S5 stashEntry wiring  (needs S3 + commit parent read)
S6 push   (needs S1,S2,S3)
S7 list+drop (needs S3)
S8 apply+pop (needs S1,S3,S4)
S9 namespace + facade + exports (needs S6,S7,S8)
S10 interop/parity (needs S9 [+ S0 for rev-parse stash@{N}])
```

S0–S4 are parallel-safe in principle; executed sequentially in-thread.

---

## S0 — `fix(rev-parse): gitrevisions ref-DWIM ladder` (ADR-216)

**Files:** `src/domain/refs/ref-candidates.ts`; tests in
`test/unit/domain/refs/ref-candidates.test.ts`, plus any `rev-parse`/`merge`
resolution-order tests that encode the old heads-before-tags order.

- **Red:** add cases asserting the candidate list is exactly
  `[base, refs/<base>, refs/tags/<base>, refs/heads/<base>, refs/remotes/<base>, refs/remotes/<base>/HEAD]`
  (order + the two new entries). Add a `rev-parse` test: a name that is both a
  tag and a branch resolves to the **tag**.
- **Green:** rewrite `refCandidates` to the 6-rule order; insert `refs/<base>`
  and `refs/remotes/<base>/HEAD`; swap heads/tags.
- **Verify:** update existing `rev-parse`/`merge` tests that asserted the old
  order; `npm run validate`. Confirm no regression in `merge` target DWIM
  (origin/main, tags still resolve).
- **Commit:** `fix(rev-parse): gitrevisions ref-DWIM candidate order`

## S1 — `feat(error): stash error codes`

**Files:** `src/domain/commands/error.ts` (+ barrel if needed); tests
`test/unit/domain/commands/error.test.ts` (or the stash command tests asserting
`.data`).

- **Red:** unit tests for three factories asserting `.data.code` + payload:
  `noInitialCommit()` → `{ code:'NO_INITIAL_COMMIT' }`;
  `stashNotFound(index, stackSize)` → `{ code:'STASH_NOT_FOUND', index, stackSize }`;
  `stashApplyWouldOverwrite(paths)` → `{ code:'STASH_APPLY_WOULD_OVERWRITE', paths }`.
- **Green:** add the three members to the `CommandError` union + factory fns,
  mirroring existing patterns (paths verbatim — they are pathspec-validated index
  paths, as in `rm`).
- **Verify:** `npm run check:types`, `npm run test:unit`.
- **Commit:** `feat(error): stash refusal + selector error codes`

## S2 — `feat(stash): message builders` (pure)

**Files:** `src/application/commands/internal/stash-message.ts`;
`test/unit/application/commands/internal/stash-message.test.ts` +
`stash-message.properties.test.ts`; shared `arbitraries.ts` if needed.

Pure functions over `(branchLabel, abbrev, subject, customMessage?)`:
- `wipMessage` → `WIP on <branch>: <abbrev> <subject>`
- `onMessage` → `On <branch>: <message>`
- `indexMessage` → `index on <branch>: <abbrev> <subject>`
- `untrackedMessage` → `untracked files on <branch>: <abbrev> <subject>`
- `branchLabel(head)` → symbolic short-name or `(no branch)` when detached
- `subjectOf(commitMessage)` → first line.

- **Red:** example tests for each builder (branch + detached), subject extraction
  (first line of a multi-line message; empty message).
- **Green:** implement; small functions, early returns.
- **Property** (lens 3 — total function): `wip/on/index/untracked` builders never
  throw over arbitrary single-line ASCII subjects/branches (`numRuns: 100`).
  Note in the file why round-trip/composition lenses don't fit (no parser here).
- **Verify:** `npm run validate`.
- **Commit:** `feat(stash): faithful WIP/index/untracked message builders`

## S3 — `feat(stash): refs/stash reflog primitive` (ADR-213, ADR-214)

**Files:** `src/application/primitives/stash-ref.ts`;
`test/unit/application/primitives/stash-ref.test.ts`.

Functions:
- `readStashStack(ctx): Promise<ReadonlyArray<{ index; selector; stash; message }>>`
  — `readReflog('refs/stash')` newest-first; `[]` when absent.
- `resolveStashEntry(ctx, index): Promise<ObjectId>` — pick newest-first
  position `len-1-index`; out of range → `stashNotFound(index, len)`.
- `pushStashRef(ctx, w, message): Promise<void>` — write `refs/stash`
  (`atomicWriteRef`/`looseRefPath`) to `w` AND **force-append** the reflog entry
  directly (`appendReflog` with resolved identity, `oldId` = current ref or
  `ZERO_OID`, sanitised message), bypassing the `shouldAutocreateReflog` gate.
- `dropStashEntry(ctx, index): Promise<{ dropped; remaining }>` — remove reflog
  line at file position; if survivors remain → write `refs/stash` directly to the
  new newest survivor's `newId` + `writeReflog(survivors)`; else delete the loose
  ref + `deleteReflog`. Never via `updateRef`.

- **Red:** memory-adapter tests: push creates ref+reflog (first push → reflog
  exists, oldId=ZERO_OID); two pushes stack newest-first; `resolveStashEntry`
  index 0/1 + out-of-range throws `STASH_NOT_FOUND` with `.data`; drop middle
  re-points ref to new top; drop last deletes ref+reflog; `readStashStack` empty
  when absent.
- **Green:** implement, reusing `reflog-store`, `atomic-write`, `ref-store`,
  `reflog-identity`, `ZERO_OID`.
- **Verify:** `npm run validate`.
- **Commit:** `feat(stash): refs/stash reflog stack primitive`

## S4 — `feat(merge): apply-merge-to-worktree primitive` (ADR-215)

**Files:** `src/application/primitives/apply-merge-to-worktree.ts` +
`internal/write-working-tree-file.ts` (small worktree writer/remover, primitive
layer); tests
`test/unit/application/primitives/apply-merge-to-worktree.test.ts`.

Contract:
```
applyMergeToWorktree(ctx, { baseTree?, oursTree, theirsTree })
  → { kind:'clean';    mergedTree: ObjectId; indexEntries: ReadonlyArray<IndexEntry> }   // stage-0
  | { kind:'conflict'; conflicts: ReadonlyArray<MergeConflict>; indexEntries: ReadonlyArray<IndexEntry> } // stage 1/2/3 + stage-0 clean
```
- `flattenTree` each side → `mergeTrees(base, ours, theirs, contentMerger)`
  (content merger mirrors `merge.ts`'s capped readBlob → `mergeContent`).
- Reject unsupported conflict types upfront (rename-rename, gitlink) before any
  write — atomic, like `merge`.
- Clean: write each outcome to the working tree (resolved-merged bytes,
  resolved-known/unchanged blob, resolved-deleted removal) via the worktree
  writer; synthesise the merged tree; build post-write stage-0 `IndexEntry[]`.
- Conflict: write markers (`conflict.conflictContent` ?? `writeConflictMarkers`)
  + resolved outcomes; build index = stage-0 (clean paths) + `conflictsToIndexEntries`.
- Does **not** import from `commands/merge.ts` (dependency direction); duplicates
  the small writer logic (ADR-215 acknowledged overlap; merge migration deferred).
- Does **not** write `MERGE_HEAD`/commit/ref — pure worktree+index application.

- **Red:** memory-adapter tests: clean take-theirs; clean take-ours (no-op);
  clean both-changed-merge; content conflict → markers in worktree + stage-1/2/3
  entries + `cleanMerge:false`; unsupported type rejected before any write
  (assert worktree untouched).
- **Green:** implement.
- **Verify:** `npm run validate`.
- **Commit:** `feat(merge): three-way merge → working-tree+index primitive`

## S5 — `feat(snapshot): wire stashEntry factory` (design §7)

**Files:** `src/application/primitives/snapshot/snapshot-factory.ts`;
extend `test/unit/application/primitives/snapshot/snapshot-factory.test.ts`.

- Replace the `stashEntry: async (stashIndex) => null` stub: resolve
  `refs/stash` reflog[stashIndex] → W oid (`null` when absent / out of range);
  read W; build the trio of lazy `TreeSnapshot`s — `index` from `W^2^{tree}`,
  `workdir` from `W^{tree}`, `untracked` from `W^3^{tree}` if a 3rd parent
  exists else `null`. No tree parse until iterated (construction discipline).
- **Red:** extend the factory test — null when no stash / index out of range;
  trio for a 2-parent stash (`untracked === null`); trio for a 3-parent stash
  (`untracked` non-null); lazy (constructing does no parse — assert no read until
  `entries()` iterated, matching existing lazy tests).
- **Green:** implement (reuse `readReflog`/`resolveStashEntry` from S3, `readObject`).
- **Verify:** `npm run validate`.
- **Commit:** `feat(snapshot): parse stash entry into the snapshot trio`

## S6 — `feat(stash): push` (ADR-211, ADR-214)

**Files:** `src/application/commands/stash.ts` (push + shared helpers);
`test/unit/application/commands/stash.test.ts`.

Algorithm = design §4. Helpers: `workingTreeEntries(ctx, index)` — per stage-0
entry, `compareWorkingTreeEntry` → `absent`: drop; `unchanged`: reuse entry;
`modified`: `lstat` for the working mode + `hashBlob` the working content (which
**writes the blob** so the synthesised tree's references exist) → new stage-0
entry. Untracked enumeration: `walkWorkingTree` + `buildRepoIgnorePredicate`,
`hashBlob` each → synthetic stage-0 entries → `synthesizeTreeFromIndex` → u_tree.
Reset to clean tracked tree: HEAD does **not** move during push, so do **not**
reuse the porcelain `reset` command (it would append a spurious branch/HEAD
reflog entry). Instead reset working tree + index directly under the index lock:
`materializeTree(b_tree, currentIndex, force, forceRewriteAll)` + `lock.commit(
newIndexEntries)` — touches working tree + index only, never refs/HEAD. Then if
`-u` remove the stashed untracked files from disk; if `keepIndex` re-materialise
`i_tree` into working tree + index afterwards.

- **Red:** unborn HEAD → `NO_INITIAL_COMMIT` (`.data`); no changes →
  `{kind:'no-local-changes'}` (no ref written); working-only change saved + clean
  tree after; staged change saved; message default vs `-m`; detached →
  `(no branch)`; `-u` saves untracked + removes from disk + 3-parent W;
  `keepIndex` leaves index staged.
- **Green:** implement; functions <20 lines, extract helpers.
- **Verify:** assert W parents/trees by reading objects; `refs/stash` reflog
  message byte-exact; `npm run validate`.
- **Commit:** `feat(stash): push — save working tree + index onto the stack`

## S7 — `feat(stash): list + drop` (ADR-213)

**Files:** `src/application/commands/stash.ts` (add `list`, `drop`); extend test.

- **Red:** `list` empty → `{entries:[]}`; ordering newest-first + selector
  `stash@{N}` + message; `drop` middle/oldest/newest, empties stack → ref+reflog
  gone, returns `{dropped, remaining}`; `drop` out of range → `STASH_NOT_FOUND`.
- **Green:** thin wrappers over S3 (`readStashStack`, `dropStashEntry`).
- **Verify:** `npm run validate`.
- **Commit:** `feat(stash): list + drop stack management`

## S8 — `feat(stash): apply + pop` (ADR-212)

**Files:** `src/application/commands/stash.ts` (add `apply`, `pop`); extend test.

Algorithm = design §5. Resolve W (S3) → parse parents (`b=W^1`, `i=W^2`,
`u=W^3?`); `c_tree = synthesizeTreeFromIndex(currentIndex)`; overwrite guard
(dirty-overlap → `STASH_APPLY_WOULD_OVERWRITE`, atomic); `applyMergeToWorktree(
base=b^{tree}, ours=c_tree, theirs=W^{tree})`. Clean → index stays c_tree;
`restoreIndex` → reinstate `i_tree`-vs-`b_tree` diff into index; restore
untracked from `u_tree` (refuse overwrite). Conflict → commit unmerged index
entries (lock), no `MERGE_HEAD`, return `{kind:'conflict'}`, stash retained.
`pop` = apply then drop on `applied` (return `dropped`); retain on `conflict`.

- **Red:** clean restore onto clean tree; restore onto staged state
  (stays staged + stash unstaged); `restoreIndex` re-stages; conflict → markers +
  unmerged index + stash retained; `STASH_APPLY_WOULD_OVERWRITE` (atomic, no
  write); `STASH_NOT_FOUND`; untracked restore + overwrite refusal; `pop` applied
  → dropped + re-index; `pop` conflict → retained.
- **Green:** implement.
- **Verify:** `npm run validate`.
- **Commit:** `feat(stash): apply + pop with faithful 3-way restore`

## S9 — `feat(stash): namespace + facade wiring + public surface`

**Files:** `src/application/commands/internal/stash-namespace.ts`;
`src/application/commands/index.ts`; `src/repository.ts`; `src/index.ts`;
`reports/api.json` (regenerated); tests
`test/unit/application/commands/internal/stash-namespace.test.ts`,
`test/unit/repository/*` wiring assertion.

- **Red:** namespace test — each method runs `guard()` first (throws when
  disposed) then forwards; object frozen (non-callable, can't monkey-patch).
  Repository test — `repo.stash` is a frozen namespace exposing the 5 verbs.
- **Green:** `bindStashNamespace(ctx, guard)` (mirror `bindBranchNamespace`);
  export `StashNamespace` + input/result types from `commands/index.ts`; add
  `readonly stash: commands.StashNamespace` to `Repository` + bind in the frozen
  facade; re-export public types from `src/index.ts`.
- **Verify:** regenerate `reports/api.json` (`npm run` doc-typedoc target) and
  commit it — prepush `check:doc-typedoc` gate requires it; `npm run validate`.
- **Commit:** `feat(stash): repo.stash namespace + public surface`

## S10 — `test(interop): stash porcelain vs canonical git` (ADR-204)

**Files:** `test/integration/stash-interop.test.ts`; mark `stash` a `@writes`
surface (`@writes` block in `commands/stash.ts` head) so `audit-write-surfaces`
tracks it; `@proves … interopSurface: stash` block in the test head.

- Drive `repo.stash.push` + peer `git stash`; assert `git stash list`,
  `git rev-parse stash@{0}^{tree}` / `^2^{tree}`, `git ls-files --stage`, and the
  post-push working tree agree. Clean `apply` round-trip parity. Co-refusal:
  unborn-HEAD push; `STASH_APPLY_WOULD_OVERWRITE` (both refuse). `rev-parse
  stash@{0}` resolves (S0 enables it).
- **Commit:** `test(interop): stash porcelain matches canonical git`

---

## Validation gate (every slice)

`npm run validate` (Biome + types + unit + coverage). Never commit red. Never
`--no-verify`, never ignore directives. After S1–S10: review ×3
(typescript/security/tests) + mutation to 0 killable, then docs + PR.

## Risks / watch-items

- **Force-create reflog (S3):** the most error-prone faithfulness point — a
  first push that silently drops the reflog entry breaks the stack. Test the
  first-push reflog existence explicitly.
- **Overwrite guard (S8):** must be atomic (compute before any write); cover the
  dirty-overlap path independently from the clean path.
- **Reset must preserve HEAD (S6):** push does not move HEAD, so reset the
  working tree + index directly (`materializeTree` + `lock.commit`, never refs)
  with `forceRewriteAll` so dirty tracked files are genuinely reset. The interop
  test (S10) compares HEAD + the branch reflog against canonical git to catch any
  spurious entry; verify the working tree is clean (tracked) after push, and that
  `-u`-stashed untracked files are removed while non-stashed untracked survive.
- **api.json (S9):** large typedoc-id diff is expected; must be committed.
