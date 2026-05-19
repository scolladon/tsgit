# Plan — Phase 14.5 — §14.4 follow-up bundle

Design: `docs/design/phase-14-5-followups.md`.
ADRs: 049 (bundle vs split), 050 (cache invalidation), 051 (symlink
target containment), 052 (DIRECTORY_NOT_EMPTY).

Branch: `feat/phase-14-5` (worktree at `../tsgit-phase-14-5`).

Atomic conventional-commit per step. `npm run validate` green before
committing. TDD per slice (RED → GREEN → REFACTOR). Slice ordering
follows design §6.

---

## Step 0 — Worktree + design + ADRs ✓

Already committed: `docs(design): phase-14-5 follow-up bundle + ADRs 049-052`.

---

## Phase A — Refactors

Order picked so the perf work that follows lands on already-cleaned
code paths.

### Step 1 — 14.5.5: Drop `this.lstat(real)` in `rmRecursive`

**Files:**

- `src/adapters/node/node-file-system.ts` — `rmRecursive` body replace
  `await this.lstat(real)` with `await runFs(() => this.fsOps.lstat(real), path)`.
- `test/unit/adapters/node/node-file-system.test.ts` or
  `node-file-system-injected.test.ts` — assert containment is NOT
  re-entered for the rmRecursive existence probe (single call
  through `fsOps.realpath` for the rootDir + `fsOps.lstat` for the
  leaf; no second `realpath(rootDir)` in the lstat path).

**Test first:**
- Given a vanilla file in-tree, When `rmRecursive` runs, Then
  `fsOps.realpath` is called exactly **N times for the rootDir** where
  N is the pre-existing count (one for getCanonicalRoot, plus
  whatever resolveForMode does — no extras from this.lstat).

**Commit:** `refactor(node-fs): drop double containment in rmRecursive (§14.5.5)`

### Step 2 — 14.5.6: Pre-realpath check in `lstat` mode

**Files:**

- `src/adapters/node/node-file-system.ts` — `resolveForMode`'s `lstat`
  branch gains `check(resolved)` before the `realpath(dirname(…))`
  call. Mirror the `read` arm's structure.
- `test/unit/adapters/node/node-file-system-injected.test.ts` — new
  test: `lstat` against an obviously out-of-tree path produces
  PERMISSION_DENIED without any `realpath` call to the leaf parent
  (i.e., the pre-check fires).

**Test first:**
- Given lstat called with an out-of-tree path, When the check runs,
  Then PERMISSION_DENIED is thrown AND `fsOps.realpath` was called
  only for the rootDir canonicalisation (zero calls for the leaf
  parent).

**Commit:** `refactor(node-fs): pre-realpath containment for lstat mode (§14.5.6)`

### Step 3 — 14.5.7: Narrow `makePolicy` parameter

**Files:**

- `src/adapters/node/path-policy.ts` — introduce `PathPolicySource`
  interface; `makePolicy(impl: PathPolicySource, …)`.
- `test/unit/adapters/node/path-policy.test.ts` — no behavioural
  change; existing tests still pass. Optionally add a type-only
  check that a `Pick<typeof nodePath.posix, 'sep' | …>` is also
  assignable.

**Commit:** `refactor(path-policy): narrow makePolicy parameter to PathPolicySource (§14.5.7)`

### Step 4 — 14.5.8: Push `nativePolicy` default out of `find-layout.ts`

**Files:**

- `src/repository/find-layout.ts` — drop `policy = nativePolicy`
  default; `policy: PathPolicy` becomes required.
- `src/repository/find-layout.ts` import line — remove
  `import { nativePolicy } from '../adapters/node/path-policy.js'`.
- `src/repository.ts` (or wherever `findLayout` is called) — pass an
  explicit policy from the adapter the caller already constructed.
- `test/unit/repository/find-layout.test.ts` — every call already
  passes `posixPolicy`; no change needed.

**Risk:** the public `openRepository(rootDir, options?)` shape stays
the same. Only internal callers change.

