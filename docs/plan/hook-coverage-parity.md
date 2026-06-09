# Hook coverage parity — Implementation plan (24.8)

> Script for the implementation phase. Read top-to-bottom. Each slice is one
> atomic conventional commit, lands on a green `npm run validate`, and follows
> Red → Green → Refactor. Design: `design/hook-coverage-parity.md`. ADRs 299–301.

Conventions: GWT describe/it, AAA body, `sut`, 100% coverage, 0 killable
mutants. Never `--no-verify`, never an ignore directive, no phase/ADR refs in
source or test code. Run a single test file with
`npx vitest run <file>`; gate each commit with `npm run validate`.

---

## Slice 1 — `HookName` union + `runInformationalHook` primitive

**Commit:** `feat(hooks): add informational-hook runner + widen HookName union`

### Red

1. `test/unit/application/primitives/run-hook.test.ts` — add a
   `describe('primitives/run-hook runInformationalHook')` block:
   - Given no runner → `runInformationalHook(ctx, 'post-commit')` resolves
     (no throw).
   - Given a `skipped` hook → resolves.
   - Given a hook that exits 0 → resolves, and `runner.calls[0].name` is
     `'post-commit'`.
   - **Given a hook that exits non-zero → still resolves (no throw)** — the
     defining contrast with `runHook`; assert `runner.calls` recorded the fire.
   - Given args + stdin → forwarded verbatim (`args`, `stdin`).
   - Given a `ctx.signal` → forwarded; given none → no `signal` key.
   - Given `core.hooksPath` set → `calls[0].hooksDir` reflects it.
   Run → fails (no `runInformationalHook` export).

### Green

2. `src/domain/hooks/hook-name.ts` — widen the union (lifecycle order):
   `'pre-commit' | 'prepare-commit-msg' | 'commit-msg' | 'post-commit' | 'post-merge' | 'post-checkout' | 'pre-rebase' | 'post-rewrite'`.
3. `src/application/primitives/run-hook.ts` — extract a module-private
   `invokeHook(ctx, name, input): Promise<HookResult | undefined>` (the shared
   no-runner-short-circuit + readConfig + build-request + `runner.run`); rewrite
   `runHook` to consume it (unchanged exit-code policy); add and export
   `runInformationalHook(ctx, name, input = {}): Promise<void>` that awaits
   `invokeHook` and discards the result.
4. `src/application/primitives/index.ts` — export `runInformationalHook`.
   Run → green.

### Refactor

5. Confirm the existing `runHook` tests still pass unchanged (the extraction is
   behaviour-preserving). Tidy doc comments per the design §4.

`npm run validate` → commit.

---

## Slice 2 — `commit`: `prepare-commit-msg` + `post-commit`

**Commit:** `feat(commit): fire prepare-commit-msg and post-commit hooks`

### Red

1. `test/unit/application/commands/internal/commit-hooks.test.ts` — rename the
   target to `applyCommitMessageHooks` and add:
   - Given a runner and `source: 'message'` → `prepare-commit-msg` fires with
     `[editmsgPath, 'message']` **before** `commit-msg` (assert `calls` order).
   - Given `source: 'merge'` → `prepare-commit-msg` arg is `[editmsgPath, 'merge']`.
   - **Given `noVerify: true` (with runner)** → `prepare-commit-msg` fires,
     `commit-msg` does **not**, and `COMMIT_EDITMSG` **is** written (the
     faithfulness arm — `--no-verify` does not gate prepare-commit-msg).
   - Given no runner → message unchanged, no `COMMIT_EDITMSG` written (status
     quo).
   - Existing arms (rewrite via the file, empty-message throw/allow, non-zero
     `commit-msg` throws) retargeted to the new name + a `prepare-commit-msg`
     that can also rewrite the file (assert order: prepare then commit-msg edits
     compose).
   Run → fails.

2. Extend `test/integration/posix-only/node-hooks-e2e.test.ts` (real process):
   - A `prepare-commit-msg` that rewrites `$1` → committed message reflects it.
   - A `post-commit` that writes a sentinel file → file exists after commit; a
     `post-commit` that `exit 1` → the commit still succeeds (informational).
   Run → fails.

### Green

3. `src/application/commands/internal/commit-hooks.ts`:
   - Add `export type PrepareCommitMsgSource = 'message' | 'merge';`
   - Replace `applyCommitMsgHook` with `applyCommitMessageHooks(ctx, message,
     { noVerify, allowEmptyMessage, source })`: when `ctx.hooks === undefined`
     return `message`; else write `COMMIT_EDITMSG`, `runHook('prepare-commit-msg',
     { args: [editMsgPath, source] })` (ungated), then if `!noVerify`
     `runHook('commit-msg', { args: [editMsgPath] })`, re-read + `sanitizeMessage`.
