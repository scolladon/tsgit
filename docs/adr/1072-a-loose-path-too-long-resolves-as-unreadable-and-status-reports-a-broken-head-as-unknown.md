---
subjects:
  - src/adapters/node/node-file-system.ts
  - src/domain/error.ts
  - src/application/primitives/resolve-ref.ts
  - src/application/commands/status.ts
---
# 1072 — A loose path too long resolves as unreadable, and `status` reports a broken HEAD as unknown

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** refines ADR-1063

## Context

The design's SF11 row (a submodule whose HEAD names a 5000-digit branch) could not land: tsgit's
`status` rejects `UNSUPPORTED_OPERATION` (`ENAMETOOLONG`) from the loose-ref probe, on a plain
repository as much as inside a submodule's child status (design rows LH1–LH7). git 2.55 `lstat`s
the loose path, treats any errno other than `ENOENT` as "does not resolve" without reading
`packed-refs`, and `status` then reports `# branch.head (unknown)` with every index entry as a
staged add, exit 0; `log` and `rev-parse` refuse. The node adapter maps `ENAMETOOLONG` to the
catch-all `UNSUPPORTED_OPERATION`, which no reader can tell from a real unsupported operation,
and `status` has no shape for a HEAD that is neither a branch, detached, nor unborn. The user
chose to fold the fix into this change as an inserted part rather than leave the gap.

## Options considered

1. **Name the errno, treat it as unreadable, and give `status` the broken-HEAD state** — the
   orchestrator's recommendation. `mapErrno` gains `ENAMETOOLONG` → `PATH_TOO_LONG { path }`;
   `UNREADABLE_REF_CODES` gains the code so every for-reading resolution answers git's NULL while
   `resolveRef` still refuses; `status` reports `branch: undefined, detached: false` and an
   initial tree when HEAD's target is unreadable. Pros: three small edits, one new union member,
   git's shape on every pinned row. Cons: one more public code; `status` gains a third HEAD state.
2. **Treat the fault as a missing ref** — `status` would report the over-long branch name where
   git reports none, and `log` would call the branch unborn where git calls it broken.
3. **Add a `broken` kind to `ResolveDirectResult`** — forces every ref-store consumer to handle
   a kind only this errno produces; the reading set already models "git returns NULL".

## Decision

**Adopted as recommended (no user judgment on the shape; the user ratified folding the fix) —
option 1.** A ref whose loose path cannot be stat-ed for length is unreadable: for-reading
resolution answers absent, writing and committing resolution refuse with `PATH_TOO_LONG`.
`status` reports an unreadable HEAD target as broken — `branch: undefined`, `detached: false`,
no head tree — the structured form of git's `(unknown)`; an unborn target keeps its name. The
same `status` rule applies to every code in the unreadable set (an invalid target name, a
symref cycle), pinned git-first in the part that lands it.

## Consequences

- `PATH_TOO_LONG` joins the adapter error union, its message switch, the exhaustiveness switch
  and the error table; the memory and browser adapters never raise it.
- `log` and `rev-parse` over a broken HEAD refuse with `PATH_TOO_LONG`, a refusal where git
  refuses; git's message is not reproduced (ADR-249).
- `checkout`, `commit` and `branch` over a broken HEAD are not pinned here; git dies at lock time
  with the same errno, and tsgit's write path surfaces the same fault.
