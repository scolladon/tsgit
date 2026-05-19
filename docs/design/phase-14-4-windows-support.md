# Phase 14.4 — Full Windows support

## 1. Goal

Re-add `windows-latest` to the `unit-tests` matrix in `.github/workflows/ci.yml`
and resolve the three Windows-only failure modes blocking it today. After this
phase:

- `NodeFileSystem.checkContainment` works correctly on a Windows runner whose
  `mkdtemp` parent (`C:\Users\RUNNER~1\…`) is an 8.3 short-name alias of a
  long-name canonical path (`C:\Users\runneradmin\…`).
- The shared `fileSystemContractTests` exercises every adapter on Windows
  without the test inputs accidentally injecting POSIX `/` into a Windows
  absolute path.
- Errno surfacing is consistent across POSIX and Windows for the cases the
  port already maps (`ELOOP`, `EACCES`, `EPERM`).
- CI runs the full unit-test suite on `ubuntu-latest`, `macos-latest`, AND
  `windows-latest` (× Node 22, 24) and the matrix stays green.

BACKLOG §14.4 acceptance (verbatim):

> - `NodeFileSystem.checkContainment` must reconcile realpath outputs that flip
>   between 8.3 short-name and long-name forms on Windows CI runners.
> - File-system contract test fixtures hardcode `${rootDir}/file.bin` — needs
>   `nodePath.join` everywhere so mixed separators don't leak into the test
>   inputs.
> - Errno mapping (ELOOP, EACCES) differs across Windows file types; needs
>   platform-specific branches.
> - Once green, re-add `windows-latest` to the `unit-tests` matrix in
>   `.github/workflows/ci.yml`.

Out of scope:

- Mutation testing on Windows (covered by Phase 15.4 — per-OS mutation tracking).
- Integration tests on Windows (the `git-http-backend` CGI stack is POSIX-only;
  already documented in `test/integration/network/clone-http-backend.test.ts`
  and reaffirmed by ADR-041).
- E2E / Playwright on Windows (Linux runner already covers Chromium/Firefox/WebKit).
- Mass refactor of `node:fs` calls to `node:fs/promises.native` variants. This
  phase only touches the call sites where Windows correctness demands it.
