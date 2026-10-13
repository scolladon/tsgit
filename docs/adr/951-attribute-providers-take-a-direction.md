---
subjects:
  - src/application/primitives/internal/read-gitattributes.ts
  - src/application/primitives/apply-changeset.ts
  - src/application/commands/add.ts
  - src/application/commands/archive.ts
---
# 951 — Attribute providers take a direction

- **Status:** accepted
- **Date:** 2026-10-12
- **Design:** docs/design/eol-conversion.md · **Supersedes/Refines:** refines ADR-302

## Context

git's `attr.c` reads `.gitattributes` from a source that depends on the operation's direction,
pinned in §D1.7 of the design: **check-in** (add, worktree comparison, stash push, blame, path
restore) reads the worktree file and falls back to the index blob; **checkout** (switch,
`reset --hard`, merge-family writes, clone, sparse apply) reads the result-index blob and falls
back to the worktree; **tree** (archive) reads the archived tree. A switch that introduces a
`.gitattributes` converts with the new rules; a `reset --hard` ignores a worktree edit of the
file. tsgit's provider reads the worktree only, plus a separate tree variant; the behaviour is
pinned, so only the API shape was open.

## Options considered

1. **One factory with a direction** — `buildAttributeProvider(ctx, direction?)` with
   `worktree-first` / `index-first` / `index-only` / `tree`; callers passing no direction keep
   today's worktree-only reader (recommended). Pros: one `DirReader` composition. Cons: a union
   argument to read.
2. **Four named factories** — pros: no union; cons: four surfaces to keep in step for one
   composition.
3. **Keep the worktree-only provider for checkout writes** — pros: no change; cons: diverges from
   git on the pinned switch and `reset --hard` rows.

## Decision

**User-ratified — option 1.** `buildAttributeProvider(ctx, direction?)` takes an
`AttributeDirection`: `{ kind: 'worktree-first', index }`, `{ kind: 'index-first', index }`,
`{ kind: 'index-only', index }` or `{ kind: 'tree', tree }`, where `index` is a
`(path) => ObjectId | undefined` lookup. Each converting route passes git's direction per the
design's route table (§D3.5): check-in routes `worktree-first` with the entry's own index; the
checkout family `index-first` over the **result** index (stage-0 entries overlaid with the
changeset's writes minus its deletes); renormalization `index-only` over the merged
`.gitattributes` rule of §D1.12; archive `tree`. A call without a direction keeps today's
worktree-only reader for the non-converting consumers (content-merger driver lookup, tree diff,
patch materialisation, similarity).

## Consequences

- `buildTreeAttributeProvider` becomes the `tree` direction; the `maybeBuildAttributeProvider`
  runner gate goes — conversion needs no runner, and every converting route builds its provider
  lazily, once per command.
- The index blob is read through `readBlob` under the existing `.gitattributes` size cap.
- Which blob a content-conflicted `.gitattributes` contributes to the merge-family **writes** is
  not pinned by the design; the to-worktree part pins it against git before coding.
- A bare repository has no worktree source; the direction fallbacks degrade to the index or tree
  side unchanged.
