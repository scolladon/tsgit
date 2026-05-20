# Phase 14.5 — §14.4 follow-up bundle

## 1. Goal

Close the 14 follow-up items recorded under `docs/BACKLOG.md §14.5` in a
single bundled branch. The merged §14.4 implementation is the contract;
this phase tightens it along three orthogonal axes:

1. **Perf** (14.5.1–14.5.4) — cut redundant string allocations and serial
   I/O on the containment hot path that every working-tree command
   touches.
2. **Refactors** (14.5.5–14.5.8) — pay down the architectural debt the
   §14.4 review passes surfaced: double-containment in `rmRecursive`,
   lstat-mode asymmetry in `resolveForMode`, structural typing for
   `makePolicy`, and the hexagonal-boundary violation in
   `find-layout.ts`.
3. **Security / errno** (14.5.9–14.5.13) — tighten the symlink/errno
   surface: validate absolute symlink targets, give `EISDIR` a
   first-class arm in `mapErrno`, drop a misleading parameter, separate
   `ENOTEMPTY` from `ENOTDIR`, and document/handle the Windows
   extended-length `\\?\` prefix.
4. **Coverage gap** (14.5.14) — extend the `openWithNoFollow(path,
   'write')` DI coverage.

After this phase:

- `checkContainment` no longer re-normalises the rootDir / canonical
  root on every call. Per-instance fields hold the lowercased form.
- `removeTree` walks children with bounded concurrency (limit 8).
- `policy.resolve()` is skipped when the input is already absolute.
- `resolveForCreation` consults a small LRU keyed on the parent
  directory so a clone/checkout of N files into the same tree pays
  the realpath walk once.
- `rmRecursive` calls `runFs(() => this.fsOps.lstat(real), path)`
  directly instead of `this.lstat(real)`.
- `resolveForMode`'s `lstat` arm runs the same pre-realpath
  `check(resolved)` as the `read` arm.
- `makePolicy`'s parameter has an explicit structural interface; the
  host `nodePath` namespace can no longer be passed by accident.
- `findLayout` accepts the `PathPolicy` as a parameter; the
  `nativePolicy` default no longer crosses the repository → adapter
  boundary.
- `NodeFileSystem.symlink` rejects absolute targets that escape
  rootDir; relative targets pass.
- `mapErrno` gains first-class `EISDIR → permissionDenied(path)` and
  a separate `directoryNotEmpty(path)` for `ENOTEMPTY`.
- The `isWindowsSymlinkRefusal(err, _isSymlinkLeaf, policy)` parameter
  is dropped at the only call site; the function signature collapses
  to `(err, policy)`.
- Windows `normalizeForCompare` strips a leading `\\?\` extended-
  length prefix before lowercasing.
- A new DI test exercises `openWithNoFollow(path, 'write')` against a
  Windows-mocked symlink.

BACKLOG §14.5 acceptance (verbatim):

> 14.5.1 Cache normalizeForCompare(rootDir) + normalizeForCompare(canonicalRoot) as instance fields …
> 14.5.2 Bounded-concurrency walk in NodeFileSystem.removeTree …
> 14.5.3 Gate policy.resolve() in checkContainment on policy.isAbsolute(abs) …
> 14.5.4 Parent-directory realpath LRU (capacity 64) in resolveForCreation …
> 14.5.5 Replace this.lstat(real) inside rmRecursive with runFs(() => this.fsOps.lstat(real), path) …
> 14.5.6 Mirror the read-mode pre-realpath containment check in resolveForMode's lstat branch …
> 14.5.7 Narrow makePolicy's parameter type … to an explicit structural interface …
> 14.5.8 Move the nativePolicy default out of src/repository/find-layout.ts …
> 14.5.9 Validate absolute-symlink targets against rootDir containment inside NodeFileSystem.symlink …
> 14.5.10 Add case 'EISDIR': return permissionDenied(path) to mapErrno …
> 14.5.11 Drop the always-true isSymlinkLeaf argument at the only isWindowsSymlinkRefusal call site …
> 14.5.12 Distinguish ENOTEMPTY from ENOTDIR in mapErrno …
> 14.5.13 Strip a leading \\?\ extended-length prefix inside Windows normalizeForCompare …
> 14.5.14 DI-level coverage of openWithNoFollow(path, 'write') against a Windows-mocked symlink …

Out of scope:

- Any feature beyond the 14 enumerated items.
- Reworking the `FileSystem` port. `FsOperations` and `PathPolicy`
  remain adapter-internal `@internal` seams per ADR-046/047.
- Windows-CI matrix changes — the existing matrix (per ADR-044, -048)
  is sufficient to validate the new behaviour.
- Browser adapter changes — the OPFS adapter does not consume
  `NodeFileSystem` and is unaffected.

## 2. Architecture

The work concentrates in three files:

```
src/adapters/node/
├── node-file-system.ts    # 14.5.1, 14.5.2, 14.5.3, 14.5.4, 14.5.5,
│                          # 14.5.6, 14.5.10, 14.5.11, 14.5.12, 14.5.9
├── path-policy.ts         # 14.5.7, 14.5.13
└── fs-operations.ts       # untouched (relevant only as the DI surface)

