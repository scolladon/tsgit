# Plan: Phase 12.2 — Fetch (TDD step sequence)

Backlog entry: [§12.2](../BACKLOG.md). Design: [`phase-12-2-fetch.md`](../design/phase-12-2-fetch.md).
ADRs: [009](../adr/009-fetch-shallow-where.md), [010](../adr/010-fetch-haves-strategy.md),
[011](../adr/011-fetch-ref-update-tx.md), [012](../adr/012-fetch-prune-semantics.md).

### Plan-review notes (×3)

Three self-review passes were applied; each pass tightened the sequence.

**Pass 1 — dependency ordering:**
`parseShallowResponse` must land before `fetchPack`'s shallow extension;
`shallow-file` must land before `fetch.ts`'s real body; `walk-commits.ts`
shallow extension must land before the shallow integration test. The
sequence below respects these arrows. `commands/internal/upload-pack-client.ts`
helper extraction is mechanical and lands first so subsequent commits
don't keep adding duplicate code paths.

**Pass 2 — atomic-commit cohesion:**
Each commit must compile + pass the test suite. The fixture-regeneration
step (commit 2) re-runs the existing clone integration test against a
5-commit fixture; we keep the test inputs deterministic so this commit
doesn't accidentally invalidate the Phase 12.1 acceptance.

**Pass 3 — test coverage progression:**
Every implementation step is preceded by the failing-test step. No
implementation lands without a Red→Green pair. The mutation-resistance
patterns from CLAUDE.md (isolated guard tests, specific error data
assertions, boundary pinning) are wired into each test-only step.

---

## Files modified or created

### Created

```
docs/adr/009-fetch-shallow-where.md           (done — commit 2)
docs/adr/010-fetch-haves-strategy.md          (done — commit 2)
docs/adr/011-fetch-ref-update-tx.md           (done — commit 2)
docs/adr/012-fetch-prune-semantics.md         (done — commit 2)
docs/design/phase-12-2-fetch.md               (done — commit 1)
docs/plan/phase-12-2-fetch.md                 (this file)
src/application/primitives/shallow-file.ts
src/application/commands/internal/upload-pack-client.ts
test/unit/application/primitives/shallow-file.test.ts
test/integration/network/fetch-http-backend.test.ts
test/integration/network/fetch-shallow-http-backend.test.ts
test/fixtures/clone-source/HEAD-history.txt   (emitted by the regen script)
```

### Modified

```
scripts/regenerate-clone-fixtures.sh          # 5-commit chain
test/fixtures/clone-source/source.git/        # regenerated; HEAD-oid.txt updated
src/domain/protocol/upload-pack.ts            # parseShallowResponse + expectShallow
src/domain/protocol/index.ts                  # re-export parseShallowResponse
src/application/primitives/fetch-pack.ts      # depth, shallow result
src/application/primitives/walk-commits.ts    # shallow set option
src/application/primitives/types.ts           # MAX_HAVES, WalkCommitsOptions.shallow
src/application/primitives/index.ts           # re-export updateShallow, readShallow
src/application/commands/fetch.ts             # real body
src/application/commands/clone.ts             # depth re-enabled
test/unit/domain/protocol/upload-pack.test.ts # parseShallowResponse cases
test/unit/application/primitives/fetch-pack.test.ts  # depth cases
test/unit/application/primitives/walk-commits.test.ts # shallow cases
test/unit/application/commands/fetch.test.ts  # rewritten
test/unit/application/commands/clone.test.ts  # depth happy-path replaces the throw test
test/integration/network/clone-http-backend.test.ts  # 5-commit fixture compatibility
docs/BACKLOG.md                               # tick §12.2 (final commit)
README.md, RUNBOOK.md, MIGRATION.md, DESIGN.md # docs refresh (final commit)
```

---

## TDD sequence

### Commit 1 — design (already landed)

`docs/design/phase-12-2-fetch.md` (committed).

### Commit 2 — ADRs 009–012 (already landed)