- `wrap-fs-validator` casing / canonicalisation. The Phase 11 separator
  normalisation shipped already (`\` → `/`); drive-letter case-folding inside
  `isContainedIn` would be a follow-up if real Windows runs flag it. Out of
  scope by [BACKLOG.md §14.4](../BACKLOG.md#phase-14--glob--pathspec-v1x-patch).

## 2. Architecture

The work concentrates in three places (the same three the BACKLOG calls out):

```
src/adapters/node/node-file-system.ts
  ├─ NodeFileSystem.checkContainment       → 8.3 reconciliation
  ├─ NodeFileSystem.exists                 → same containment fix
  └─ mapErrno + openWithNoFollow           → Windows errno branches

test/unit/ports/file-system.contract.ts
  └─ every `${env.rootDir}/foo` template   → nodePath.join(env.rootDir, 'foo')

.github/workflows/ci.yml
  └─ unit-tests matrix                     → re-add windows-latest
```

Nothing else moves. The fix is a portability/correctness slice, not a feature.

### 2.1 The 8.3 short-name problem

On Windows CI runners (GitHub Actions `windows-latest`), `mkdtemp` returns paths
under `C:\Users\RUNNER~1\AppData\Local\Temp\tsgit-it-XXXX`. Node's
`fsPromises.realpath` on a path created under that prefix *may* expand the
8.3 short-name parent to its long-name form (`runneradmin`) and *may not*,
depending on how the underlying Win32 `GetFinalPathNameByHandle` resolves the
specific file. The result is that two calls into `realpath` on related paths
produce strings that differ in the parent segment alone:

```
rootDir = C:\Users\RUNNER~1\AppData\Local\Temp\tsgit-it-AbCd
real    = C:\Users\runneradmin\AppData\Local\Temp\tsgit-it-AbCd\file.bin
```

`real.startsWith(rootDir + sep)` is `false` even though `real` is genuinely
inside `rootDir`, and `checkContainment` throws `PERMISSION_DENIED`. The fix
is to canonicalise both sides to the SAME form before comparison.

**Canonicalisation strategy.** Canonicalise the root once, lazily, via
`fsPromises.realpath` (which on Windows expands 8.3 short names AND
normalises the drive letter casing). Cache the result on the adapter instance.
For child paths, `resolveForMode` already runs `realpath` on the resolved
path; the comparison then uses the canonical root. On Windows the comparison
is case-insensitive (FAT/NTFS/ReFS are all case-insensitive by default).

This is preserved as an instance-level cache rather than a static cache to
keep `NodeFileSystem` testable per-instance (the contract suite spins up a
fresh instance per test).

The cache is a `Promise<string>` to deduplicate concurrent first calls; the
class never mutates after the promise resolves. See ADR-042.

### 2.2 The contract-test mixed-separator problem

`test/unit/ports/file-system.contract.ts` builds paths via template strings:

```ts
const path = `${env.rootDir}/file.bin`;
```

On POSIX, `env.rootDir = /tmp/tsgit-XXXX` and the result is `/tmp/.../file.bin`.
On Windows the Node adapter's `env.rootDir = C:\Users\…\tsgit-XXXX`, and the
result is `C:\Users\…\tsgit-XXXX/file.bin` — a mixed-separator absolute path.
`nodePath.resolve` does cope with this (it normalises), but `nodePath.join`
produces a *canonical* result that matches what callers would actually
produce on each platform. Using `nodePath.join` everywhere eliminates the
mixed-separator class of bug and keeps `realpath`'s input consistent with
the runtime form.

The change is mechanical: replace every `` `${env.rootDir}/X` `` with
`nodePath.join(env.rootDir, 'X')`. The `env.rootDir` value is unchanged.

### 2.3 The Windows errno branches

Node surfaces a different errno on Windows for two operations the port maps:

| Operation            | POSIX errno | Windows errno (observed) | Adapter contract |
|----------------------|-------------|--------------------------|------------------|
| `open(O_NOFOLLOW)` on symlink | `ELOOP` | `EISDIR` for dir-targeted, `EACCES`/`UNKNOWN` for file-targeted | `PERMISSION_DENIED` |
| `lstat` on stale symlink   | `ENOENT`   | `EPERM` for some reparse points | `FILE_NOT_FOUND` |
| `rm` non-empty directory   | `ENOTEMPTY`| `ENOTEMPTY` (Node normalises)   | `NOT_A_DIRECTORY` |

The existing `mapErrno` already covers `ELOOP` (indirectly — it routes
unrecognised codes to `UNSUPPORTED_OPERATION`; `openWithNoFollow` rewraps
those to `PERMISSION_DENIED` when `data.reason === 'ELOOP'`). We need:

1. **`openWithNoFollow` rewrap broadened.** On Windows, the symlink-refusal
   errno is sometimes `EISDIR`, `EACCES`, or even no errno at all (Node returns
   the file's reparse-point data unwrapped). Cover the platform-specific
   surface: keep `ELOOP` rewrap, AND treat `EACCES`/`EPERM` as the same
   refusal IF the path's lstat shows it's a symlink. Otherwise pass-through
   (a `EACCES` on a real file is still a real permission error).
2. **`mapErrno` adds an `ELOOP` arm.** Currently `ELOOP` falls to the default
   (`UNSUPPORTED_OPERATION`); broadening to a first-class `PERMISSION_DENIED`
   keeps cross-platform parity for the symlink-refusal contract. ADR-043
   captures why this lives in `mapErrno` rather than in each call site.

The post-`lstat` discriminator in `openWithNoFollow` is non-trivial — see
§3.3.

### 2.4 Re-adding the Windows matrix cell

Once the above land, the matrix in `.github/workflows/ci.yml` becomes:

```yaml
os: [ubuntu-latest, macos-latest, windows-latest]
node: [22, 24]
```

The Phase 11 comment block ("`windows-latest` excluded for now — …") is
removed. The coverage upload `if:` clause stays Linux-only (Node 22) so the
artifact name remains unique; the per-OS coverage artifact for Windows is
not required for the gate.

ADR-044 covers the criteria: re-include the cell as soon as the suite is
green, AND keep mutation/integration/E2E on Linux because their cost
already saturates the GitHub Actions concurrency limit.

## 3. Type and signature changes

### 3.1 `NodeFileSystem` — canonical root cache

```ts
export class NodeFileSystem implements FileSystem {
  readonly rootDir: string;
  // NEW: lazy long-name canonicalisation of rootDir for containment checks.
  // Promise so concurrent first calls share one realpath. Cleared if the
  // promise rejects.
  private canonicalRootPromise: Promise<string> | undefined = undefined;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /** @internal — invoked by every method that runs `checkContainment`. */
  private async getCanonicalRoot(): Promise<string> {
    if (this.canonicalRootPromise === undefined) {
      this.canonicalRootPromise = fsPromises.realpath(this.rootDir).catch((err) => {
        // Surface the first-call error AND reset the cache so a retry can run.
        // (Without reset the adapter becomes permanently broken after a transient
        // ENOENT — e.g. a TOCTOU-deleted temp dir between construction and use.)
        this.canonicalRootPromise = undefined;
        throw err;
      });
    }
    return this.canonicalRootPromise;
  }
}
```

### 3.2 Containment check — canonicalised comparison

The current `checkContainment`:

```ts
const check = (abs: string): void => {
  if (abs !== this.rootDir && !abs.startsWith(this.rootDir + nodePath.sep)) {
    throw permissionDenied(path);
  }
};
```

becomes:

```ts
const canonicalRoot = await this.getCanonicalRoot();
const check = (abs: string): void => {
  if (!pathContains(canonicalRoot, abs)) {
    throw permissionDenied(path);
  }
};
```

where `pathContains` is a new private helper, and `isWindows()` /
`normalizeForCompare()` live in a small platform indirection module
(`src/adapters/node/platform.ts`) so tests can stub them:

```ts
// src/adapters/node/platform.ts
export const isWindows = (): boolean => process.platform === 'win32';

/** Drive-letter / casing normalisation; identity on POSIX. */
export const normalizeForCompare = (p: string): string =>
  isWindows() ? p.toLowerCase() : p;

// src/adapters/node/node-file-system.ts (module-local helper)
/** True if `child === parent` OR `child` is strictly inside `parent`. */
const pathContains = (parent: string, child: string): boolean => {
  const p = normalizeForCompare(parent);
  const c = normalizeForCompare(child);
  if (c === p) return true;
  return c.startsWith(p + nodePath.sep);
};
```

The `exists` method follows the same pattern (the inline containment check
becomes a `pathContains` call against `canonicalRoot`).

`normalizeSeparators` from `wrap-fs-validator.ts` is *not* reused here —
that helper normalises `\` → `/`, which is the wrong direction for the
Node adapter (paths flowing into `realpath` must use the platform separator).

### 3.3 `openWithNoFollow` — broaden the Windows refusal surface

After ADR-043, `mapErrno(ELOOP)` already returns `PERMISSION_DENIED`, so
the POSIX rewrap collapses entirely. The remaining work in `openWithNoFollow`
is the Windows-only discriminator that absorbs `EACCES`/`EPERM` rewraps
ONLY when the leaf is a symlink:

```ts
openWithNoFollow = async (path: string, mode): Promise<FileHandle> => {
  const real = await this.checkContainment(path, 'lstat');
  // On Windows, lstat the real path first so the post-open errno can be
  // discriminated. A pre-open lstat is cheap and avoids opening symlinks.
  const isSymlinkLeaf = isWindows() ? await this.isSymlinkLeaf(real) : false;

  const flag = mode === 'write' ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
  return wrapNodeHandle(
    await runFs(
      () => fsPromises.open(real, flag | fs.constants.O_NOFOLLOW),
      path,
    ).catch((err: unknown) => {
      if (isWindowsSymlinkRefusal(err, isSymlinkLeaf)) throw permissionDenied(path);
      throw err;
    }),
  );
};

private async isSymlinkLeaf(real: string): Promise<boolean> {
  try {
    return (await fsPromises.lstat(real)).isSymbolicLink();
  } catch {
    return false;
  }
}

const isWindowsSymlinkRefusal = (err: unknown, isSymlinkLeaf: boolean): boolean =>
  isWindows() &&
  isSymlinkLeaf &&
  err instanceof TsgitError &&
  (err.data.code === 'PERMISSION_DENIED' || err.data.code === 'UNSUPPORTED_OPERATION');
```

This is the smallest change that:

- Keeps POSIX behaviour bit-identical (`isWindows` short-circuits the new path).
- Treats a Windows refusal as `PERMISSION_DENIED` ONLY when the leaf is a
  symlink — a real `EACCES` on a regular file still surfaces verbatim.
- Avoids opening the symlink twice (the pre-lstat is the safety check; the
  post-open errno is just the trigger).

### 3.3.1 Containment in `lstat` mode

`resolveForMode('lstat')` does `realpath(dirname(resolved)) + join(parent, basename)`
to avoid resolving the leaf when callers explicitly want symlink-aware
behaviour. After §3.1's canonicalisation, the produced `joined` is
guaranteed to start with the canonical parent, and `canonicalParent`
starts with `canonicalRoot`. `pathContains(canonicalRoot, joined)` then
holds even when the user supplied a short-name basename — the
filesystem-level `lstat(joined)` succeeds regardless of which form the
basename is in. No additional branch is required.

### 3.4 `mapErrno` — first-class `ELOOP`

```ts
export function mapErrno(err: NodeJS.ErrnoException, path: string): TsgitError {
  switch (err.code) {
    case 'ENOENT': return fileNotFound(path);
    case 'EEXIST': return fileExists(path);
    case 'ENOTDIR':
    case 'ENOTEMPTY':
      return notADirectory(path);
    case 'EACCES':
    case 'EPERM':
      return permissionDenied(path);
    case 'ELOOP': // NEW — first-class symlink refusal across POSIX + Windows.
      return permissionDenied(path);
    default:
      return unsupportedOperation('filesystem', err.code ?? 'UNKNOWN');
  }
}
```

The POSIX `isPosixSymlinkRefusal` predicate is **deleted** — `mapErrno`
covers the case directly. The previously documented `equivalent-mutant`
notes that mentioned `data.reason === 'ELOOP'` are reviewed in §5
implementation (refactor-cleaner pass) and updated or dropped depending
on whether the body that referred to them survives the refactor.

### 3.5 Contract test fixtures — `nodePath.join` everywhere

Every `` `${env.rootDir}/X` `` is rewritten as `nodePath.join(env.rootDir, 'X')`.
This is mechanical. `env.rootDir` itself is the value the contract suite
already produces (the Node fixture uses `mkdtemp`; the memory fixture uses
a sentinel string). No fixture changes.

The contract tests stay adapter-agnostic — they exercise the same calls on
every adapter, and the join helper produces platform-native separators on
each. The memory adapter normalises both `/` and `\` internally; the join
output for the memory fixture remains POSIX-shaped on every host, so the
memory tests are not platform-sensitive.

## 4. Test plan

### 4.1 Unit tests (cross-platform)

The contract suite already runs against `node`, `memory`, and (per Phase 11)
`browser` adapters. After the join rewrite it runs unchanged on Windows.

New unit tests live in `test/unit/adapters/node/node-file-system.test.ts`:

- **Canonical-root cache**
  - Given a NodeFileSystem instance, When two concurrent operations trigger
    canonicalisation, Then `realpath` runs at most once.
  - Given the first `realpath` call rejects, When a second op runs, Then a
    fresh `realpath` is attempted (cache cleared on rejection).

- **Windows-mocked containment** (via the `platform.ts` indirection from
  §3.2 — tests stub the exported `isWindows()` and `normalizeForCompare()`)
  - Given `rootDir = C:\Users\RUNNER~1\TEMP\foo`, When `realpath(rootDir)`
    returns `C:\Users\runneradmin\Temp\foo`, And a child path resolves to
    `C:\Users\RUNNERADMIN\Temp\foo\bar.bin`, Then `checkContainment`
    returns the canonical path (not throw).
  - Given the same rootDir, When a sibling outside `runneradmin\Temp\foo`
    is requested, Then `PERMISSION_DENIED` is thrown.
  - Given a child whose containment differs only in drive-letter casing,
    Then containment passes.

- **Windows-mocked errno mapping**
  - Given `mapErrno({ code: 'ELOOP' }, path)`, Then returns
    `PERMISSION_DENIED`.
  - Given `openWithNoFollow` on a Windows symlink whose `open` rejects with
    `{ code: 'EACCES' }`, And the leaf `lstat` shows `isSymbolicLink`, Then
    `PERMISSION_DENIED` is thrown.
  - Given `openWithNoFollow` on a regular Windows file whose `open` rejects
    with `{ code: 'EACCES' }`, And the leaf is NOT a symlink, Then the
    original `PERMISSION_DENIED` (from `mapErrno`'s EACCES arm) is thrown
    — the symlink branch must not absorb genuine permission errors.

### 4.2 Integration tests (real Windows runner)

`test/integration/cross-platform/windows-paths.test.ts` is extended with
a new file `test/integration/cross-platform/windows-containment.test.ts`:

- **8.3 short-name reconciliation**
  - Given `mkdtemp` produced a path under an 8.3-shortened parent, When
    `fs.write` is called on a child, Then it succeeds and `fs.read` returns
    the same bytes.
- **Symlink refusal**
  - Given a symlink leaf inside the working tree, When `openWithNoFollow` is
    called on it, Then `PERMISSION_DENIED` is thrown — regardless of the
    Windows-surfaced errno.

These tests use `describe.skipIf(process.platform !== 'win32')` and therefore
no-op on POSIX dev shells; the Windows CI cell is the gate.

### 4.3 Mutation testing

Per BACKLOG §15.4, mutation testing stays Linux-only. Concretely the
following mutants are provably equivalent on Linux runners and must be
documented inline:

- `normalizeForCompare` — `toLowerCase()` is the identity on every POSIX
  containment path (rootDir + child both come from `realpath` which is
  case-preserving on POSIX). Stryker's MethodExpression mutator removing
  the call has no observable effect on the Linux mutation run.
- `isWindows()` short-circuit guards — on POSIX, the symbol always returns
  `false`. The mutator that forces it to `true` regresses the POSIX
  rewrap behaviour (it would absorb genuine `EACCES` errors), but only on
  a Windows mutation run. On Linux, both branches collapse: the guarded
  body is unreachable, the mutant is equivalent. Document inline.

Both will carry `// equivalent-mutant: <why>` comments per project
convention.

## 5. Risks

- **POSIX regression.** The `pathContains` helper replaces the inline check
  on both POSIX and Windows. On POSIX `normalizeForCompare` is the identity,
  so behaviour is identical. The replacement is covered by the existing
  cross-adapter contract suite + the new unit tests.
- **Realpath on a non-existent rootDir.** Some callers pass a rootDir that
  is about to be created (init). The lazy cache means `realpath` runs on
  *first method call*, not at construction; by then the dir exists. The
  rejection-clears-cache rule covers the edge case where the dir is
  TOCTOU-deleted between init and use.
- **`fsPromises.realpath` is Node's `realpath.native` since Node 12.** Both
  arms of the platform branch use the same Node API; we don't reach for
  `realpath.native` separately.
- **CI cost.** `windows-latest` runners are slower (~3-4× Linux for cold
  Node setup). The `unit-tests` job runs in ~6 min on Linux; expect ~12-15 min
  on Windows. Acceptable per [Phase 11.2 backlog rationale](../BACKLOG.md#phase-11-polish--launch).
- **Browser adapter unaffected.** OPFS / SubtleCrypto / DecompressionStream
  do not touch Windows-specific path handling; the contract-test rewrite
  applies but is a no-op on the browser fixture.
- **Windows symlink creation requires developer-mode or admin.** GitHub
  Actions' `windows-latest` runner has developer mode enabled by default,
  so `fs.symlink` works without admin. The integration test in §4.2 still
  uses a try/catch around `fs.symlink` and `skip`s if creation throws
  `EPERM` — keeps the suite resilient if the runner image changes.

## 6. Key design decisions

The five decisions below are captured as ADRs; the design summarises them.

- **ADR-041: dev-vs-CI testing strategy** — develop on macOS with
  platform-mocked unit tests + run a draft PR against `windows-latest` for
  end-to-end validation. The mocked tests are the gate; the real-runner
  tests catch the residual quirks the mocks miss.
- **ADR-042: 8.3 short-name canonicalisation via lazy realpath cache** —
  rather than canonicalise at construction (sync, can't `await`), cache
  the realpath promise on the instance.
- **ADR-043: errno mapping placement** — `ELOOP` becomes first-class in
  `mapErrno`; the Windows-symlink discriminator stays in `openWithNoFollow`
  because it needs the pre-lstat result.
- **ADR-044: CI matrix inclusion criteria** — `unit-tests` × Windows = YES;
  mutation / integration / E2E = Linux-only for cost.
- **ADR-045: separator normalisation policy at the adapter boundary** —
  the adapter accepts mixed-separator input (real-world Windows tools
  produce them) but emits platform-native separators internally; the
  domain validator's `\` rejection stays unchanged (domain paths flow
  POSIX-only).

## 7. Mutation-resistance directives

Per project rules: every new comparison must be tested at both arms in
isolation. New tests must use the AAA / Given-When-Then template with
`sut` as the system-under-test variable.

The cache initialisation is a stateful one-shot; tests construct a fresh
`NodeFileSystem` per case and assert via spied `fsPromises.realpath`.

The platform branch (`isWindows()`) is unit-tested via the
`src/adapters/node/platform.ts` indirection from §3.2 that exports
`isWindows = () => process.platform === 'win32'`. Tests stub the
exported function via `vi.spyOn` — `process.platform` itself is read-only
and cannot be replaced. The branch itself is not candidate-mutable:
flipping `isWindows()` to always-false regresses every Windows test;
always-true regresses every POSIX test. Both arms are killed by
complementary tests.

## 8. Open questions resolved

- **Q: Should we hoist `normalizeSeparators` from `wrap-fs-validator.ts`?**
  A: No. Different semantic axis (`\` → `/` vs platform-native). Keep both.
- **Q: Could we just disable containment on Windows?**
  A: No. The check is a security invariant from Phase 11; Windows is the
  exact place we MOST need it (more reparse-point variety = more attack
  surface).
- **Q: Why not canonicalise both sides every call?**
  A: Double realpath per call is wasteful and creates a cache-coherency
  problem the lazy-cache avoids. The rootDir is immutable for the
  adapter's lifetime by construction.