src/repository/
└── find-layout.ts         # 14.5.8

test/unit/adapters/node/
├── node-file-system-injected.test.ts   # 14.5.14, new mutation kills
└── path-policy.test.ts                 # 14.5.7, 14.5.13 tests

src/domain/error.ts        # 14.5.12 new error variant
```

Nothing else moves.

### 2.1 Normalised-root cache (14.5.1)

Add two readonly fields populated at first call:

```ts
private normalizedRootDirCache: string | undefined;
private normalizedCanonicalRootCache: string | undefined;
```

`pathContains(parent, child, policy)` is the existing helper that
calls `policy.normalizeForCompare(parent)` and
`policy.normalizeForCompare(child)`. For the constant parents
(`this.rootDir` and the canonical root) we lazily memoise the
normalised form. The child is per-call and stays uncached.

The cache is per-`NodeFileSystem` instance — same scope as the
canonical-root promise. Initialised:
- `normalizedRootDirCache` is set on the first `pathContains(this.rootDir, …)` call (computed from `this.rootDir`).
- `normalizedCanonicalRootCache` is set when `getCanonicalRoot()` resolves.

No invalidation needed: `rootDir` is `readonly` on construction; the
canonical root is the realpath of an immutable path. The existing
`canonicalRootPromise` rejection reset already handles transient
ENOENT.

### 2.2 Bounded-concurrency removeTree (14.5.2)

Introduce a small `mapConcurrent` helper. We do NOT pull a generic
operator into `src/operators/` — the use is single-callsite and the
helper is 12 LOC. Place it as a `@internal` function inside
`node-file-system.ts`:

```ts
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
```

`removeTree`'s body becomes:

```ts
await mapConcurrent(entries, REMOVE_TREE_CONCURRENCY, (entry) =>
  this.removeTree(this.pathPolicy.join(real, entry.name), originalPath),
);
await runFs(() => this.fsOps.rmdir(real), originalPath);
```

Constant `REMOVE_TREE_CONCURRENCY = 8` (Priority 7 — bounded I/O).

Error propagation: `Promise.all` rejects on first failure. Other
in-flight workers continue until their current `fn` resolves but
their results are discarded. This matches the existing serial
behaviour at semantic level — the original `for…of` would abort on
first throw too. The trade-off is one extra wasted lstat per
in-flight worker after the first failure; acceptable.

### 2.3 Skip `resolve()` on inputs without relative segments (14.5.3)

In `checkContainment` today:

```ts
const resolved = this.pathPolicy.resolve(toAbsolute(path, this.rootDir, this.pathPolicy));
```

`toAbsolute` always returns an absolute path. The subsequent `resolve`
is there to normalise embedded `..` and `.` segments — but it pays
the cost on every call, including the common case where the input
has no relative segments.

Gate on the presence of relative segments. The probe is a string
inspection (no allocation if the substrings are absent):

```ts
const abs = toAbsolute(path, this.rootDir, this.pathPolicy);
const hasRelativeSeg =
  abs.includes('/..') || abs.includes('/.') || abs.includes('\\..') || abs.includes('\\.');
