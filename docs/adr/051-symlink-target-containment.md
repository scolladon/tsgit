# ADR-051: Symlink target containment — reject out-of-tree absolutes, accept relatives unconditionally

## Status

Accepted (at `50e6eed`)

## Context

`NodeFileSystem.symlink(target, path)` currently contains the link
*entry* (via `checkContainment(path, 'creation')`) but passes the
`target` argument unchanged to `fsPromises.symlink`. This is the
gap §14.5.9 closes.

The attacker model:

1. A malicious git tree contains a tree entry of mode `120000`
   (symlink) with content `/etc/passwd`.
2. A clone of that tree calls `repo.checkout()`.
3. `checkout` calls `fs.symlink('/etc/passwd', '/root/exfil-link')`.
4. The link entry is correctly inside `/root` — `checkContainment`
   passes.
5. Subsequent calls to `fs.readlink('/root/exfil-link')` return
   `/etc/passwd` to the caller. The path string is leaked into the
   tsgit caller (e.g., a status report).

This is an information oracle, not a read primitive — tsgit's `read`
and `stat` paths still re-`realpath` and re-`checkContainment` on the
resolved leaf, so they cannot follow the symlink out of `rootDir`.
But the leak of arbitrary filesystem paths through `readlink` is a
distinguishable security hardening gap.

The fix is to validate `target` at symlink-creation time. Three
policy options:

1. **Reject all absolute targets.** Maximally strict. Breaks legitimate
   absolute symlinks (rare in git working trees but legal).
2. **Reject absolute targets that escape rootDir.** Allow absolute
   symlinks that resolve inside the tree; reject those that don't.
   Matches `checkContainment`'s logic for the link entry itself.
3. **Reject all symlinks unless explicitly allowed.** Maximally
   restrictive; would break checkout of any repository containing
   symlinks. Out of scope.

Option 2 mirrors the existing containment invariant (a link entry
can land anywhere inside the tree; a link target can point anywhere
inside the tree). Relative targets are inherently constrained by
where the link entry lives (they're resolved against the link's
directory at OS-read time); subsequent `read`/`stat` calls
re-realpath the leaf and re-check containment, so a relative
`../escape` target either resolves outside rootDir (caught by the
follow-up read's containment check) or stays inside (legitimate).

Git's own response to CVE-2018-17456 and CVE-2022-39253 is the
direct analogue: those CVEs were absolute-symlink attacks against
submodule worktrees. Git's defence is to validate absolute targets
against the worktree root at checkout time.

## Decision

`NodeFileSystem.symlink(target, path)` rejects absolute targets that
resolve outside rootDir (after `policy.resolve(target)` normalises
`..` and `.` segments). Relative targets pass unconditionally.

Check against BOTH `this.rootDir` (the raw root) AND
`getCanonicalRoot()` (the long-name canonical root) — same dual gate
as `checkContainment`, so an attacker cannot construct an absolute
target that uses the 8.3 short-name parent to slip past one
comparison while failing the other.

```ts
symlink = async (target: string, path: string): Promise<void> => {
  if (this.pathPolicy.isAbsolute(target)) {
    const normalised = this.pathPolicy.resolve(target);
    const canonicalRoot = await this.getCanonicalRoot();
    if (
      !pathContains(this.rootDir, normalised, this.pathPolicy) &&
      !pathContains(canonicalRoot, normalised, this.pathPolicy)
    ) {
      throw permissionDenied(path);
    }
  }
  // …existing checkContainment + fsOps.symlink path
};
```

`policy.resolve(target)` is load-bearing: a raw `pathContains` is a
prefix check, so `/root/../etc/passwd` would pass containment against
`/root` without normalisation. `resolve` collapses the `..` so the
comparison sees `/etc/passwd`.

The error code is `PERMISSION_DENIED`, consistent with the rest of
`NodeFileSystem`'s containment failures.

## Consequences

### Positive

- Closes the absolute-symlink info-oracle. A malicious git tree can
  no longer plant a `/etc/passwd`-style symlink that `readlink`
  exfiltrates.
- Mirrors the existing containment policy — no new mental model.
- Aligns with Git's own hardening response to symlink CVEs.

### Negative

- Legitimate absolute symlinks pointing outside the worktree are
  now rejected. Rare in practice (git's own `checkout` doesn't
  produce these; they exist mostly in hand-crafted repositories).
  Trade-off accepted.
- One extra `policy.resolve(target)` call + one extra
  `getCanonicalRoot()` (cached) on every absolute-target symlink.
  Negligible.

### Neutral

- The check fires only for absolute targets. Git tree symlinks are
  conventionally relative, so the common path pays nothing.
- Browser / memory adapters do not have symlinks; this policy is
  Node-adapter-only.
- A future "Windows symlink target on different drive" case is
  handled correctly because `pathContains` already uses
  `policy.sep` and the drive prefix.
