# Phase 12.4 — Implementation plan

Derived from `docs/design/phase-12-4-clone-bench.md` + ADR-017. The
sequence is structured so the refactor lands first (regression-tested
by the integration suite that already exists), then the bench wires
into the now-shared helper.

## Step order

### 1. Extract CGI helper (pure refactor, regression net = integration test)

1. Create `test/bench/support/http-backend-server.ts` exporting:
   - `findGitHttpBackend(): string | undefined`
   - `startGitHttpBackend(opts): Promise<{ port, close }>`
2. Move the existing CGI block out of
   `test/integration/network/clone-http-backend.test.ts` and into the
   helper verbatim. Only the public surface changes; the request
   handler logic is byte-identical.
3. In `clone-http-backend.test.ts`, replace the inline block with an
   import from the helper. Keep the Stryker / fixture skip flags
   inline because they are test-specific (the bench has different
   skip text).
4. **Verify:** `npm run test:integration -- test/integration/network/clone-http-backend.test.ts`
   exits 0. This is the safety net for the refactor — if the integration
   test still passes against the extracted helper, the helper preserves
   the previous semantics.

Commit: `refactor(test): extract git-http-backend CGI helper`.

### 2. Add the bench file

1. Create `test/bench/clone-small-repo.bench.ts`. Skeleton:
   - `describe.skipIf(SKIP)('clone:small-repo', async () => { … })`
   - Top of describe body: `if (SKIP) return;` (vitest evaluates the
     callback to enumerate tests even when skipped — without the guard
     the server would boot on every skipped run) then
     `await startGitHttpBackend(...)` to boot the shared server.
   - `afterAll` collects tmpdirs and rm's via `Promise.all`.
   - Two `bench()` calls: `'tsgit'` and `'isomorphic-git'`, each doing
     a fresh-tmpdir clone against `http://127.0.0.1:${port}/source.git`.
   - tsgit path: `openRepository → repo.clone → repo.dispose` inside
     the timed region.
   - isomorphic-git path: `git.clone({ fs, http, dir, url, singleBranch: true })`.
2. **Verify:** `npm run test:bench` produces a `raw.json` with a
   `clone:small-repo` group containing both `tsgit` and `isomorphic-git`
   entries, no errors.

Commit: `feat(bench): clone:small-repo scenario vs isomorphic-git`.

### 3. Regenerate the summary

1. Run `npm run bench:summary`. The script enumerates groups from
   `raw.json` and writes `reports/benchmarks/summary.md` with the new
   `clone:small-repo` row added below the existing ones.
2. **Verify:** Open `summary.md`, confirm the new row exists with both
   library numbers and a speedup column.

Commit (squashed with step 2 or separate): `chore(bench): regenerate summary with clone:small-repo`.

### 4. Tick BACKLOG inside this PR

1. Flip `docs/BACKLOG.md` §12.4 `[ ]` → `[x]` (per CLAUDE.md rule:
   tick lives in the PR's own commits, not as a follow-up).
2. Update the README phase table row for 12.4 to ✅.

Commit: `docs(backlog): tick §12.4 — clone bench scenario`.

## TDD note

A bench file is not a unit test, so the red/green cycle is:

- **Red:** `npm run test:bench` after step 1 (helper extracted) shows
  no `clone:small-repo` group in `raw.json` — the bench does not exist
  yet.
- **Green:** `npm run test:bench` after step 2 shows the group with
  both entries. No assertion fires, but the bench command exits 0 and
  the JSON gains the expected shape.

The regression net for the extracted helper is the integration test,
which `test:integration` already runs as part of `validate`. If the
helper breaks the integration test, the harness goes red.

## Risk gates

| Step | Likely failure mode | Mitigation |
|---|---|---|
| 1 | Import path mismatch (helper file resolution) | Run integration test before touching anything else |
| 1 | Stryker sandbox flag now lives in the helper or the test? | Keep it in the test — different skip text per scenario |
| 2 | `isomorphic-git/http/node` import path stale | The package exports this entry point; verify via `node -e "require('isomorphic-git/http/node')"` if unsure |
| 2 | Per-iter tmpdir not cleaned on crash | `afterAll` rms the whole array — bounded leak of one tmpdir per failed iteration |
| 3 | summary.md regeneration adds nothing | Verify `raw.json` first; the script reads the file blindly |
| 4 | BACKLOG ticked but README phase table missed | Both files are in the same commit; greppable in PR |

## Self-review log

### Pass 1 → Pass 2 diffs

- Originally proposed writing the bench file first then refactoring.
  Re-ordered: extraction first so the integration test acts as the
  regression net before the bench depends on the helper. If extraction
  breaks integration, we catch it without a half-written bench file in
  the way.

### Pass 2 → Pass 3 diffs

- Added the `node -e "require('isomorphic-git/http/node')"` smoke check
  as a low-cost early signal in the risk-gates table.
- Split summary regeneration into its own step. Originally folded into
  step 2; separating clarifies that summary regeneration is a follow-on
  artifact, not part of bench file logic.