const resolved = hasRelativeSeg ? this.pathPolicy.resolve(abs) : abs;
```

We keep `resolve` for the relative-segment case — even though
`fsPromises.realpath` would normalise them, the pre-realpath
`check(resolved)` arm in `resolveForMode`'s `read` branch fires
BEFORE realpath and needs a normalised input to compute containment
correctly. Without the gate, `pathContains(rootDir, '/root/sub/../escape')`
would mistakenly pass.

The cost dropped: one no-op `resolve` call per `checkContainment` on
the hot path (`status`, `add --all`, `read`/`write`/`lstat`).

### 2.4 Parent-directory realpath LRU (14.5.4)

`resolveForCreation` calls `realpathNearestExisting(resolved, …)` for
every write. For a clone/checkout writing N files under the same
parent directory, the function walks the same tree N times.

Add a per-instance LRU keyed on the parent path's *raw* (post-resolve)
form. Cache only entries whose parent **exists at cache time** — the
realpathNearestExisting fallback walk (ENOENT → walk up) is
explicitly not cached so a partially-created tree doesn't get its
fallback decision frozen.

```ts
private creationParentCache: LruCache<string, string>;
//                                       ^raw parent  ^realpath(parent)

const CREATION_PARENT_LRU_CAPACITY = 64;
```

`LruCache` already exists at `src/domain/storage/lru-cache.ts` (used by
the pack-delta-base cache). Re-use it.

`resolveForCreation` becomes:

```ts
const parent = this.pathPolicy.dirname(resolved);
const basename = this.pathPolicy.basename(resolved);
const cached = this.creationParentCache.get(parent);
const realParent =
  cached ?? (await this.realpathParentIfExists(parent));
if (realParent !== undefined) {
  if (cached === undefined) this.creationParentCache.set(parent, realParent);
  const real = this.pathPolicy.join(realParent, basename);
  // existing leaf lstat + containment check on `real`.
  …
}
// Parent doesn't exist yet → fall back to the existing
// realpathNearestExisting walk. NOT cached.
return realpathNearestExisting(resolved, this.pathPolicy, this.fsOps);
```

`realpathParentIfExists(parent)` returns `realpath(parent)` if it
resolves, `undefined` on ENOENT, and rethrows any other errno.

Cache invalidation: two events drop entries.

1. **`rmRecursive` of an ancestor** clears every cache entry whose key
   starts with the removed path. The removeTree exit-point invalidates
   eagerly.
2. **`rename` of an ancestor** invalidates the source-side keys.

Both events run inside the adapter; the cache mutation is local. No
external invalidation surface.

Trade-off: a user who externally mutates the filesystem (renames a
directory tsgit is writing into) gets a stale realpath until the
cache evicts. The post-call containment check still fires on the
joined path — a stale entry can produce a wrong write location, but
cannot escape `rootDir` because both `rawRoot` and `canonicalRoot`
bounds still gate the final `real`.

The cache is per-instance, same lifetime as the adapter.

### 2.5 Drop `this.lstat(real)` in rmRecursive (14.5.5)

`rmRecursive` currently runs:

```ts
real = await this.checkContainment(path, 'lstat');
await this.lstat(real);    // ← second containment round-trip
```

`this.lstat(real)` re-enters `checkContainment` because `lstat` is a
public method. The fix:

```ts
real = await this.checkContainment(path, 'lstat');
await runFs(() => this.fsOps.lstat(real), path);
```

The intent of the call is the side-effect of throwing `FILE_NOT_FOUND`
for a missing leaf. `runFs` does the errno mapping. No double
containment.

### 2.6 Pre-realpath check in lstat mode (14.5.6)

`resolveForMode` for `read` runs `check(resolved)` before `realpath`.
For `lstat` it doesn't; the post-check on the joined result still
fires.

The asymmetry is a minor perf cost — the lstat path executes one
realpath even when the input is obviously out-of-tree. Fix:

```ts
if (mode === 'lstat') {
  check(resolved);
  const parent = await this.fsOps.realpath(this.pathPolicy.dirname(resolved));
  return this.pathPolicy.join(parent, this.pathPolicy.basename(resolved));
}
```

Identical to the `read` arm's structure.

### 2.7 Narrow makePolicy's parameter (14.5.7)

`makePolicy(impl: typeof nodePath.posix, caseInsensitive: boolean)`
documents intent as "the posix namespace" but accepts `nodePath.win32`
structurally (both share the type signature) AND would accept the
host `nodePath` namespace (which exposes both posix/win32 as
properties — but its own surface methods also match the type).

Narrow to an explicit interface that lists exactly the seven members
the factory consumes:

```ts
interface PathPolicySource {
  readonly sep: string;
  isAbsolute(path: string): boolean;
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  parse(path: string): { readonly root: string };
}