**Commit:** `refactor(find-layout): require explicit PathPolicy (§14.5.8)`

---

## Phase B — Errno cleanup

### Step 5 — 14.5.10: First-class `EISDIR → permissionDenied`

**Files:**

- `src/adapters/node/node-file-system.ts` — `mapErrno` gains an
  explicit EISDIR arm.
- `test/integration/posix-only/node-fs-locked-directory.test.ts` —
  the existing test asserts `UNSUPPORTED_OPERATION` (correct under
  old code). After this slice, it asserts `PERMISSION_DENIED`. The
  behavioural change drives the assertion update; both edits go in
  the same commit.
- `test/unit/adapters/node/node-file-system-injected.test.ts` — add
  a cross-platform DI test for EISDIR → PERMISSION_DENIED via
  `mapErrno` (or directly against `mapErrno` if exported).

**Test first (RED):**
- New unit test on `mapErrno(EISDIR, path)` → expects
  `PERMISSION_DENIED`. Fails on current main.

**Green:** add the case.

**Sweep:** update the locked-directory integration test assertion.

**Commit:** `fix(node-fs): map EISDIR to permissionDenied (§14.5.10)`

### Step 6 — 14.5.11: Drop `isSymlinkLeaf` parameter from discriminator

**Files:**

- `src/adapters/node/node-file-system.ts` —
  `isWindowsSymlinkRefusal(err, policy)` (drop the second arg).
  Update the single call site (`(err, this.pathPolicy)`).
- `test/unit/adapters/node/node-file-system.test.ts` — every existing
  call to `isWindowsSymlinkRefusal` updates from three args to two.

**Commit:** `refactor(node-fs): drop unused isSymlinkLeaf parameter (§14.5.11)`

### Step 7 — 14.5.12: New `DIRECTORY_NOT_EMPTY` error code

**Files:**

- `src/domain/error.ts` — new `ErrorData` member
  `{ code: 'DIRECTORY_NOT_EMPTY'; path: string }`. New constructor
  `directoryNotEmpty(path)`.
- `src/adapters/node/node-file-system.ts` — `mapErrno` splits the
  `ENOTDIR`/`ENOTEMPTY` arms.
- `src/adapters/memory/memory-file-system.ts` — `rmdir` / equivalent
  throws `directoryNotEmpty` for non-empty directories.
- Any exhaustive `switch` in commands / primitives that the TS
  checker flags.
- Tests in `test/unit/domain/error.test.ts` — formatter coverage.
- Tests in `test/unit/adapters/node/node-file-system.test.ts` — the
  ENOTEMPTY mapping test (if it exists) updates to assert
  DIRECTORY_NOT_EMPTY.

**Test first:**
- Given `mapErrno(ENOTEMPTY, path)`, When called, Then returns
  `directoryNotEmpty(path)`.

**Risk:** TS checker may flag previously-exhaustive switches. Add
cases as needed; do not introduce `default` fallthroughs unless the
existing code already had one.

**Commit:** `feat(domain): DIRECTORY_NOT_EMPTY error code, split from NOT_A_DIRECTORY (§14.5.12)`

---

## Phase C — Perf

### Step 8 — 14.5.3: Skip `policy.resolve()` on inputs without relative segments

**Files:**

- `src/adapters/node/node-file-system.ts` — `checkContainment` gains
  the `hasRelativeSeg` gate per design §2.3.
- `test/unit/adapters/node/node-file-system.test.ts` (or injected) —
  tests for both arms (relative-seg present → resolve fires;
  absent → resolve skipped). Spy on `policy.resolve` is awkward
  because policy is a value; instead, use a `vi.fn`-bearing custom
  policy.

**Test first:**
- Given an absolute path with no relative segments, When
  `checkContainment` runs, Then `policy.resolve` is NOT called (but
  the operation still succeeds).
- Given an absolute path containing `..`, When `checkContainment`
  runs, Then `policy.resolve` IS called (the `..` is normalised
  before the prefix check).

**Commit:** `perf(node-fs): skip resolve when path lacks relative segments (§14.5.3)`