`docs/adr/009-012` (committed).

### Commit 3 — plan (this file)

`docs/plan/phase-12-2-fetch.md`.

### Commit 4 — fixture regeneration (5-commit chain)

**Step 4a — Red:** extend the existing `clone-http-backend` integration test
to assert that `walkCommits` from the cloned HEAD yields exactly the
recorded number of commits from `HEAD-history.txt`. Test fails because
the fixture still has 1 commit.

**Step 4b — Green:** extend `scripts/regenerate-clone-fixtures.sh` to emit
a 5-commit chain, write per-commit oids to `HEAD-history.txt`. Run the
script; commit the regenerated `source.git`, the updated `HEAD-oid.txt`,
and the new `HEAD-history.txt`.

Commit message: `test(fixture): grow clone-source to 5 commits`.

### Commit 5 — `parseShallowResponse` + `expectShallow` flag

**Step 5a — Red:** add `test/unit/domain/protocol/upload-pack.test.ts`
cases:
- No shallow line + flush → empty arrays, iterator past flush.
- One shallow + flush → one oid in `shallow`, iterator past flush.
- One shallow + one unshallow + flush → both arrays populated.
- Malformed oid (`shallow xyz\n`) → throws `INVALID_REF_LINE`.
- Unknown verb (`shallowish ...`) → first-line is non-shallow data line;
  parser returns empty arrays and `splitMeta` sees the line.
- Flush immediately → empty arrays, iterator past flush.

**Step 5b — Green:** implement `parseShallowResponse` in
`src/domain/protocol/upload-pack.ts`. Add the `expectShallow?: boolean`
flag to `parseUploadPackResponse`. When true, call `parseShallowResponse`
before `splitMeta`. Re-export `parseShallowResponse` from
`src/domain/protocol/index.ts`.

Commit message: `feat(protocol): parseShallowResponse + expectShallow flag`.

### Commit 6 — `shallow-file` primitive

**Step 6a — Red:** add `test/unit/application/primitives/shallow-file.test.ts`:
- `readShallow` on missing file → empty Set.
- `readShallow` with two oids → Set of size 2.
- `readShallow` with trailing newline only → empty Set.
- `updateShallow` adds new oids → file written with sorted lines.
- `updateShallow` removes via unshallow → existing oid removed.
- `updateShallow` removes all → file deleted.
- Lock-rename: simulate concurrent lock by pre-creating `.lock`,
  assert `RESOURCE_LOCKED` or similar.
- Round-trip: write, read, equal.

**Step 6b — Green:** implement `src/application/primitives/shallow-file.ts`.
Re-export `readShallow` and `updateShallow` from
`src/application/primitives/index.ts`.

Commit message: `feat(primitives): shallow-file read/write`.

### Commit 7 — `walkCommits` shallow option

**Step 7a — Red:** add to `test/unit/application/primitives/walk-commits.test.ts`:
- `shallow` undefined → identical to existing behavior (regression).
- `shallow = {B}` where B's parent is A → walker yields B but not A.
- `shallow = {B}` with A's object missing → walker yields B without
  raising `OBJECT_NOT_FOUND` (the parent walk never fires).
- Two shallow seeds, distinct boundaries → both seeds yielded; neither
  parent walked.

**Step 7b — Green:** add `shallow?: ReadonlySet<ObjectId>` to
`WalkCommitsOptions` (`src/application/primitives/types.ts`). In
`enqueueParents`, short-circuit when `commit.id` is in `state.shallow`.
Wire `state.shallow` from `options.shallow ?? new Set()`.

Commit message: `feat(primitives): walkCommits shallow boundary option`.

### Commit 8 — `fetchPack` shallow extension

**Step 8a — Red:** add to `test/unit/application/primitives/fetch-pack.test.ts`:
- `depth` set, server response includes shallow block → result's `shallow`
  / `unshallow` arrays match the server's lines; pack still validates.