4. `src/application/commands/commit.ts`:
   - Compute `source: PrepareCommitMsgSource` = `'merge'` when
     `mergeHead || cherryPickHead || revertHead` is defined, else `'message'`
     (reuse the existing `usePendingDraft` boolean already passed to
     `resolveCommitMessage`).
   - Call `applyCommitMessageHooks(ctx, resolved, { noVerify, allowEmptyMessage, source })`.
   - After `clearResolvedState(ctx, markers)`, before `return`, add
     `await runInformationalHook(ctx, 'post-commit')`.
   Run → green.

### Refactor

5. Verify `commit.test.ts` / `commit-interop.test.ts` still pass; adjust any
   reference to the old `applyCommitMsgHook` name. Keep `commit.ts` ≤ helper
   sizes.

`npm run validate` → commit.

---

## Slice 3 — `merge`: `post-merge`

**Commit:** `feat(merge): fire post-merge hook on fast-forward and clean merge`

### Red

1. `test/unit/application/commands/merge.test.ts` — add:
   - Given a clean true-merge → `post-merge` fires once with `args: ['0']`.
   - Given a fast-forward → `post-merge` fires with `['0']`.
   - Given up-to-date → `post-merge` does **not** fire.
   - Given a conflict → `post-merge` does **not** fire.
   - Given a `post-merge` that exits non-zero on a clean merge → the merge result
     still returns (informational, no throw).
   (Use `createMemoryContext({ hooks: new MemoryHookRunner({...}) })`.)
   Run → fails.

### Green

2. `src/application/commands/merge.ts`:
   - Add `const SQUASH_FLAG_OFF = '0';` (named constant).
   - Extract the current `mergeRun` body (asserts + FF / true-merge / conflict
     dispatch) into `computeMerge(ctx, opts, internal)`; make `mergeRun` await it,
     then `if (result.kind === 'fast-forward' || result.kind === 'merge') await
     runInformationalHook(ctx, 'post-merge', { args: [SQUASH_FLAG_OFF] });` and
     return.
   Run → green.

### Refactor

3. Keep `computeMerge` cohesive; confirm `merge-interop` / `pull` suites green
   (pull inherits post-merge through `mergeRun`).

`npm run validate` → commit.

---

## Slice 4 — `checkout`: `post-checkout`

**Commit:** `feat(checkout): fire post-checkout hook on switch and path restore`

### Red

1. `test/unit/application/commands/checkout.test.ts` — add:
   - Given a branch switch → `post-checkout` fires `[oldOid, newOid, '1']`.
   - Given a detached switch → `post-checkout` fires `[oldOid, oid, '1']`.
   - Given a path restore (`paths`) → `post-checkout` fires `[head, head, '0']`.
   - Given a zero-glob-match path restore → does **not** fire (no-op).
   - Given a `post-checkout` that exits non-zero → the checkout result still
     returns (informational).
   Run → fails.

### Green

2. `src/application/commands/checkout.ts`:
   - Add `const BRANCH_FLAG = '1';` and `const FILE_FLAG = '0';`.
   - `switchBranch`: refactor the two early `return`s into a single tail —
     compute `detached`/`branchRef`, do the HEAD move, then
     `await runInformationalHook(ctx, 'post-checkout', { args: [oldOid, oid, BRANCH_FLAG] })`,
     then build + return the result (branch vs detached via the kept locals).
   - `pathRestore`: after the materialise dispatch and `head` resolve (the
     `pathSet.size > 0` path), `await runInformationalHook(ctx, 'post-checkout',
     { args: [head, head, FILE_FLAG] })` before returning. The zero-match early
     return is untouched.
   Run → green.

### Refactor

3. Confirm the single-return refactor keeps `switchBranch` branch coverage; run
   `checkout` unit + any reset/sparse suites that share the materialise path.

`npm run validate` → commit.

---

## Slice 5 — `rebase`: `pre-rebase` + `post-rewrite`

**Commit:** `feat(rebase): fire pre-rebase and post-rewrite hooks`

### Red

1. `test/unit/application/commands/rebase.test.ts` — add:
   - Given a `pre-rebase` that exits non-zero → `rebaseRun` throws `HOOK_FAILED`
     and **no ref moved** (HEAD/branch unchanged, no `ORIG_HEAD`).
   - Given a `pre-rebase` that exits 0 → rebase proceeds; `calls` shows
     `pre-rebase` with `args: [upstream]`.
   - Given a finished plain rebase → `post-rewrite` fires `args: ['rebase']` with
     stdin = the `<old> <new>\n` lines for each replayed commit.
   - Given a finished interactive rebase → `post-rewrite` fires likewise.
   - Given an up-to-date rebase (`onto === base`) → `post-rewrite` does **not**
     fire (no rewrites).
   - Given `continue`/`skip`/`abort` → `pre-rebase` does **not** re-fire.
   Run → fails.

