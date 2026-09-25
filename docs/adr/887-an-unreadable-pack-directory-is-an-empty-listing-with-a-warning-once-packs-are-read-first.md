---
subjects:
  - src/application/primitives/pack-registry.ts
  - src/application/primitives/object-resolver.ts
  - src/application/primitives/internal/blob-source.ts
---
# 887 — An unreadable pack directory is an empty listing with a warning once packs are read first

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D5, DC-7) · **Supersedes/Refines:** refines ADR-720 (lazy pack lookup)

## Context

The buffered object resolver probes the loose store before the pack registry, which costs a
`readdir` per fanout directory (255 under one `log`) before the first pack lookup. Pinned on git
2.55.0 with a fake loose object planted at a packed object's id: size and type queries and every
buffered read (diff, grep, blame, log, tree reads) take the **pack** copy, while a small blob
streamed to output (`cat-file -p`, `show`, `checkout`) takes the **loose** copy. Reading packs
first in the buffered resolver is therefore faithfulness-positive, and `openBlobSource` keeps its
loose-first order. Pack-first puts the `objects/pack` listing in front of every loose read.
Today `PERMISSION_DENIED` on that listing propagates only to `all()` / `lookup()`, so a loose read
survives an unreadable pack directory by accident of order. Git's pinned shape: an `error:` line,
loose objects still served, packed ones reported as not a valid object name.

## Options considered

1. **Fold every listing fault into an empty listing plus a `logger.warn` carrying the fault**
   — pros: git's shape on every pinned row; loose reads never depend on the pack directory /
   cons: a packed object behind an unreadable directory reports `OBJECT_NOT_FOUND`, as git does.
   *Recommended by the design.*
2. **Catch on the pack-first arm, try loose, rethrow the listing fault on a loose miss** — cons:
   keeps a tsgit-only `PERMISSION_DENIED` for packed objects that git never reports.
3. **Propagate** — cons: loose reads start refusing; a regression against today and git.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** `resolveObjectContentWithDepth`
consults the pack registry before the loose store; `openBlobSource` keeps loose first. The pack
registry folds every fault of the `objects/pack` listing (`FILE_NOT_FOUND` and
`NOT_A_DIRECTORY` as today, `PERMISSION_DENIED` and any other errno newly) into an empty listing
and reports it once through `ctx.logger?.warn` with the fault attached. Loose objects are served;
a packed object then refuses `OBJECT_NOT_FOUND`. The `multi-pack-index`-as-directory divergence
(git dies, tsgit discards the file) is recorded and unchanged.

## Consequences

- The cold packed read stops paying a loose fanout listing per lookup; one shared pack-directory
  listing answers pack, midx and chain presence.
- A new interop suite pins the precedence matrix (buffered pack-first, streamed loose-first) and
  the unreadable-directory rows; the latter are posix-only and skipped as root.
- Consumers that want to notice a broken pack directory attach a logger; the read path itself
  never surfaces it as a refusal.
