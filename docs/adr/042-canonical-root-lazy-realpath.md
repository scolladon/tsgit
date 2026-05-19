# ADR-042: 8.3 short-name canonicalisation via lazy `realpath` cache on `NodeFileSystem`

## Status

Accepted (at `963a72b`)

## Context

On a Windows CI runner, `mkdtemp` produces paths under an 8.3 short-name
parent (`C:\Users\RUNNER~1\AppData\Local\Temp\…`). Node's
`fsPromises.realpath` MAY expand the short-name parent to its long-name
form (`runneradmin`) and MAY NOT, depending on which Win32 API path the
underlying call chose. The result is that `realpath(child)` and
`this.rootDir` may disagree on the spelling of a shared ancestor segment,
breaking `child.startsWith(rootDir + sep)` even when `child` is
genuinely inside `rootDir`.

The containment check in `NodeFileSystem.checkContainment` and
`NodeFileSystem.exists` is a security invariant from Phase 11 (Phase 10
design §5.2.1). It MUST hold on every platform.

The fix is to canonicalise both sides to the same form. Three placement
options:

1. **Sync, constructor-time.** Add a sync `realpath` at construction.
   Rejected: `fsPromises.realpath` is async-only, and `fs.realpathSync`
   would force an extra disk hit on every `new NodeFileSystem()` even on
   POSIX where the cache is unnecessary.
2. **Async factory** (`NodeFileSystem.create(rootDir)`). Rejected: the
   public adapter API ships an importable class; converting to a factory
   is a non-trivial breaking change for users who construct adapters by
   hand (Phase 10 design §3 contracts a class).
3. **Lazy `Promise<string>` cache on the instance.** First call into a
   containment-checking method canonicalises; subsequent calls reuse
   the cached promise. Rejection clears the cache so a transient
   `ENOENT` can be retried.

Option 3 keeps the class-based constructor contract intact, defers the
realpath cost to the first I/O operation (where the user already pays a
disk hit), and de-duplicates concurrent first calls because a `Promise`
naturally fans out.

## Decision

Add `private canonicalRootPromise: Promise<string> | undefined = undefined`
to `NodeFileSystem`. Expose a `private getCanonicalRoot()` method that
seeds the promise on first call via `fsPromises.realpath(this.rootDir)`
and shares the resulting promise on subsequent calls. On rejection, the
promise is cleared so the next caller retries. The containment check
runs `pathContains(canonicalRoot, abs)` (per design §3.2) which
case-folds on Windows and short-circuits identity comparison.

## Consequences

### Positive

- POSIX behaviour is bit-identical: `realpath` of an already-canonical
  rootDir on POSIX is the same string, and `normalizeForCompare` is the
  identity on POSIX.
- One realpath per `NodeFileSystem` lifetime — paid lazily.
- Cache-coherency is trivial: the rootDir is immutable for the adapter's
  lifetime by construction.

### Negative

- The `getCanonicalRoot()` call sites add one `await` to the hot path.
  Negligible — `realpath` on a cached value resolves synchronously after
  the first call (the promise has already settled).
- A bug in `realpath` (or a TOCTOU-deleted temp dir) propagates to the
  first caller. The reset-on-rejection rule allows recovery; the
  user-facing error is the underlying errno mapped via `mapErrno`.

### Neutral

- The static class fields used elsewhere in this codebase set a precedent
  for instance-level state; this addition follows the same pattern.
- A future "shared canonical root cache" across `NodeFileSystem` instances
  is intentionally not built — there's no measured need.
