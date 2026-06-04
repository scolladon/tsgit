# Plan — merge/pull reshape

Three behaviour-isolated-then-mechanical slices, each its own atomic breaking
commit, `npm run validate` green before each. ADRs 263 (namespace), 264
(fastForward tristate), 265 (internal reflog channel).

Order rationale: the two small **behaviour/option** changes (FF enum, reflog
channel) land first on the stable old names, keeping each diff focused; the large
**pure rename** (namespace) lands last so it is mechanical and review-trivial.

`check:doc-typedoc` (api.json) runs only in `prepush`, not `validate`, so api.json
is regenerated once in the docs phase. `check:doc-coverage` / `check:doc-links`
run in `validate`: they require a page+index-row for every *bound* command and
that every link resolves — both stay satisfied through slice 3 because `merge.md`
already exists and the stale `abortMerge`/`continueMerge` pages+rows still
resolve (they are folded/removed in the docs phase, not slice 3).

---

## Slice 1 — `fastForward` tristate enum (merge + pull) — ADR-264

**Files:** `src/application/commands/merge.ts`, `src/application/commands/pull.ts`,
`test/unit/application/commands/merge.test.ts`,
`test/unit/application/commands/pull.test.ts`.

**Red**
- `merge.test.ts`:
  - Rewrite the `noFastForward=true` case → `fastForward: 'never'` (asserts a
    merge commit is produced on an ancestor target).
  - Rewrite the `fastForwardOnly=true` diverged case → `fastForward: 'only'`
    (asserts `NON_FAST_FORWARD` with its `.data` — branch/our/their oids).
  - Add an isolated `fastForward: 'allow'` case **and** an omitted-field case on a
    fast-forwardable history → both fast-forward (kills the default mutant + the
    `!== 'never'` guard).
  - Add an isolated `fastForward: 'only'` case on a **fast-forwardable** history →
    succeeds as fast-forward (proves `'only'` does not over-refuse).
- `pull.test.ts`: rewrite the `fastForwardOnly` / `noFastForward` forwarding tests
  → `fastForward` forwarding (one test per enum value reaching `merge`).
- Run `npx vitest run test/unit/application/commands/merge.test.ts test/unit/application/commands/pull.test.ts` → fail (field unknown / guard mismatch).

**Green**
- `merge.ts`: replace `fastForwardOnly?`/`noFastForward?` on `MergeOptions` with
  `fastForward?: 'only' | 'never' | 'allow'`. Translate the two guards:
  - `if (base === ourId) { if (opts.fastForward !== 'never') { …fast-forward… } }`
  - `if (opts.fastForward === 'only') throw nonFastForward(head.target, ourId, theirId);`
- `pull.ts`: replace the two booleans on `PullOptions` with
  `fastForward?: 'only' | 'never' | 'allow'`; forward
  `...(opts.fastForward !== undefined ? { fastForward: opts.fastForward } : {})`
  to `merge`. Drop the two old `Stryker disable` forwarding annotations; re-derive
  any needed equivalent-mutant note for the single new conditional spread.
- Re-run the two files → green.

**Refactor** none expected (1-for-2 field swap).

**Validate + commit:** `npm run validate`; `refactor(merge)!: replace fast-forward boolean pair with a tristate enum`.

---

## Slice 2 — internal reflog channel, drop public `reflogLabel` (merge + pull) — ADR-265

**Files:** `src/application/commands/merge.ts`, `src/application/commands/pull.ts`,
`test/unit/application/commands/merge.test.ts`,
`test/unit/application/commands/pull.test.ts`.

**Red**
- `merge.test.ts` (`merge — reflogLabel` block → rename block to
  `merge — internal reflog action`):
  - Keep the "no override → `merge feature: Fast-forward`" default case.
  - Rewrite the two `reflogLabel: 'pull'` cases to pass the **third arg**:
    `merge(ctx, { target: 'feature' }, { reflogAction: 'pull' })` and the forced
    `fastForward: 'never'` variant with the third arg → assert `pull: Fast-forward`
    / `pull: Merge made by the 'tsgit' strategy.`.
  - Add an isolated default-merge-commit reflog case (no third arg, `'never'`) →
    `merge feature: Merge made by the 'tsgit' strategy.` (kills the `?? default`
    mutant at the merge-commit site, mirroring the FF site).
- `pull.test.ts`: the existing pull reflog expectations (`pull: …`) stay; only the
  internal wiring under test changes — verify still green after Green step.
- Run the two files → fail (`reflogLabel` removed / third arg unsupported).

**Green**
- `merge.ts`: drop `reflogLabel` from `MergeOptions`; add (module-local, **not**
  barrel-exported) `interface MergeInternalOptions { readonly reflogAction?: string }`;
  add the third param `internal: MergeInternalOptions = {}` to `merge`; at both
  reflog sites use `internal.reflogAction ?? \`merge ${opts.target}\``. Thread
  `internal` from `merge` → `mergeCommit` → `commitCleanMerge` (the merge-commit
  reflog site).
- `pull.ts`: drop `reflogLabel: 'pull'` from the merge options object; pass
  `{ reflogAction: 'pull' }` as the third arg to `merge`.
