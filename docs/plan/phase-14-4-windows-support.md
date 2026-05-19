# Plan — Phase 14.4 — Full Windows support

Design: `docs/design/phase-14-4-windows-support.md`.
ADRs: 041 (testing strategy), 042 (canonical-root cache), 043 (errno
placement), 044 (CI matrix), 045 (separator policy).

Branch: `feat/windows-support`.

Atomic conventional-commit per step. `npm run validate` green before
committing. TDD per slice (RED → GREEN → REFACTOR).

## Step 1 — Platform indirection module

**Files touched:**

- `src/adapters/node/platform.ts` — NEW. Exports
  `isWindows = (): boolean => process.platform === 'win32'` and
  `normalizeForCompare = (p: string): string => isWindows() ? p.toLowerCase() : p`.
- `src/adapters/node/index.ts` — NO barrel re-export. `isWindows`
  and `normalizeForCompare` are adapter-internal; tests import them
  from `src/adapters/node/platform.js` directly, following the
  convention used for `realpathNearestExisting`, `interpretCreationLstat`,
  and the other internal helpers.
- `test/unit/adapters/node/platform.test.ts` — NEW. Two tests:
  - `Given process.platform === 'win32', When isWindows is called, Then returns true`.
  - `Given process.platform === 'darwin', When isWindows is called, Then returns false`.
  - `Given Windows host, When normalizeForCompare uppercase, Then returns lowercase`.
  - `Given POSIX host, When normalizeForCompare uppercase, Then returns unchanged`.

The tests stub `isWindows` via
`vi.spyOn(platformModule, 'isWindows').mockReturnValue(true|false)`
where `platformModule` is the imported module. This is the canonical
seam used throughout the phase — Steps 2-6 all reach for the same
stub. `process.platform` itself is read-only and cannot be replaced
with `vi.stubGlobal` (per design §7).

**Commit:** `feat(node-adapter): platform indirection (isWindows, normalizeForCompare)`.

## Step 2 — `pathContains` helper

**Files touched:**

- `src/adapters/node/node-file-system.ts` — add module-local
  `pathContains(parent: string, child: string): boolean` using
  `normalizeForCompare`. No call-site changes yet.
- `test/unit/adapters/node/node-file-system.test.ts` — pinning tests for
  `pathContains`:
  - `Given parent === child, When pathContains, Then returns true`.
  - `Given child strictly inside parent (POSIX), When pathContains, Then returns true`.
  - `Given child outside parent, When pathContains, Then returns false`.
  - `Given prefix-only match (parent='/tmp/foo', child='/tmp/foobar'), When pathContains, Then returns false` — kills the StringLiteral mutant that drops `+ sep`.
  - `Given Windows host, parent='C:\\Users\\Foo', child='C:\\users\\foo\\bar', Then returns true` — case-insensitive match.
  - `Given POSIX host, parent='/Users/Foo', child='/users/foo/bar', Then returns false` — POSIX is case-sensitive.

Export `pathContains` as a top-level `export function` next to the
existing helpers (`toAbsolute`, `mapErrno`, …) marked with a JSDoc
`@internal` tag. The barrel (`src/adapters/node/index.ts`) does NOT
re-export it; tests import from `node-file-system.js` directly, matching
the convention already used for `interpretCreationLstat`,
`realpathNearestExisting`, `runFs`.

**Commit:** `feat(node-fs): pathContains helper for canonical containment`.

## Step 3 — `getCanonicalRoot` cache

**Files touched:**

- `src/adapters/node/node-file-system.ts` — add
  `private canonicalRootPromise: Promise<string> | undefined = undefined`
  and `private async getCanonicalRoot(): Promise<string>` that lazily
  calls `fsPromises.realpath(this.rootDir)` and resets the cache on
  rejection.
- `test/unit/adapters/node/node-file-system.test.ts` — new tests:
  - `Given fresh sut, When getCanonicalRoot is called twice, Then fsPromises.realpath runs at most once` — spy on `fsPromises.realpath`.
  - `Given two concurrent getCanonicalRoot calls, Then fsPromises.realpath runs exactly once` — proves the promise dedupes.
  - `Given the first realpath rejects with ENOENT, When a second call runs, Then realpath is attempted again` — proves the reset-on-rejection rule.
  - `Given the first realpath resolved, When a second call runs, Then the cached value is returned without a fresh realpath` — proves the cache hit.

Tests exercise the cache through observable behaviour: spy on
`fsPromises.realpath`, then call public methods (`fs.exists`, `fs.lstat`)
that funnel through `getCanonicalRoot()`. The cache hit / miss / reset
contracts are asserted via spy call counts. `getCanonicalRoot` stays
`private`; no test-only accessor is added.