### Step 9 — 14.5.1: Normalised-root cache fields

**Files:**

- `src/adapters/node/node-file-system.ts` —
  `private normalizedRootDirCache: string | undefined` and
  `private normalizedCanonicalRootCache: string | undefined`. Populate
  lazily inside `checkContainment` / `exists` / wherever
  `pathContains(rootDir, …)` / `pathContains(canonicalRoot, …)`
  fires. The `pathContains` helper itself can stay pure — the
  caller normalises once.
- Alternative: a `normalizedPathContains(normalizedParent, child, policy)`
  helper that takes the pre-normalised parent.
- Tests — assert that `policy.normalizeForCompare` is called at most
  TWICE for the rootDir across N containment calls (once for raw
  root, once for canonical root, then reused).

**Test first:**
- Given a custom policy whose `normalizeForCompare` is a `vi.fn`,
  When 10 `exists` calls fire against `NodeFileSystem`, Then
  `normalizeForCompare` is called at most 2 + 10 times (2 root
  caches + 10 child normalisations).

**Commit:** `perf(node-fs): cache normalised rootDir + canonicalRoot (§14.5.1)`

### Step 10 — 14.5.4: Parent-directory realpath LRU

**Files:**

- `src/adapters/node/node-file-system.ts` —
  `private creationParentCache: LruCache<string, string>`. New
  private method `realpathParentIfExists(parent)`. `resolveForCreation`
  consults the LRU before falling back to
  `realpathNearestExisting`. `invalidateCreationCacheUnder(prefix)`
  called from `rmRecursive` and `rename`.
- `src/domain/storage/lru-cache.ts` — re-used; no changes.
- Tests — hit path, miss path, invalidation on rmRecursive,
  invalidation on rename, no-cache-on-ENOENT path.

**Test first:**
- Given two successive writes to `/root/sub/a.bin` and
  `/root/sub/b.bin`, When both complete, Then `fsOps.realpath`
  was called for `/root/sub` exactly **once** (cached on the
  second write).
- Given a write followed by an `rmRecursive('/root/sub')`, When a
  subsequent write to `/root/sub/c.bin` runs, Then
  `fsOps.realpath('/root/sub')` is called again (cache
  invalidated).

**Commit:** `perf(node-fs): LRU cache for resolveForCreation parent realpath (§14.5.4)`

### Step 11 — 14.5.2: Bounded-concurrency `removeTree`

**Files:**

- `src/adapters/node/node-file-system.ts` — introduce
  `mapConcurrent` (private helper, ~12 LOC per design §2.2). Replace
  `for…of` in `removeTree` with `mapConcurrent(entries, 8, fn)`.
- Tests — existing `rmRecursive` tests stay green. New injected
  test for `mapConcurrent`'s concurrency cap using a controllable
  `fsOps.rm` that holds promises open until released.

**Test first (RED):**
- New `mapConcurrent`-focused test: given 16 items + limit 8 + a
  `vi.fn` whose promises are held by a `deferred` helper, When 8
  promises have been called and none have resolved, Then no
  9th call has fired. Resolve one; assert the 9th now fires.
- Plus a simpler test: given 16 entries under a directory + `fsOps`
  whose `rm` resolves immediately, When `rmRecursive` runs, Then
  `fsOps.rm` is called 16 times AND completes faster than 16 ×
  serial cost (loose timing — not flaky-prone because we use
  `Promise.resolve()` for the underlying op).

**Commit:** `perf(node-fs): parallel removeTree children (§14.5.2)`

---

## Phase D — Security / Windows polish

### Step 12 — 14.5.9: Validate absolute symlink targets

**Files:**

- `src/adapters/node/node-file-system.ts` — `symlink` body gains the
  absolute-target containment check per design §2.9 / ADR-051.
- `test/unit/adapters/node/node-file-system-injected.test.ts` — new
  tests: absolute target outside rootDir → PERMISSION_DENIED;
  absolute target inside rootDir → success; relative target with
  `..` → success (relatives are not validated at create time);
  absolute with `..` that resolves outside → PERMISSION_DENIED
  (resolve before pathContains).

