# ADR-208: working-tree-vs-index comparison includes mode (not content-only)

## Status

Accepted (at `ab29483559bfb1b06f1d7810f084d89e3f84deef`)

## Context

`rm`'s `local` check (ADR-207) asks "does the working file differ from its index
entry?". `status`'s existing `isModified` answers a near-identical question but
**content-only** — it hashes the file and compares to `entry.id`, ignoring mode.
Verified against git 2.54.0: a working-tree-only mode change (`chmod +x` with no
`git add`) is refused by `git rm` as *"local modifications"* and shown by
`git status` as modified — git compares mode bits (`ie_match_stat`), not just
content.

Two ways to detect a local change:

- **Content-only** (what `status` does today). Misses working-tree-only mode
  changes. Cross-adapter-safe (memory/OPFS don't surface an exec bit).
- **Content + working-tree mode.** Faithful to git. On adapters without an exec
  bit, the derived working mode and the index mode are both produced from the
  same adapter, so they stay consistent — no false positives; the check simply
  cannot observe a mode change the adapter cannot represent.

## Decision

Detect a local change by **content and working-tree mode**: the working file is
"modified" iff `deriveWorkingMode(stat) ≠ entry.mode` **or**
`hashBlob(symlinkAwareRead) ≠ entry.id`. Working mode is derived exactly as
staging derives it (`isSymbolicLink ? 120000 : (mode & 0o111) ? 100755 : 100644`).
Staged changes (index vs HEAD) likewise compare `(id, mode)`.

## Consequences

### Positive

- `git rm` and (via ADR-209) `git status` now match git on mode-only changes.
- Mode derivation is shared with `add` — one definition of "working file → git
  mode".

### Negative

- A working-file read + hash per matched entry on the no-`force` path (same cost
  `status` already pays; `force` short-circuits it for `rm`).

### Neutral

- On memory/OPFS the mode comparison is a no-op (consistent fixed mode on both
  sides), so behaviour is identical to content-only there. The faithfulness gain
  is realised on Node.
- Symlink content is read via `readlink` (target bytes), not by following the
  link — more faithful than the content-only readers it replaces.

## Alternatives considered

- **Content-only** (keep `status`'s current basis). Rejected: diverges from
  `git rm` / `git status` on mode-only changes, and the cross-adapter concern is
  moot because mode is derived consistently per adapter.
