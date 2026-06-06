# Plan — read-model convergence (capstone)

Per-slice TDD script. Each slice is Red → Green → Refactor, one atomic
conventional commit, `npm run validate` green before every commit. No ignore
directives. No phase/ADR refs in source or tests.

Decisions locked (ADR-272 / ADR-273): focused convergence; `log` default
`order: 'date'` over `walkCommitsByDate`, `'first-parent'` over `walkCommits`;
`'date' | 'first-parent'` only; grammar resolution via `revParse` + peel;
`LogEntry` unchanged.

## Shared mechanism

`resolveCommit` / `resolveTreeish` = `revParse(ctx, rev)` then peel to commit /
tree. Peel reuses the **existing** `peel(ctx, id, target)` in
`commands/rev-parse.ts` (follows annotated tags ≤ 5 levels; `commit→tree` for the
tree target; otherwise `objectNotFound`). Export `peel` from `rev-parse.ts`
(internal — not added to any barrel). New `commands/internal/resolve-rev.ts` holds
both resolvers; `log` and `diff` (command layer) import it → no layer violation
(`revParse`/`peel` are command-layer).

---

## Slice 1 — `log` walk-order convergence (headline)

**Goal:** default `log` walks all parents in committer-date order
(`walkCommitsByDate`); `order: 'first-parent'` keeps today's `walkCommits` walk.
Rev resolution unchanged in this slice (still `resolveStart`/`resolveExcluding`).

**Red** — `log.test.ts`, new diamond fixture (reuse `writeCommitAt`):
`A(a) ← B(b), A ← C(c), {B,C} ← D(d)` with `a<b<c<d`, merge `D` parents `[B,C]`,
`refs/heads/main → D`.

- `Given a diamond / When log (default) / Then yields [D,C,B,A]` — all parents,
  newest committer-date first. Fails today: default first-parent yields `[D,B,A]`
  (drops `C`).
- `Given a diamond / When log order:'first-parent' / Then yields [D,B,A]` — passes
  trivially today; pins the branch so a later default-order mutant is caught.

Run `npx vitest run test/unit/application/commands/log.test.ts` → first case red
(`C` missing).

**Green** — `log.ts`:
- add `export type LogOrder = 'date' | 'first-parent';` and `order?: LogOrder` to
  `LogOptions`; export `LogOrder` from the barrel beside `LogOptions`.
- branch the walk: `order === 'first-parent'` → `walkCommits(ctx, { from:[start],
  until: exclude, order:'first-parent' })`; else `walkCommitsByDate(ctx, {
  from:[start], until: exclude })`. Both yield `Commit` (`.id` + `.data`), so the
  loop body / `project()` mapping is identical and stays verbatim.
- keep the `before` skip-filter and `limit` break verbatim.

Public-API note: this slice is the **only** one that changes the public surface
(adds `order` + `LogOrder`). `npm run validate` does **not** gate `reports/api.json`
(only the prepush `check:doc-typedoc` does), so api.json is regenerated in the next
commit; intermediate commits stay validate-green.

Re-run → green. Keep existing linear-chain cases green (date ≡ first-parent on a
chain).

**Refactor** — extract the walk selection to a small `selectWalk(ctx, opts,
start, exclude)` helper if `log` exceeds the ~20-line guard; else inline.

**Commit:** `feat(log): default to committer-date all-parents walk with order option`

---

## Slice 2 — `log` grammar resolution

**Goal:** `rev` and each `excluding` resolve via the full `revParse` grammar,
peeling to a commit; unresolvable entries throw (faithful), not skip.

**Red** — `log.test.ts`:
- `Given rev 'HEAD~2' / Then starts two commits back` (linear chain) — fails today
  (`resolveStart` has no `~` grammar → throws).
- `Given rev is an annotated tag / Then peels to its commit` — build an annotated
  tag object over the tip; fails today (`resolveStart` returns the tag oid → walk
  yields nothing).
- `Given excluding ['HEAD~1'] / Then stops at the parent` (grammar in excluding).
- `Given excluding ['does-not-exist'] / Then throws OBJECT_NOT_FOUND` — assert
  `err.data.code` (was silently skipped). Isolated from the bad-`rev` case.
- update the **unborn-HEAD** case: expected code `REF_NOT_FOUND` → `OBJECT_NOT_FOUND`
  with a comment that `log` now resolves via the grammar (consistent with
  `show`/`readFileAt`).

**Green:**
- `rev-parse.ts`: change `const peel` → `export const peel` (no other change).
- new `commands/internal/resolve-rev.ts`:
  ```ts
  export const resolveCommit = async (ctx, rev) => peel(ctx, await revParse(ctx, rev), 'commit');
  export const resolveTreeish = async (ctx, rev) => peel(ctx, await revParse(ctx, rev), 'tree');
  ```
- `log.ts`: delete `resolveStart` + `resolveExcluding` (and their two
  `// Stryker disable` comments); `start = await resolveCommit(ctx, rev ?? 'HEAD')`;
  `exclude = await Promise.all((excluding ?? []).map(e => resolveCommit(ctx, e)))`.