const makePolicy = (impl: PathPolicySource, caseInsensitive: boolean): PathPolicy => …
```

Important caveat: the host `nodePath` namespace *also* satisfies
`PathPolicySource` structurally — TypeScript cannot prevent that by
typing alone. The narrowing is **documentation**, not type-level
enforcement. The real defence-in-depth is `makePolicy` staying
module-private and the only entry points being the pre-built
`posixPolicy` / `windowsPolicy` constants.

The interface is also a precise contract for what a future custom
policy needs to implement, should §14.5.7 prove to be the seed of a
broader extension point.

### 2.8 Move nativePolicy default out of find-layout.ts (14.5.8)

`findLayout(fs, cwd, policy = nativePolicy)` imports `nativePolicy`
from `src/adapters/node/path-policy.js`. Repository code must not
import from adapters.

Two options:
1. Make `policy` a required parameter. Push the `nativePolicy` default
   into the call sites that own platform concerns (the public
   `openRepository` entry point).
2. Hoist the `PathPolicy` interface + the host-detection function into
   a new `src/ports/path-policy.ts` port module.

Option 1 is the minimal change and matches the existing pattern for
adapter injection (every adapter is constructed at the boundary and
passed in). Choose option 1.

Refactor `findLayout` signature:

```ts
- export async function findLayout(fs: FileSystem, cwd: string, policy: PathPolicy = nativePolicy): Promise<RepositoryLayout | undefined>
+ export async function findLayout(fs: FileSystem, cwd: string, policy: PathPolicy): Promise<RepositoryLayout | undefined>
```

Update call sites (`src/repository/repository.ts` and any others) to
pass the policy explicitly. The public `openRepository` factory in
`src/repository.ts` already knows which adapter it's using and can
source the policy from there.

### 2.9 Validate absolute symlink targets (14.5.9)

`NodeFileSystem.symlink(target, path)` currently contains the link
*entry* but passes `target` raw to the kernel. An in-rootDir symlink
could point to `/etc/passwd`; subsequent `readlink` would surface
that path as an info-oracle.

Fix:

```ts
symlink = async (target: string, path: string): Promise<void> => {
  if (this.pathPolicy.isAbsolute(target)) {
    // `target` is absolute — normalise `..` and `.` segments before
    // containment, otherwise `/root/../etc/passwd` would pass the
    // prefix check against `/root`.
    const normalisedTarget = this.pathPolicy.resolve(target);
    const canonicalRoot = await this.getCanonicalRoot();
    if (
      !pathContains(this.rootDir, normalisedTarget, this.pathPolicy) &&
      !pathContains(canonicalRoot, normalisedTarget, this.pathPolicy)
    ) {
      throw permissionDenied(path);
    }
  }
  const real = await this.checkContainment(path, 'creation');
  await runFs(async () => {
    await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
    await this.fsOps.symlink(target, real);
  }, path);
};
```

The `resolve` call is load-bearing: without it, `..`-bearing absolute
targets bypass `pathContains` (which is a prefix check). Relative
targets (the common case for git submodule/submodule-like links) pass
unconditionally — they're resolved against the link entry's location
at OS read time, and the post-realpath containment check on any
follow-up `read`/`stat` would re-verify the resolved leaf.

This matches Git's own hardening response to the long-standing
absolute-symlink CVE class (CVE-2018-17456, CVE-2022-39253).

### 2.10 EISDIR first-class in mapErrno (14.5.10)

Add an explicit arm to `mapErrno`:

```ts
case 'EISDIR':
  return permissionDenied(path);
