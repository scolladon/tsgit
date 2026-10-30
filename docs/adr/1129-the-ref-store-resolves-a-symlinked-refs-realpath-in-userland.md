---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/internal
---
# 1129 — the ref store resolves a symlinked ref's realpath in userland

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D9) · **Supersedes/Refines:** refines ADR-874 and ADR-1126

## Context

git names a symlinked ref's referent by the link's realpath with the `<gitdir>/` prefix removed. The
`FileSystem` port has no `realpath`, and Node's `fs.realpath` refuses a missing final component that
git keeps.

## Options considered

1. **A userland resolver over `lstat` + `readlink`** (designer's recommendation): per component, at
   most 32 hops, a missing final component kept, a missing earlier one `FILE_NOT_FOUND`; the gitdir
   resolved by the same function — pros: every adapter, no port change, free without symlinked refs.
2. **An optional port `realpath`** — cons: widens the port, memory and browser lose the check, and
   Node's semantics differ from git's.
3. **Lexical normalisation** — cons: wrong across linked components (`/var` → `/private/var`) and blind
   to hop chains.

## Decision

**Ratified by the user: option 1.** A pure-composition resolver under
`src/application/primitives/internal/` computes git's realpath with `lstat` and `readlink` only, with
git's 32-hop cap, keeping a missing final component and failing `FILE_NOT_FOUND` on a missing earlier
one or `SYMLINK_LOOP` past the cap. The referent is that realpath relative to the resolved gitdir, or
absolute when outside it.

## Consequences

- No `FileSystem` port change.
- Its failures feed ADR-1128's terminal finding.