- `depth` set, server omits the shallow block (immediate flush) →
  `shallow` and `unshallow` are empty.
- `depth` set with bogus shallow oid → `INVALID_REF_LINE` propagates.
- `depth` unset → request body has no `deepen`; result's `shallow` /
  `unshallow` are empty arrays. Regression guard.

**Step 8b — Green:** extend `src/application/primitives/fetch-pack.ts`:
- Accept `depth?: number` in `FetchPackInput`.
- Pass `depth` through `buildUploadPackRequest`.
- Pass `expectShallow: depth !== undefined` to `parseUploadPackResponse`.
- Pull `shallow` / `unshallow` from the response and surface them in
  `FetchPackResult`.

Commit message: `feat(primitives): fetchPack accepts depth + surfaces shallow`.

### Commit 9 — `upload-pack-client` internal helper extraction

**Step 9a — Refactor (test-stable):** extract `discoverRefs`,
`selectCapabilities`, `uniqueOids`, and `readableStreamToAsyncIterable`
from `clone.ts` into
`src/application/commands/internal/upload-pack-client.ts`. Update
`clone.ts` to import from the new module. All clone tests stay green.

Commit message: `refactor(commands): extract upload-pack client helpers`.

### Commit 10 — `fetch.ts` real body (non-shallow first)

**Step 10a — Red:** rewrite `test/unit/application/commands/fetch.test.ts`:
- Existing `REMOTE_NOT_CONFIGURED` test stays.
- Existing "resolved url" test stays but asserts on the new
  `result.updatedRefs` shape (single entry for the advertised main branch).
- Happy fetch: fake transport, assert pack written + ref updated.
- Empty advertisement → `REMOTE_ADVERTISES_NO_REFS`.
- `haves` derivation: fake transport echoes the request body; assert
  request contains `have <id>` for every commit reachable from
  `refs/remotes/origin/*` at fetch time.
- Local refs untouched: `refs/heads/main` and `refs/tags/v0` preserved
  after fetch.
- `fetch:write-objects` progress: at least one start/update/end triple.

**Step 10b — Green:** implement the non-shallow body in
`src/application/commands/fetch.ts` per design §3.5. Use
`upload-pack-client` helpers from commit 9. Use `deriveHaves` private
helper bounded by `MAX_HAVES`.

Add `MAX_HAVES = 256` to `src/application/primitives/types.ts`.

Commit message: `feat(commands): fetch — real pack-driven body`.

### Commit 11 — `fetch.ts` prune support

**Step 11a — Red:**
- `prune: true` with stale `refs/remotes/origin/feature-x` and server
  advertising only `main` → `result.prunedRefs` contains the stale ref;
  on-disk ref removed.
- `prune: false` (or unset) with same setup → stale ref preserved.
- Local branches and tags NEVER deleted (assert `refs/heads/feature-x`
  and `refs/tags/v0` are still on disk after a prune fetch).

**Step 11b — Green:** add the `prune` private helper to `fetch.ts`.
Wire `opts.prune === true` to call it post-`applyRemoteRefs`.

Commit message: `feat(commands): fetch — prune semantics`.

### Commit 12 — `fetch.ts` shallow support

**Step 12a — Red:**
- `depth: 1` against a server returning a shallow block →
  `result.shallow` has one oid, `.git/shallow` contains the same oid.
- `depth: 1` against a server that ignores the deepen (no shallow block)
  → `result.shallow` is empty, `.git/shallow` is NOT created.
- `result.unshallow` populated when the server returns unshallow lines
  (e.g., a previously-shallow commit is now reachable past the new depth).

**Step 12b — Green:** thread `opts.depth` through `fetch.ts` into the
`fetchPack` call. Call `updateShallow` from `application/primitives/`
when the result carries shallow or unshallow oids.

Commit message: `feat(commands): fetch — depth + shallow updates`.

### Commit 13 — `clone.ts` depth re-enabled

