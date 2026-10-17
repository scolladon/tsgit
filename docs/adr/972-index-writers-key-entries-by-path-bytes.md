---
subjects:
  - src/domain/git-index/index-path-key.ts
---
<!-- cspell:ignore latin -->
# 972 — Index writers key entries by path bytes

> **Superseded by [ADR-981](981-lossy-path-keys-are-escaped-paths.md)** for the lossy key
> encoding: a lossy key is now its escaped path (`U+DC00 + byte` per invalid byte) instead of
> `'\0' + latin1(bytes)`. The branded key at every keyed site, an injective key and zero cost for UTF-8
> keys are carried forward.

- **Status:** superseded by ADR-981
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-226

## Context

Distinct byte paths can decode to the same string (`\xff.txt` and `\xef\xbf\xbd.txt`). Every
`Map`/`Set` keyed on `entry.path` then merges them: pinned against git 2.55 (rows C1–C3), a tsgit
`add` drops two of four entries and files one blob under the wrong name. git accepts such an index.

## Options considered

1. **A branded `IndexPathKey`** — `path` for a round-tripping entry, `'\0' + latin1(bytes)` for a
   lossy one — at every keyed site on an index-writing route (recommended).
2. **Refuse** an index whose entries decode to duplicate strings (diverges from git).

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** The key is injective (NUL never occurs in
a valid entry path) and free for UTF-8 paths. The brand makes the compiler reject a string lookup
at a converted site.

## Consequences

- Colliding decoded names keep distinct entries and blobs.
- A plain string (pathspec, working-tree path) never addresses a lossy entry; it cannot name one.