### Green

2. `src/application/commands/internal/rebase-state.ts` — export
   `serializeRewritten` (it already produces the exact `<old> SP <new> LF` lines
   git feeds `post-rewrite` on stdin, identical to the `rewritten-list` file).
3. `src/application/commands/rebase.ts`:
   - In `rebaseRun`, after `assertCleanWorkTree` and before `mergeBase`, add
     `await runHook(ctx, 'pre-rebase', { args: [input.upstream] })` (blocking).
   - Add a module helper
     `firePostRewrite(ctx, rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>)`:
     `if (rewritten.length > 0) await runInformationalHook(ctx, 'post-rewrite',
     { args: [REBASE_REWRITE_LABEL], stdin: serializeRewritten(rewritten) });`
     with `const REBASE_REWRITE_LABEL = 'rebase';`.
   - Call `firePostRewrite(ctx, rewritten)` at both finish sites — in `replayFrom`
     and `replayInteractive` — between `finishRebase(...)` and
     `clearRebaseState(...)`.
   Run → green.

### Refactor

4. Confirm the `pre-rebase` placement is before both the interactive branch and
   the up-to-date short-circuit; run `rebase` unit suite. (Exact ordering vs
   clean-worktree / up-to-date is pinned by interop in slice 6.)

`npm run validate` → commit.

---

## Slice 6 — Cross-tool parity (interop)

**Commit:** `test(hooks): cross-tool parity for the new lifecycle hooks`

Author each hook as a real POSIX script that records its `$@` / stdin to a file
under the repo, run the same scenario under canonical `git` (`runGit`, scrubbed
`GIT_*`) and tsgit (`openRepository`, Node shim), and assert identical records /
fire-or-skip decisions. New `test/integration/hooks-coverage-interop.test.ts`
(`GIT_AVAILABLE`-guarded, mirroring the existing interop suites):

1. **`post-merge`** — a recorder hook; assert identical `$1` (`0`) after FF and
   after a clean true-merge, and a missing record after up-to-date / conflict.
2. **`post-checkout`** — recorder hook; identical `$1 $2 $3` after a branch
   switch (flag `1`) and a path restore (flag `0`, old == new).
3. **`pre-rebase`** — an `exit 1` script: both `git rebase` and tsgit abort with
   no ref movement (compare HEAD before/after); an `exit 0` script lets both
   proceed identically. Pins the dirty / up-to-date ordering against real git.
4. **`post-rewrite`** — recorder hook capturing stdin; identical `<old> <new>`
   line set after a rebase (compare as a set; oid pairs deterministic under
   fixed identities/timestamps via `runGitEnv` author/committer dates).
5. **`prepare-commit-msg`** — a script that rewrites `$1`; the committed message
   + reflog subject reflect the rewrite identically under both tools; a
   `prepare-commit-msg` + `commit-msg` pair composes in order.

Use `makePeerPair` / `initBothRepos`-style scaffolding; install hooks into each
repo's `.git/hooks` with the exec bit (`chmod 0o755`). tsgit hooks fire through
the Node shim (`openRepository`), git's through `runGit`.

`npm run validate` → commit.

---

## Slice 7 — `api.json` + docs

**Commit:** `docs(hooks): regenerate api.json + refresh hook coverage docs`

1. Regenerate `reports/api.json` (`npm run check:doc-typedoc` / the documented
   regen path) — the `HookName` union widening produces a large but mechanical
   typedoc-id diff; commit it (prepush gate requires it).
2. Refresh the hook list in `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`, and the
   relevant `docs/use/` page (the three-hook list → the full eight; note the
   blocking vs informational split, `--no-verify` scope, and the server-side /
   clone omissions).
3. Flip `docs/BACKLOG.md` **24.8** `[ ]` → `[x]` with a one-line summary +
   ADR/design refs (done in the docs commit, or its own
   `docs(backlog)` commit).

`npm run validate` → commit.

---

## Validation gate (every commit)

`npm run validate` green — Biome (read "Found N errors" + exit code), strict
type-check, full unit + integration suite, 100% coverage on touched
domain/adapter files. Mutation (slice-level, after the reviews + architecture
pass) targets 0 killable survivors on every touched `src` file:
`./node_modules/.bin/stryker run --mutate <file>`.