```

Today EISDIR falls through to the `default` arm which yields
`UNSUPPORTED_OPERATION { reason: 'EISDIR' }`. On Windows the
`isWindowsSymlinkRefusal` discriminator catches that and rewraps to
`PERMISSION_DENIED`. On POSIX (where the discriminator's
`caseInsensitive` gate is false), the caller sees the raw
`UNSUPPORTED_OPERATION`. After this slice, both platforms surface
PERMISSION_DENIED.

The §14.4 follow-up integration test
`node-fs-locked-directory.test.ts` currently asserts the
`UNSUPPORTED_OPERATION` outcome (the value that current code
produces). The 14.5.10 commit updates it to `PERMISSION_DENIED`. No
other production caller observes the old code; `git grep
"UNSUPPORTED_OPERATION"` finds only error-construction sites and
test assertions.

### 2.11 Drop the always-true isSymlinkLeaf parameter (14.5.11)

`isWindowsSymlinkRefusal(err, isSymlinkLeaf, policy)` is called only
once, with `true` hardcoded:

```ts
if (isWindowsSymlinkRefusal(err, true, this.pathPolicy)) { … }
```

The parameter looks load-bearing but isn't — the `true` value is a
contract assumption between `openWithNoFollow` and the discriminator
("by the time we reach this catch, we know the leaf could be a
symlink"). Inline that knowledge:

```ts
export function isWindowsSymlinkRefusal(err: unknown, policy: PathPolicy): boolean {
  if (!policy.caseInsensitive) return false;
  if (!(err instanceof TsgitError)) return false;
  return err.data.code === 'PERMISSION_DENIED' || err.data.code === 'UNSUPPORTED_OPERATION';
}
```

The function is exported (`@internal`); change the unit-test call
sites to drop the second argument.

### 2.12 Distinguish ENOTEMPTY from ENOTDIR (14.5.12)

`mapErrno` maps both to `notADirectory(path)`. They're
semantically different: ENOTEMPTY means "rmdir on a non-empty
directory" (the directory IS a directory). Add a new error variant:

```ts
// src/domain/error.ts
| { readonly code: 'DIRECTORY_NOT_EMPTY'; readonly path: string }

export const directoryNotEmpty = (path: string): TsgitError =>
  new TsgitError({ code: 'DIRECTORY_NOT_EMPTY', path });
```

`mapErrno`:

```ts
case 'ENOTDIR':
  return notADirectory(path);
case 'ENOTEMPTY':
  return directoryNotEmpty(path);
```

Update the memory adapter to surface the same code for parity
(MemoryFileSystem currently uses `notADirectory` for non-empty
`rmRecursive` on a non-recursive call path; review and adjust).

### 2.13 Strip \\?\ extended-length prefix (14.5.13)

`normalizeForCompare(p)` on Windows must strip a leading `\\?\` (or
`\\?\UNC\…`) before lowercasing. Implementation lives in
`path-policy.ts`:

```ts
const stripWinExtendedPrefix = (p: string): string => {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8);
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
};

normalizeForCompare: (path: string) =>
  caseInsensitive ? stripWinExtendedPrefix(path).toLowerCase() : path,
