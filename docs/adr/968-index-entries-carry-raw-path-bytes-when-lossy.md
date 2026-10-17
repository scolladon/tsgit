---
subjects:
  - src/domain/git-index/index-entry.ts
  - src/domain/git-index/index-parser.ts
  - src/domain/git-index/index-writer.ts
---
# 968 — Index entries carry raw path bytes when the path is lossy

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-226

## Context

git treats an index entry path as bytes: no UTF-8 validation. tsgit decodes it to a string, so a
non-UTF-8 name (`\xff.txt`, `b/\xc3`) becomes U+FFFD and is rewritten on the next tsgit index
write; the next commit's tree changes. Pinned against git 2.55 (design §D1, rows B1–B4).

## Options considered

1. **Optional `IndexEntry.pathBytes`**, present only when `path` does not re-encode to the raw
   bytes; writers emit it verbatim (the `TreeEntry.nameBytes` / `CacheTreeEntry.nameBytes`
   precedent) (recommended).
2. **Lossless escaped string** — invalid bytes decoded to lone surrogates `U+DC00+b`.
3. **Refuse** to write an index holding a non-round-tripping path (diverges from git).

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `pathBytes` is a fresh copy (`slice()`,
never a view on the index buffer), absent (not `undefined`) for paths that round-trip. Invariant:
`pathBytes === undefined` ⇔ `encode(path)` equals the on-disk bytes; any code that changes `path`
drops or recomputes `pathBytes`.

## Consequences

- An index with Latin-1 or other legacy-encoded names survives tsgit writes byte-exact.
- `IndexEntry` gains an additive public field (`reports/api.json` changes).
- `path` stays well-formed UTF-16; a lossy entry shows its U+FFFD view to string consumers.
