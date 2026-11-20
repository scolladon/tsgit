---
subjects:
  - src/application/primitives/read-sparse-config.ts
  - src/application/primitives/read-executable-bit-trust.ts
---
<!-- cspell:ignore filemode -->
# 1229 — core.fileMode is read from local and the worktree file through the sparse overlay

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/core-filemode-false.md (D-A, R1) · **Supersedes/Refines:** refines ADR-1184

## Context

Nothing on the `add` / `status` / checkout paths reads `core.fileMode`. git takes it from
`config.worktree` (when `extensions.worktreeConfig` is on) over local, the last valid entry in
each file winning, default true (pinned rows C1, C2, C2b, C2c, C2d, C7). The sparse reader already
overlays local config with the active worktree file key by key, through `sparseKeyEntries`.

## Options considered

1. A new reader with its own one-key `[core]` filter.
2. **Generalise `sparseKeyEntries` into one `[core]` key filter shared by the sparse reader and a
   new `readExecutableBitTrust` reader** (recommended).
3. Make `readConfig` layered, closing ledger entry 32.62 for every key.

## Decision

Option 2, **adopted-as-recommended (no user judgment)** — no trade-off: options 1 and 2 differ only
in mechanics, and option 3 changes every typed key's scope, outside the perimeter. The reader
returns a two-member union `ExecutableBitTrust = 'trusted' | 'ignored'`, never a boolean. Global
and system scopes stay unread (ADR-182 containment); 32.62 is narrowed to the keys other than
`core.fileMode`.

## Consequences

One overlay rule and one filter serve both readers. The sparse mover judge switches to the new
reader, so its fileMode case of 32.62 is closed too.
