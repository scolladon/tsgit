---
subjects:
  - src/application/primitives/ref-store.ts
  - src/domain/refs/loose-ref.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/application/commands/internal/fsck/types.ts
---
# 1126 — the adjacent loose-ref gaps fold into the broken-chain change

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D6) · **Supersedes/Refines:** refines ADR-226 and ADR-874

## Context

Pinning the brief's shapes on git 2.56.0 surfaced five neighbouring gaps, each proven by a twin
probe on `main`: (1) a `refs/heads/d/` directory with mode 000 makes the shared loose-ref walk
throw `PERMISSION_DENIED`, where `git fsck` prints
`warning: error opening directory '.git/refs/heads/d/': Permission denied` and exits 0 and
`for-each-ref`, `branch`, `show-ref` and `rev-list --all` skip it silently; (2) a symlinked loose
ref whose link text is not a valid name gets `badReferentName` on the link text beside
`symlinkRef` (exit 10), tsgit reports `symlinkRef` only; (3) a direct body in upper-case hex or
`<sha> garbage\n` resolves in git (the latter with a `trailingRefContent` warning), tsgit reports
`badRefContent`; (4) `trailingRefContent` and (5) `refMissingNewline` are catalogued warnings
(no exit bit) tsgit never emits. The design recommended leaving them out of scope.

## Options considered

1. **Out of scope: IMPACT lines, the user decides whether to file them** (designer's
   recommendation) — pros: a smaller PR / cons: five proven divergences stay open on the surface
   this change rewrites.
2. **Fold all five now** — pros: one pass over the loose-ref grammar and the walk / cons: the diff
   reaches the shared walk, link-text handling and resolution for every command.

## Decision

**Ratified by the user: option 2, reversing the design's recommendation.** This change also
delivers, each pinned against git 2.56.0 in the revised design: (1) the shared loose-ref walk skips
an unreadable directory for every listing command, and fsck reports it as a finding, gone under
`--no-references`; (2) a symlinked loose ref whose link text fails the referent check reports
`badReferentName` beside `symlinkRef`, with `referent` = the link's realpath with the `<gitdir>/` prefix removed (the absolute realpath when it lies outside the gitdir), as the revised design's link rows pin (git does not report the link text), and a link onto an
unreadable file keeps its pointer only; (3) a direct body accepts upper-case hex and trailing
content after the oid as git does; (4) `trailingRefContent` and (5) `refMissingNewline` are
emitted as warning findings with no exit bit. The revised design fixes each finding's shape; a
shape that needs a further choice returns to the decisions flow before planning.

## Consequences

- The five IMPACT lines are folded, none is filed.
- Two further findings in the same verify and walk are folded too: every root ref's body is checked, not only `HEAD`'s, and resolving a name whose loose path crosses an unreadable directory reads it as missing, ignoring the packed value, as git does.
- Every command that lists or resolves refs runs its interop family in the gate (lesson 015).
- Review covers the shared walk's callers, not only fsck.