**Commit:** `feat(node-fs): lazy canonical-root cache`.

## Step 4 — Wire `checkContainment` to the canonical root

**Files touched:**

- `src/adapters/node/node-file-system.ts` —
  - `checkContainment` awaits `getCanonicalRoot()` and substitutes
    `pathContains(canonicalRoot, abs)` for the inline check.
  - `exists` does the same substitution.
- `test/unit/adapters/node/node-file-system.test.ts` — new mocked-Windows
  tests:
  - `Given Windows host, rootDir='C:\\Users\\RUNNER~1\\Temp\\foo', When realpath(rootDir) returns 'C:\\Users\\runneradmin\\Temp\\foo', And checkContainment is called with a child under runneradmin form, Then returns the canonical path`.
  - `Given Windows host, When checkContainment is called with a sibling outside the canonical root, Then throws PERMISSION_DENIED`.
  - `Given Windows host, When checkContainment is called with the same path in different drive-letter case, Then returns success`.
  - `Given POSIX host, When checkContainment receives the same lower/upper mix, Then throws PERMISSION_DENIED` — proves case-sensitivity holds on POSIX.

The mocked tests use a stubbed `fsPromises.realpath` via `vi.spyOn`. The
contract suite (cross-adapter) re-runs after this step to confirm POSIX
hosts are unaffected.

**Commit:** `feat(node-fs): canonical-root containment for checkContainment + exists`.

## Step 5 — `ELOOP` first-class in `mapErrno`

**Files touched:**

- `src/adapters/node/node-file-system.ts` — add the `ELOOP →
  permissionDenied` arm in `mapErrno`. Remove the now-dead `data.reason
  === 'ELOOP'` rewrap branch in `openWithNoFollow`.
- `test/unit/adapters/node/node-file-system.test.ts` — new tests for
  `mapErrno`:
  - `Given errno=ELOOP, When mapErrno, Then returns PERMISSION_DENIED with the same path`.
  - The existing `openWithNoFollow on a symlink throws PERMISSION_DENIED` test stays green (now via mapErrno).
- The existing inline `equivalent-mutant` notes that mention `ELOOP`
  are reviewed and dropped where no longer applicable.

**Commit:** `feat(node-fs): mapErrno → PERMISSION_DENIED for ELOOP`.

## Step 6 — Windows symlink discriminator in `openWithNoFollow`

**Files touched:**

- `src/adapters/node/node-file-system.ts` —
  - Add `private isSymlinkLeaf(real: string): Promise<boolean>`.
  - Add module-local `isWindowsSymlinkRefusal(err, isSymlinkLeaf): boolean`.
  - `openWithNoFollow` pre-`lstat`s on Windows only, then rewraps
    `PERMISSION_DENIED`/`UNSUPPORTED_OPERATION` to `permissionDenied`
    when the leaf is a symlink.