```

The UNC form `\\?\UNC\server\share\…` collapses to
`\\server\share\…`. The simple form `\\?\C:\Users\…` collapses to
`C:\Users\…`.

### 2.14 openWithNoFollow(write) DI test (14.5.14)

A new test in `test/unit/adapters/node/node-file-system-injected.test.ts`:

```ts
it('Given Windows host, symlink leaf, When openWithNoFollow(write) rejects with EACCES, Then PERMISSION_DENIED is thrown', async () => {
  const root = 'C:\\canonical\\win-symlink-write';
  const link = 'C:\\canonical\\win-symlink-write\\link';
  const fsOps = fakeFsOps({
    realpath: vi.fn().mockImplementation(async (input: string) => input),
    lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => true }),
    open: vi.fn().mockRejectedValue(eacces()),
  });
  const sut = new NodeFileSystem(root, windowsPolicy, fsOps);

  let caught: unknown;
  try {
    await sut.openWithNoFollow(link, 'write');
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
});
```

The flag-selection branch (line 439 of node-file-system.ts) currently
only runs via the POSIX-only integration test. The DI test exercises
it cross-platform.

## 3. Testing strategy

Every slice:
- **Red**: write a test (or extend an existing one) that fails against
  current `main`.
- **Green**: minimal implementation.
- **Refactor**: clean up.
- **Validate**: `npm run validate` after each commit.

Mutation testing runs at the end of the implementation phase against
the modified files. Aim for ≥95% mutation score on the three Node
adapter files; document any equivalent mutants inline.

Cross-platform tests stay in `test/unit/`. Real-fs tests stay in the
platform-segregated `test/integration/{posix-only,win-only}/`
folders. No `skipIf` directives in `test/unit/` (per ADR-048).

## 4. Risks

- **14.5.10 errno-mapping change** invalidates the
  `node-fs-locked-directory.test.ts` assertion that EISDIR maps to
  UNSUPPORTED_OPERATION. The test needs updating to PERMISSION_DENIED.
  No production caller depends on the UNSUPPORTED_OPERATION value;
  searched across the repo, only the test itself observes it.

- **14.5.12 new error variant** may surface to callers of
  `rmRecursive` (the only `ENOTEMPTY`-producing site is rmdir). The
  memory adapter does not currently produce `ENOTEMPTY` from `rm`
  (the memory `MemoryFileSystem` implements its own `rmdir` and
  throws `notADirectory` for "is a file, not a directory"). Add a
  parity check; if no memory call surfaces `directoryNotEmpty`, the
  new code is Node-adapter-only.

- **14.5.2 concurrency** of `removeTree` is observable as ordering
  changes: a directory's children may be removed in a different
  order than before. No test depends on order; the existing
  contract tests assert "everything is removed" + leaf identity, not
  walk order.

- **14.5.8 hexagonal-boundary fix** is a breaking change to the
  internal `findLayout` signature. Public API (`openRepository`,
  `Repository`) is unaffected because the change happens in private
  code paths above `findLayout`.

- **14.5.4 LRU** introduces a cache that could mask a directory
  rename. The cache is per-`NodeFileSystem` instance — same lifetime
  as the canonical root — and tsgit never renames a directory it
  has previously realpath'd. The risk is bounded to user code that
  externally renames the parent directory between two writes; this
  case already fails the security containment check post-realpath,
  so the cache cannot enable an escape.

- **14.5.13 \\?\ prefix** changes the lowercase output for
  extended-length paths. Existing tests with mixed-prefix scenarios
  must continue to pass; specifically `pathContains` semantics with
  one side prefix-bearing and the other not.

- **14.5.11 `isWindowsSymlinkRefusal` signature change** is a
  breaking change to an `@internal` exported function. Unit tests
  in `node-file-system.test.ts` call it directly with three arguments
  and need updating in the same commit. No other production caller
  exists (grep'd `isWindowsSymlinkRefusal` shows one call site in
  src and a handful in tests).

- **14.5.7 docs-only narrowing**: TypeScript cannot prevent the host
  `nodePath` namespace from satisfying the new interface. The
  protection is purely documentation + the existing
  module-private factory pattern.

## 5. Key design decisions

Captured as ADRs (see §3 of CLAUDE.md):

- **ADR-049**: Bundle vs split — why all 14 items go in one PR.
- **ADR-050**: Cache invalidation policy for the normalised root and
  the resolveForCreation LRU.
- **ADR-051**: Symlink target containment policy (absolute rejected,
  relative accepted unconditionally).
- **ADR-052**: New `DIRECTORY_NOT_EMPTY` error code in the domain
  error union.

## 6. Slice ordering

Eight implementation phases, atomic commits per slice:

1. **Refactors first** — they prep the code for the perf work
   without changing behaviour.
   - 14.5.5 (rmRecursive double-containment)
   - 14.5.6 (lstat-mode pre-check)
   - 14.5.7 (makePolicy parameter narrowing)
   - 14.5.8 (findLayout signature)
2. **Errno cleanup** — small, mostly-mechanical.
   - 14.5.10 (EISDIR)
   - 14.5.11 (isWindowsSymlinkRefusal parameter)
   - 14.5.12 (ENOTEMPTY)
3. **Perf** — done after refactors so they apply to clean code.
   - 14.5.3 (skip resolve)
   - 14.5.1 (normalised-root fields)
   - 14.5.4 (parent-dir LRU)
   - 14.5.2 (bounded-concurrency removeTree)
4. **Security / Windows polish**
   - 14.5.9 (symlink target containment)
   - 14.5.13 (\\?\ prefix)
5. **Coverage gap**
   - 14.5.14 (openWithNoFollow(write) DI test)

Each slice is a single conventional commit. Total expected: ~14 commits.

## 7. Mutation resistance

Each new branch must be exercised at both arms in isolation. Specific
attention:

- The `isAbsolute` gate in 14.5.3: tests for both `containsRelative`
  arms.
- The `cached ?? await …` short-circuit in 14.5.4: tests for hit and
  miss paths.
- The new EISDIR arm: both POSIX and Windows-mocked tests.
- The `\\?\` prefix-strip arms: tests for plain, `\\?\C:\…`,
  `\\?\UNC\server\share\…`, and POSIX (no-op).
- The symlink-target absolute branch: relative + in-tree absolute +
  out-of-tree absolute.

## 8. Open questions

None — every decision is locked by the §14.5 backlog text plus the
ADRs in §5. If any of those rationales prove wrong in implementation,
re-open the design before committing.