- Re-run → green.

**Refactor** confirm `MergeInternalOptions` is not added to `commands/index.ts`.

**Validate + commit:** `npm run validate`; `refactor(merge)!: route the reflog action through an internal channel and drop public reflogLabel`.

---

## Slice 3 — `repo.merge.{run,continue,abort}` namespace + symbol/type renames — ADR-263

**New:** `src/application/commands/internal/merge-namespace.ts`.

**Red**
- `test/unit/repository/repository.test.ts`:
  - Remove `'abortMerge'` and `'continueMerge'` from the top-level key list; keep
    `'merge'`.
  - Add `'merge'` to the `namespaceKeys` set in the typeof-binding test.
  - Rewrite the dispose-guard cases (lines ~419/428/443/461) from
    `sut.abortMerge` / `sut.continueMerge` → `sut.merge.abort` / `sut.merge.continue`
    (and add `sut.merge.run` typeof/guard coverage).
- Run `npx vitest run test/unit/repository/repository.test.ts` → fail.

**Green**
- Rename in `merge.ts`: `merge` → `mergeRun`; `MergeOptions` → `MergeRunInput`
  (update `resolveMergeAuthor`/`resolveMergeCommitter`/`mergeCommit`/
  `commitCleanMerge`/`persistConflictState` param types accordingly).
- Rename in `continue-merge.ts`: `continueMerge` → `mergeContinue`;
  `ContinueMergeOptions` → `MergeContinueInput`;
  `ContinueMergeResult` → `MergeContinueResult`.
- Rename in `abort-merge.ts`: `abortMerge` → `mergeAbort`;
  `AbortMergeResult` → `MergeAbortResult`.
- New `internal/merge-namespace.ts`: `MergeNamespace { run, continue, abort }` +
  `bindMergeNamespace(ctx, guard)` (mirror `bindRebaseNamespace`); each verb runs
  `guard()` then forwards (`run: (input) => mergeRun(ctx, input)` — no third arg).
- `commands/index.ts`: replace the `abort-merge` / `continue-merge` / `merge`
  function+type exports with the renamed symbols; add
  `bindMergeNamespace` / `MergeNamespace` (drop the now-unused
  `AbortMergeResult`/`ContinueMerge*`/`MergeOptions` names).
- `repository.ts`: change the `merge` interface member to
  `readonly merge: commands.MergeNamespace;`; remove the `abortMerge` /
  `continueMerge` interface members; in the factory replace the three flat
  bindings with `merge: commands.bindMergeNamespace(ctx, guard)`. Update the
  binding-list doc comment count if present.
- `pull.ts`: update the `merge` import → `mergeRun`; call `mergeRun(ctx, …, { reflogAction: 'pull' })`.
- Update all remaining call sites:
  - `merge.test.ts` / `continue-merge.test.ts` / `abort-merge.test.ts` — imports +
    `merge(` → `mergeRun(`, `continueMerge(` → `mergeContinue(`,
    `abortMerge(` → `mergeAbort(`; type names.
  - `test/integration/merge-state-machine.test.ts`,
    `test/integration/merge-abort-interop.test.ts`,
    `test/integration/network/pull-http-backend.test.ts` —
    `repo.merge(` → `repo.merge.run(`, `repo.abortMerge(` → `repo.merge.abort(`,
    `repo.continueMerge(` → `repo.merge.continue(`.
  - `test/parity/scenarios/merge-ff.scenario.ts`,
    `merge-abort.scenario.ts`, `merge-continue.scenario.ts` — same call-site
    rewrites (keeps browser-surface coverage of `merge` via the namespace call).
- Run `npx vitest run` over the touched suites → green.

**Refactor** none (pure rename).

**Validate + commit:** `npm run validate`; `refactor(merge)!: expose merge as a run/continue/abort namespace`.

---

## Post-slice phases (per workflow)

- **Step 6 reviews** (typescript / security / tests) over `git diff main...HEAD`.
- **Step 7 architecture** — seeded by the diff; likely a no-op (the binder already
  matches the sibling pattern). Candidate to *consider*: whether the five
  namespace binders share enough to centralise a `bindNamespace` helper — almost
  certainly **rejected** under YAGNI (each has a distinct verb set/signature);
  record the consideration.
- **Step 8 mutation** — scope Stryker to the touched files
  (`merge.ts`, `continue-merge.ts`, `abort-merge.ts`, `pull.ts`,
  `internal/merge-namespace.ts`). New mutation surfaces: the `fastForward` guard
  comparisons, the `reflogAction ?? default` sites, the internal-arg default.
- **Step 9 docs:** fold `abort-merge.md` + `continue-merge.md` into `merge.md`
  (document `repo.merge.{run,continue,abort}` + `fastForward`), delete those two
  pages, drop their index rows from `docs/use/commands/README.md`; update
  `pull.md` (enum), `migrate-from-isomorphic-git.md` call sites, the README
  Tier-1 count, regenerate `reports/api.json`, flip `docs/BACKLOG.md` 23.4d → `[x]`.
- **Step 10:** push, PR, CI, admin squash-merge `--delete-branch`, `git sync`.
