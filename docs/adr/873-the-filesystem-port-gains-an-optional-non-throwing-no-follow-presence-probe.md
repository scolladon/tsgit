---
subjects:
  - src/ports/file-system.ts
  - src/application/primitives/internal/path-occupied.ts
  - src/repository/wrap-fs-validator.ts
  - src/adapters/node/node-file-system.ts
  - src/adapters/memory/memory-file-system.ts
  - src/adapters/browser/browser-file-system.ts
---
# 873 — The `FileSystem` port gains an optional non-throwing no-follow presence probe

- **Status:** accepted
- **Date:** 2026-09-15
- **Design:** docs/design/session-caches-faithfulness-addendum.md · **Supersedes/Refines:** refines ADR-705

## Context

`pathIsOccupied` answers "does any entry, a symbolic link included, stand at this working-tree
path" for `applyChangeset`'s dirty and untracked-clash checks and for `stash`'s untracked-restore
overwrite check. It must not follow the leaf, so it cannot use `exists`; it called `lstat` and read
`FILE_NOT_FOUND` as absence. Every absent path therefore built and threw a `TsgitError`, and a
checkout that adds files probes one absent path per added file.

Measured locally (macOS, Node 22.22.3, 100,000 sequential probes of absent paths in an existing
directory, two rounds with matching results):

| Adapter | `lstat` + catch | `lexists` |
|---|---|---|
| Node | 1,560 ms | 1,210 ms |
| Memory | 410 ms | 50 ms |

On Node the operating system's own `ENOENT` rejection remains, so the probe removes only the
library's refusal on top of it; on the memory adapter the refusal was the whole cost. The browser
adapter's `lstat` is its `stat`, which walks the parent chain twice and raises two refusals for an
absent path.

## Options considered

1. **An optional `lexists` on the port, with `pathIsOccupied` falling back to `lstat` and a
   `FILE_NOT_FOUND` catch where it is absent** (chosen) — pros: additive, so a third-party adapter
   keeps compiling and keeps working through the fallback; the three first-party adapters each
   answer without a refusal. Cons: one more member on the port, and a second code path in its one
   caller.
2. **Keep the `lstat` catch alone** — pros: no port change. Cons: every absent path keeps paying
   for a refusal it immediately discards, on the checkout path that probes one per added file.
3. **A required `lexists`** — pros: one code path. Cons: breaks every third-party `FileSystem`
   implementation for an optimisation, and the fallback answers identically anyway.

## Decision

**Option 1.** `FileSystem` gains an optional `lexists(path)`: it resolves `false` exactly where
`lstat` refuses `FILE_NOT_FOUND`, resolves `true` wherever `lstat` resolves, a dangling link
included, and rejects with every other refusal `lstat` raises. That contract makes the fallback
equivalent, so omitting the method changes cost and never the answer. This follows ADR-705's
`atomicRename`: an optional capability whose absence is a documented answer.

The Node adapter probes through `fs.lstat` and reads `ENOENT` as absence, sharing one helper with
`exists`, which probes through `fs.stat`. The memory adapter resolves the path without following the
leaf and checks its entry maps. The browser adapter walks the parent chain once and looks the leaf
up once, reading a directory occupant (`TypeMismatchError`) as present and every other rejection as
absent, as its `lstat` does.

## Consequences

- `wrapFsValidator` forwards `lexists` only when the wrapped adapter provides it, guarded as a read
  surface and invoked on the adapter itself, because a class-based adapter's method reads its own
  receiver. Without the forwarding, every repository opened through the validating wrapper would
  silently take the fallback.
- `reports/api.json` changes with the port, and its regeneration is owed with this change.
- Third-party adapters are unaffected: they compile unchanged and `pathIsOccupied` answers through
  `lstat` for them.
- A test double that spreads a first-party adapter and overrides `lstat` to shape a presence answer
  no longer reaches `pathIsOccupied`; such a double overrides `lexists` instead, or removes it to
  exercise the fallback.
