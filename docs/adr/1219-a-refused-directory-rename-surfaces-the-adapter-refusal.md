---
subjects:
  - src/application/commands/internal/working-tree.ts
---
# 1219 — A refused directory rename surfaces the adapter's refusal

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (D3) · **Supersedes/Refines:** extends ADR-1194

## Context

`mv d D` on a case-insensitive host: git's `rename(d, D/d)` fails `EINVAL` and git exits 128 with
nothing changed. The node adapter's one-step rename refuses the same arrangement with
`UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'EINVAL' }`, already documented in
`docs/use/errors.md` for a directory renamed into itself.

## Options considered

1. **Propagate the adapter's refusal unchanged; `PATH_TOO_LONG` keeps ADR-1194's relabel to the
   repo-relative destination.**
2. Relabel `EINVAL` to `MV_INTO_SELF` — a refusal git does not make here (its into-self check is
   case-exact), keyed on a free-text `reason`.
3. A new `MV_RENAME_FAILED { source, destination, reason }` — a union member ADR-1194 already
   declined for one errno.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-1194: an execution-time rename refusal other
than a too-long name rethrows the adapter's own error.

## Consequences

The one-step rename's `PATH_TOO_LONG` names the repo-relative destination directory. The
absolute-source `PATH_TOO_LONG` of rows 1–3 can no longer arise on node or memory, because no
descendant is read.