- `test/unit/adapters/node/node-file-system.test.ts` — new mocked tests:
  - `Given Windows host, symlink leaf, When fsPromises.open rejects with EACCES, Then openWithNoFollow throws PERMISSION_DENIED`.
  - `Given Windows host, symlink leaf, When fsPromises.open rejects with EISDIR, Then openWithNoFollow throws PERMISSION_DENIED`.
  - `Given Windows host, regular-file leaf, When fsPromises.open rejects with EACCES, Then openWithNoFollow throws PERMISSION_DENIED` (mapErrno path — proves the discriminator doesn't absorb the original error).
  - `Given POSIX host, symlink leaf, When fsPromises.open rejects with ELOOP, Then openWithNoFollow throws PERMISSION_DENIED` (mapErrno path).

**Commit:** `feat(node-fs): windows symlink refusal discriminator in openWithNoFollow`.

## Step 7 — Contract test fixtures: `nodePath.join` everywhere

**Files touched:**

- `test/unit/ports/file-system.contract.ts` — every
  `` `${env.rootDir}/X` `` becomes `nodePath.join(env.rootDir, 'X')`.
  Add `import * as nodePath from 'node:path'` if not present.
- No production-code change.

Mechanical refactor. The contract suite continues to exercise every
adapter (`node`, `memory`); on POSIX the results are bit-identical
because `nodePath.join('/foo', 'bar')` equals `/foo/bar`.

**Commit:** `refactor(contract-tests): nodePath.join for cross-platform paths`.

## Step 8 — Re-add `windows-latest` to the unit-tests matrix

**Files touched:**

- `.github/workflows/ci.yml` — three edits to the `unit-tests` job:
  1. Remove lines 117-121 (the Phase 11 comment block that explained
     the exclusion).
  2. Change `os: [ubuntu-latest, macos-latest]` to
     `os: [ubuntu-latest, macos-latest, windows-latest]`.
  3. Keep the coverage-artifact `if:` guard (`matrix.os == 'ubuntu-latest'`)
     unchanged — only one OS uploads coverage to keep artifact names
     unique.

**No code change.** This is the merge gate per ADR-044.

**Commit:** `ci(unit-tests): re-add windows-latest to the matrix`.

## Step 9 — Real-Windows unit tests (must run on the windows-latest unit-tests cell)

**Why a unit test, not an integration test?** Phase 11's
`test/integration/cross-platform/windows-paths.test.ts` is in the
integration suite, which only ever runs on `ubuntu-latest` (`git-http-backend`
constraint per ADR-044). That file's `describe.skipIf(win32)` therefore
NEVER runs. To make the new Windows tests actually execute, they must
live in `test/unit/` so they are scheduled on the `unit-tests` matrix —
which after Step 8 includes `windows-latest`.

**Files touched:**

- `test/unit/adapters/node/node-file-system-windows.test.ts` — NEW.
  Uses `describe.skipIf(process.platform !== 'win32')`. Constructs a
  `NodeFileSystem` directly. Two cases:
  - 8.3 short-name reconciliation: `mkdtemp` under `os.tmpdir()`, then
    `fs.write(nodePath.join(rootDir, 'a.bin'), …)` + `fs.read` round
    trip; assert bytes match. The mkdtemp parent on GHA's image is
    `C:\Users\RUNNER~1\…` which exercises the short-name path naturally.
  - Symlink refusal: try `fs.symlink` (gate the test via `it.skipIf`
    using a runtime probe that attempts a no-op symlink and inspects
    the resulting `EPERM` — developer mode may not be enabled on the
    runner image); on success, call `openWithNoFollow` on the link
    path, assert `PERMISSION_DENIED`.
  - Filename is `node-file-system-windows.test.ts` — kebab-case
    compliant per `.ls-lint.yml`. A dotted segment (`.win.test.ts`)
    would fail the lint.

The existing `test/integration/cross-platform/windows-paths.test.ts`
file stays as-is — fixing its non-run is a follow-up captured in the
PR description, not in this slice.

**Commit:** `test(node-fs): real-windows containment + symlink refusal`.

## Step 10 — BACKLOG tick + docs refresh

**Files touched:**

- `docs/BACKLOG.md` — flip §14.4 from `[ ]` to `[x]` with an _Accepted:_
  block listing the four bullets + ADR refs. Bump the "Progress:" line.
- `RUNBOOK.md` — add a "Windows runners" entry under "CI matrix"
  documenting the new cell and its cost.
- `MIGRATION.md` — no change (Windows support is an internal correctness
  fix; the public API is unchanged).
- `README.md` — no change (already lists Windows under "Platforms
  supported"; no caveat needed once the suite is green).
- `CONTRIBUTING.md` — no change (path conventions already documented).

**Commit:** `docs(backlog): tick §14.4 windows support`.

## Step 11 — Push, mutation testing, three review passes

1. `npm run validate` — every check green locally.
2. `stryker run` — document any new equivalent mutants inline
   (`normalizeForCompare`'s `toLowerCase()`, `isWindows()` short-circuits
   per design §4.3).
3. Push the branch as a draft PR. CI runs the new `windows-latest`
   cell.
4. Three review passes (code-reviewer + security-reviewer + test-review
   + perf review in parallel each pass). Fix every HIGH.
5. Mark PR ready for review when all three passes are clean.
6. Wait for user to merge.

## Step ordering rationale

- Steps 1-2 add infrastructure with no behaviour change. The next steps
  build on them.
- Step 3 adds the cache without wiring it up — keeps the rollout
  inspectable. Step 4 wires `checkContainment`/`exists`.
- Step 5 (mapErrno ELOOP) is independent of the cache; it could land in
  either order. Sequenced first because it's a one-line switch arm and
  cleans up the existing rewrap before the more invasive step 6.
- Step 6 (Windows symlink discriminator) depends on `isWindows()` from
  step 1 and on the rewrap deletion from step 5.
- Step 7 (contract test refactor) is mechanical and depends on nothing.
- Step 8 (CI matrix) lands LAST among the production-code changes so
  the Windows cell turns green on the same commit that re-enables it.
- Step 9 (integration test) is gated on the Windows runner being
  enabled; lands after Step 8.
- Steps 10-11 are the workflow tail.

## Step-by-step dependency graph

```
1 → 2 → 4
1 → 6
3 → 4
5 → 6
4, 6 → 8 → 9
4, 5, 6, 7, 8, 9 → 10 → 11
```

Each step compiles and passes the full validate-suite in isolation.
Atomic commits per project rules.