**Test first:**
- Given an absolute target outside rootDir, When symlink runs, Then
  PERMISSION_DENIED is thrown AND `fsOps.symlink` is NOT called.
- Given an absolute target with `..` segments that resolve outside,
  When symlink runs, Then PERMISSION_DENIED is thrown.
- Given a relative target, When symlink runs, Then `fsOps.symlink`
  is called regardless of target content.

**Commit:** `fix(node-fs): reject absolute symlink targets outside rootDir (§14.5.9)`

### Step 13 — 14.5.13: Strip `\\?\` extended-length prefix in Windows `normalizeForCompare`

**Files:**

- `src/adapters/node/path-policy.ts` — `windowsPolicy`'s
  `normalizeForCompare` strips `\\?\` and `\\?\UNC\` prefixes.
- `test/unit/adapters/node/path-policy.test.ts` — new tests.

**Test first:**
- Given `\\?\C:\Users\Foo`, When `normalizeForCompare` runs, Then
  returns `c:\users\foo` (prefix stripped, lowercased).
- Given `\\?\UNC\server\share\file`, When `normalizeForCompare`
  runs, Then returns `\\server\share\file` (UNC normalised).
- Given a plain POSIX path, When `normalizeForCompare` runs, Then
  returns the path unchanged (the strip is Windows-only).

**Commit:** `fix(path-policy): strip Windows \\?\ extended-length prefix in normalize (§14.5.13)`

---

## Phase E — Coverage gap

### Step 14 — 14.5.14: DI test for `openWithNoFollow(path, 'write')`

**Files:**

- `test/unit/adapters/node/node-file-system-injected.test.ts` — new
  test covering the write-mode flag-selection branch with a
  Windows-mocked symlink leaf.

**Commit:** `test(node-fs): cover openWithNoFollow(write) under Windows DI (§14.5.14)`

---

## Phase F — Wrap-up

### Step 15 — BACKLOG tick + design refresh

**Files:**

- `docs/BACKLOG.md` — tick every 14.5.N (and the parent §14.5) `[x]`.
  Per project rule, the tick travels with the implementation; do
  this inside the bundled PR.
- `docs/design/phase-14-5-followups.md` — confirm §8 "Open questions"
  still reads "None"; otherwise document closures.

**Commit:** `docs(backlog): tick §14.5 (all sub-items) (§14.5)`

---

## Order summary

```
Step 0  ✓ design + ADRs                    (refactor pre-req)
Step 1  14.5.5 — rmRecursive double-cont   (refactor)
Step 2  14.5.6 — lstat pre-check           (refactor)
Step 3  14.5.7 — makePolicy interface      (refactor)
Step 4  14.5.8 — findLayout boundary       (refactor)
Step 5  14.5.10 — EISDIR mapErrno          (errno)
Step 6  14.5.11 — isSymlinkLeaf parameter  (errno)
Step 7  14.5.12 — DIRECTORY_NOT_EMPTY      (errno)
Step 8  14.5.3 — skip resolve gate         (perf)
Step 9  14.5.1 — normalised-root cache     (perf)
Step 10 14.5.4 — parent-dir LRU            (perf)
Step 11 14.5.2 — parallel removeTree       (perf)
Step 12 14.5.9 — symlink target            (security)
Step 13 14.5.13 — \\?\ prefix              (security)
Step 14 14.5.14 — openWithNoFollow(write)  (coverage)
Step 15 BACKLOG tick                       (wrap-up)
```

Total: 15 commits including step 0.

## Validation cadence

After every step:
- `npm run check:types` — types green.
- `npm run check` — biome green.
- Targeted vitest run for the slice's files.

Before committing the slice:
- `npm run validate` — full pipeline.

After all 14 slices:
- `npm run validate` — full pipeline (final).
- `npx stryker run --mutate '<modified files>'` — mutation kill /
  document equivalents.
- Three review passes × 4 reviewers in parallel against
  `git diff main...HEAD`.
