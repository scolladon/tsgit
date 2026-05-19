# ADR-043: Errno mapping placement — `ELOOP` first-class in `mapErrno`, Windows symlink discriminator local to `openWithNoFollow`

## Status

Accepted (at `963a72b`)

## Context

The Node adapter's `mapErrno` translates `NodeJS.ErrnoException` codes to
`TsgitError` variants. Before Phase 14.4 it covered `ENOENT`, `EEXIST`,
`ENOTDIR`/`ENOTEMPTY`, `EACCES`, `EPERM`; everything else fell to a
`UNSUPPORTED_OPERATION { reason: <errno> }` default.

`openWithNoFollow` then rewraps `UNSUPPORTED_OPERATION { reason: 'ELOOP' }`
to `PERMISSION_DENIED` to give the symlink-refusal contract a single
cross-platform code. This works on POSIX. On Windows the refusal errno is
sometimes `EACCES` or `EPERM` (NOT `ELOOP`); the rewrap misses it, and
`O_NOFOLLOW`-refused opens surface as `PERMISSION_DENIED` for genuine
symlink leaves but the test fails when the user supplied a regular file
with no access (we don't want to absorb that case).

Two placements for the fix:

1. **Push everything into `mapErrno`.** Add `ELOOP → permissionDenied` and
   add Windows-specific arms that distinguish symlink from non-symlink
   leaves. Rejected: `mapErrno` is errno-keyed and has no information
   about the leaf type. To add the lstat-result discrimination here we
   would have to pass an additional parameter — turning a pure lookup
   function into a stateful one — or read the disk a second time.
2. **Add `ELOOP` to `mapErrno`; keep the Windows symlink discriminator
   inside `openWithNoFollow`.** `ELOOP` is unambiguous (always means
   symlink loop refusal across every platform Node supports). The
   Windows ambiguity is genuinely call-site-local: only
   `openWithNoFollow` has the pre-open `lstat` result available to tell a
   symlink apart from a real EACCES case.

Option 2 matches the responsibilities cleanly: `mapErrno` stays a pure
errno-to-TsgitError lookup; the discriminator stays where its inputs
(`isSymlinkLeaf`, the post-open error) are visible.

## Decision

- Add a new `case 'ELOOP': return permissionDenied(path);` arm to
  `mapErrno`. Drop the previously-load-bearing `data.reason === 'ELOOP'`
  rewrap in `openWithNoFollow` (it becomes dead code after the new arm).
- Inside `openWithNoFollow`, on Windows ONLY, pre-`lstat` the resolved
  path. If the post-open error is `PERMISSION_DENIED` /
  `UNSUPPORTED_OPERATION` AND the leaf is a symlink, rewrap as
  `permissionDenied(path)`. If the leaf is NOT a symlink, the original
  error surfaces unchanged.
- The discriminator is gated by `isWindows()` so POSIX behaviour is
  unchanged.

## Consequences

### Positive

- `mapErrno` stays a single switch — easy to read, easy to test, easy
  to mutate-prove.
- The Windows discriminator lives where its information lives. No need
  to pass the leaf type into `mapErrno`.
- A real `EACCES` on a regular Windows file still surfaces as
  `PERMISSION_DENIED` (already covered by `mapErrno`'s `EACCES` arm).
  The new discriminator only rewraps the cases where genuine errno
  ambiguity exists.

### Negative

- Two places to read when investigating a Windows symlink test failure
  (`mapErrno` for the generic mapping, `openWithNoFollow` for the
  refusal discriminator). The design doc (§3.3) calls this out
  explicitly.
- The pre-open `lstat` adds one disk hit per `openWithNoFollow` call on
  Windows. Acceptable — `openWithNoFollow` is not a hot path (used by
  pack writes and a handful of guarded reads).

### Neutral

- ADR-042's cached canonical root is independent: `lstat` of the
  resolved path is not the same call as `realpath` of the rootDir.
