---
subjects:
  - src/adapters/browser
  - src/ports/file-system.ts
---
# 925 — Browser freshen fails and falls back to a local write

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-13) · **Supersedes/Refines:** refines ADR-922

## Context

ADR-922 freshens an existing copy by setting its mtime through `FileSystem.utimeNow`. OPFS
exposes `File.lastModified` read-only; the only way to move it is to rewrite the file.

## Options considered

1. **The browser adapter omits `utimeNow`; every freshen fails and git's own fallback runs (write a local loose copy)** (recommended).
2. **A no-op that reports success** — cons: claims a freshen that never happened; no prune protection.
3. **Rewrite the file** — cons: costs the whole pack size per hit.

## Decision

**User-ratified — option 1.** On an adapter without `utimeNow` (browser, or a user `opts.fs`
that omits it), freshen reports failure and `writeObject` writes a local loose copy, exactly
git's path when `utime` fails.

## Consequences

- In the browser, writing an object already held packed produces a loose duplicate (today's behaviour already); an object already loose is not rewritten (exclusive write finds it present).
