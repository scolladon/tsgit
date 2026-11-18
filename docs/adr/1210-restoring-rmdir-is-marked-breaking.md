---
subjects:
  - src/repository/wrap-fs-validator.ts
---
# 1210 — Restoring rmdir is marked breaking

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/gitlink-rmdir-keeps-occupant.md · **Supersedes/Refines:** applies ADR-1190

## Context

Once the wrapper forwards `rmdir` (ADR-1205), one more consumer changes: with
`.git/logs/refs/heads/x` a symlink to an empty directory and `core.logAllRefUpdates=true`, git
2.56.0 refuses `branch x` (`there are still logs under '.git/logs/refs/heads/x'`, exit 128).
tsgit today replaces the symlink and returns; after the fix it throws `DIRECTORY_NOT_EMPTY`, as
git refuses. A returning call that now throws is breaking under doctrine D-3.

## Options considered

1. **Mark the commit that forwards `rmdir` `fix!`**; every other commit stays `fix`.
2. **`fix` throughout** — the trigger is exotic; would be D-3's first counter-case.

## Decision

**ratified by the user** — option 1, per DOCTRINE(D-3) and the ADR-1190/ADR-1204 precedent.

## Consequences

The release bumps a major. The changelog names the symlinked-reflog-directory refusal.