Re-run → green. The two equivalent-mutant suppressions are gone with the deleted
code (net suppression reduction). The existing oid-vs-ref disambiguation cases
(`r<40hex>` / `<40hex>r` branch names, decoy oids) stay green: `revParse` tries the
ref candidates **before** the oid-prefix fallback, so a 41-char name resolves as a
ref exactly as `resolveStart` did.

**Refactor** — none expected; `log` is now a thin projection.

**Commit:** `feat(log): resolve rev/excluding via the full revParse grammar`

---

## Slice 3 — `diff` grammar resolution

**Goal:** `diff`'s `from`/`to` resolve via the grammar, peeling to a tree;
`git diff HEAD^` now works.

**Red** — `diff.test.ts`:
- `Given from 'HEAD^' / Then diffs the parent's tree against HEAD's working set` —
  fails today (`resolveTreeId` has no `^` grammar).
- keep an existing oid/ref case green (regression guard).

**Green** — `diff.ts`: replace `resolveTreeId` with
`resolveTreeish(ctx, target)` from `resolve-rev.ts`; delete the local
`resolveTreeId`.

Re-run → green.

**Commit:** `feat(diff): resolve from/to via the full revParse grammar`

---

## Slice 4 — interop goldens

**Goal:** pin the converged behaviour byte-for-byte against real `git`.

**Red/Green** — new `test/integration/log-interop.test.ts` (mirror
`history-interop.test.ts`: `skipIf(!GIT_AVAILABLE)`, scrubbed `GIT_*`, signing off,
shared `beforeAll` repo, 60s timeout). Build a branchy DAG with strictly-decreasing
committer dates + an annotated tag, then assert:

- `repo.log()` oids === `git log --format=%H` (default order, all parents);
- `repo.log({ order:'first-parent' })` oids === `git log --first-parent --format=%H`;
- `repo.log({ rev: <annotated-tag> })` oids === `git log --format=%H <tag>`
  (peel);
- `repo.log({ excluding:['HEAD~2'] })` oids === `git rev-list HEAD~2..HEAD` (linear
  tip segment — boundary ≡ git's `^`; see design §excluding semantics).

Add a `diff` interop step (same file or `diff-interop` if one exists): the
`repo.diff({ from:'HEAD^' })` changed-path set === `git diff --name-only HEAD^ HEAD`.

**Commit:** `test(interop): pin converged log + diff against real git`

---

## Slice 1b — regenerate api.json (immediately after slice 1)

- `npm run docs:json` regenerates `reports/api.json` for the new `LogOrder` type +
  `LogOptions.order` field; commit it. The typedoc-id churn is expectedly large —
  that is normal. Placed right after slice 1 (the only public-API change) so the
  prepush `check:doc-typedoc` (`git diff --exit-code -- reports/api.json`) is green
  at push.
- **Commit:** `chore(api): regenerate api.json for LogOrder/order`

(README / use-page / BACKLOG flip happen in workflow Step 9, not here.)

---

## Step 7 — architecture pass (after slices, before mutation)

Seeded by the diff. The shared `resolve-rev.ts` already centralises log+diff
resolution, so the "extract shared resolver" gain is **already landed** in the
feature slices — the pass verifies that and looks wider:

- **Consider** routing the other grammar-less `resolveCommitIsh` consumers
  (`merge`/`cherry-pick`/`revert`/`rebase`/`blame`/`describe`) through the grammar.
  **Expected: no-op / deferred** — those take a *commit-ish argument* where git
  itself does not always accept the full `~`/`^` selector the same way, and
  widening them is a behaviour change beyond this feature's read-convergence
  concern (out of bounded blast radius). Document the consideration.
- **Confirm** `describe`'s bespoke date walk stays divergent (23.4l): its walk
  carries candidate/depth bookkeeping, not a plain reachable-set; rule-of-three on
  a *plain* date walk is unmet. No-op with justification.
- If `resolve-rev.ts` + `peel` export reveal a cleaner home for `peel` (e.g. a
  shared `internal/peel.ts` both `rev-parse` and `resolve-rev` import, removing the
  command→command `peel` export), do that behaviour-preserving move as a
  `refactor(rev-parse): …` commit.

Re-review the `refactor(...)` diff (ts / security / tests), ≤3 cycles, re-validate.

---

## Step 8 — mutation

`./node_modules/.bin/stryker run --mutate src/application/commands/log.ts
--mutate src/application/commands/diff.ts --mutate
src/application/commands/internal/resolve-rev.ts` (scoped per
`project_local_mutation_scoping`). Kill survivors or annotate provably-equivalent
inline. Targets: the `order` branch (diamond pair), peel-to-commit/tree
(tag-peel + tree-error cases), resolver throw (isolated bad-rev / bad-excluding),
`before`/`limit` boundaries.

## Test inventory (coverage 100% on touched files)

- `log.test.ts` — diamond date order, first-parent, tie-break, `HEAD~2` rev,
  annotated-tag peel, grammar excluding, bad-excluding throw, bad-rev throw,
  unborn-HEAD (new code), `before` `≥` boundary, `limit`, linear regressions.
- `diff.test.ts` — `HEAD^` resolves, oid/ref regression.
- `resolve-rev.test.ts` — commit passthrough, tag→commit peel, tree→commit
  refusal, commit→tree (treeish), grammar `~`/`^`.
- `log-interop.test.ts` — the four `git log`/`rev-list` goldens + the `diff`
  golden.
