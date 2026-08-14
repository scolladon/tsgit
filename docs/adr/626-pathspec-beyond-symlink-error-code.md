# 626 — `add` beyond a symbolic link gets its own error code

- **Status:** accepted
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md (DC-4) · **Supersedes/Refines:** refines the discriminated-union error vocabulary

## Context

Git refuses `git add dir/file` when a leading component of the pathspec is a symbolic
link (`fatal: pathspec 'dir/file' is beyond a symbolic link`) — the only read-shaped
refusal in the pinned symlink matrix, and it is shape-based: it fires for intra-repo
symlinks too. tsgit today refuses this **by accident**: the adapter's lstat-mode
containment throws `PERMISSION_DENIED`, which `add.ts` swallows in a
`.catch(() => undefined)`, degrading the observable to `PATHSPEC_NO_MATCH`. The read
relaxation (ADR-625) removes that accidental path entirely, and the swallow violates the
no-swallowed-errors guardrail regardless.

## Options considered

1. **A new `PATHSPEC_BEYOND_SYMLINK` code carrying the pathspec** (design
   recommendation) — a dedicated condition callers can branch on, matching git's
   dedicated fatal.
2. Keep `PATHSPEC_NO_MATCH` — today's accidental shape, made deliberate; conflates two
   distinct conditions.
3. Reuse `PERMISSION_DENIED` — wrong meaning: this is not a containment escape (it fires
   for intra-repo symlinks).

## Decision

**adopted-as-recommended (no user judgment).** Option 1. An explicit leading-component
symlink scan lives in the shared pathspec-resolution module (`resolve-pathspec.ts`),
memoised per directory across one pathspec set — git's `has_symlinked_leading_path` +
`lstat_cache` equivalent. It throws `PATHSPEC_BEYOND_SYMLINK` with the offending
pathspec in its data. The two `.catch(() => undefined)` swallows in `add.ts` are
removed.

## Consequences

- New public error code → `reports/api.json` regeneration and the errors doc page gate
  this PR (surface gates).
- The refusal is now deliberate, tested per guard condition, and byte-equivalent to
  git's refusal condition (not its message bytes — ADR-249).
- The refusal is `add`-only, matching git: `has_symlinked_leading_path` is git's
  pathspec-validation refusal, and git raises it there and nowhere else. `mv` and
  `blame` do not import `resolve-pathspec.ts` and gain no new refusal from this ADR.
