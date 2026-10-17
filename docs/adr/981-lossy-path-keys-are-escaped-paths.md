---
subjects:
  - src/domain/git-index/index-path-key.ts
  - src/domain/diff/flat-tree.ts
supersedes:
  - adr: "972"
    scope: "the NUL-prefixed latin1 encoding of a lossy entry's key"
---
<!-- cspell:ignore latin -->
# 981 — Lossy path keys are escaped paths

- **Status:** accepted
- **Date:** 2026-10-16
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** supersedes ADR-972 (key encoding)

## Context

Two injective keys existed for a lossy path: the index writers' `'\0' + latin1(bytes)` and the
escaped path the merge engine and pathspecs use (each invalid byte becomes `U+DC00 + byte`). The
NUL-prefixed key breaks directory structure (`\0d/\xff` sits under `\0d`, not `d`), so the merge
engine cannot use it. The escaped path is injective too: valid UTF-8 never decodes to a lone
surrogate.

## Options considered

1. **Unify on the escaped path** — `indexPathKey` returns it; one scheme everywhere.
2. Keep both and convert where the index meets the merge engine (designer recommendation).
3. Use the NUL-prefixed key in the merge engine too.

## Decision

**User-ratified — option 1.** A lossy path's key is its escaped path; a round-tripping path is its
own key, as before.

Superseded from ADR-972: the `'\0' + latin1(bytes)` encoding of a lossy key.

Carried forward from ADR-972: the branded `IndexPathKey` at every keyed site on an index-writing
route, an injective key, zero cost for UTF-8 keys, and string lookups that never address a lossy entry.

## Consequences

- One key scheme; an ancestor key is a plain `/` split of the key.
- No conversion code between index writers and the merge engine.