**Step 13a — Red:** replace the existing clone test that asserts
`UNSUPPORTED_OPERATION` for `depth` with:
- `depth: 1` happy path — server advertises 5 commits + sends a shallow
  block; assert clone succeeds and `.git/shallow` contains the shallow
  oid.

**Step 13b — Green:** remove the `unsupportedOperation('clone-shallow', ...)`
guard in `clone.ts`. Pass `opts.depth` through to `fetchPack`. Call
`updateShallow` when the result carries shallow oids.

Commit message: `feat(commands): clone — re-enable depth (delegates to fetchPack)`.

### Commit 14 — `fetch` integration test (non-shallow)

**Step 14a — Red:** add
`test/integration/network/fetch-http-backend.test.ts`. Spins
`git-http-backend` against the 5-commit fixture. Clones first, then
appends a commit server-side (via a writable working copy in a temp
dir), then runs `fetch`. Asserts the new commit appears in
`refs/remotes/origin/main` and `walkCommits` yields 6 commits.

**Step 14b — Green:** if the test passes immediately after commits 10–11,
no implementation changes are needed. Otherwise, fix the integration
glue (likely test-only) until green.

Commit message: `test(integration): fetch happy path against git-http-backend`.

### Commit 15 — shallow integration test

**Step 15a — Red:** add
`test/integration/network/fetch-shallow-http-backend.test.ts`. Calls
`clone({ url, depth: 1 })`. Asserts `.git/shallow` exists and contains
the HEAD oid. Walks from HEAD and asserts exactly one commit is yielded
with no `OBJECT_NOT_FOUND`.

**Step 15b — Green:** if the test passes immediately after commits 12–13,
no implementation changes are needed. Otherwise, fix.

Commit message: `test(integration): clone depth:1 leaves valid .git/shallow`.

### Commit 16 — three review passes + harness green + Stryker

**Step 16a — Reviews:** run typescript-reviewer, security-reviewer,
test-review, code-reviewer in parallel via the Agent tool. Three passes,
fix every finding each pass.

**Step 16b — Harness:** `npm run validate` until every check passes.

**Step 16c — Stryker:** `stryker run` — kill every killable mutant.
Provably-equivalent mutants documented inline with
`// equivalent-mutant: <why>` comments.

Commit message: `chore: review pass fixes + mutation kills`.

### Commit 17 — docs refresh + BACKLOG tick

Update `README.md`, `RUNBOOK.md`, `MIGRATION.md`, `DESIGN.md` to mention
the now-functional `fetch` command and the `depth` clone option. Tick
`docs/BACKLOG.md` §12.2 as `[x]` inside this commit (workflow step 8 of
CLAUDE.md).

Commit message: `docs(backlog): close §12.2 — fetch + shallow shipped`.

Then push the branch and open the PR with the standard test plan.

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Shallow protocol divergence between git server versions (e.g., very old `git-http-backend` versions don't emit a flush after empty shallow block) | The parser already handles "first non-shallow data line" as the buffered peek — if a buggy server skips the flush, `splitMeta` still sees the ACK line correctly. The integration test runs against the CI runner's installed git, which is modern. |
| `MAX_HAVES = 256` rejects fetch on a very-long-history repo | Acceptable per ADR-010 — bandwidth penalty, not correctness. Documented in `RUNBOOK.md`. |
| `.git/shallow` lock contention if user runs two concurrent fetches | The lock-rename pattern surfaces `RESOURCE_LOCKED`. Documented in `RUNBOOK.md`. |
| Fixture regeneration script breaks Phase 12.1 clone test | Commit 4 lands the regenerated fixture; commit 4a's Red test was written to use `HEAD-history.txt.length` so the existing Phase 12.1 assertion (that the HEAD oid round-trips) still passes against the 5-commit fixture. |
| jscpd flags `discoverRefs` / helpers as duplicated between `clone.ts` and `fetch.ts` | Commit 9 extracts them to `commands/internal/upload-pack-client.ts` before the fetch implementation lands. |
