# ADR-209: mutualize work-vs-index comparison into one primitive

## Status

Accepted (at `ab29483559bfb1b06f1d7810f084d89e3f84deef`)

## Context

"Compare a working file to what git expects there" is currently re-implemented
in three places, each subtly different:

- `status.ts` `isModified` — content-hash vs the **index entry** id (content-only).
- `apply-changeset.ts` `blobMatches` / `isWorkingTreeDirty` — content-hash vs a
  **changeset blob id** (the id about to be overwritten), symlink-following read,
  treats not-found as "clean".
- `add.ts` — derives the working **mode** and does a symlink-aware **read** to
  *stage* (write the blob).

git has a single notion (`ce_match_stat` + content compare). `rm` (ADR-207/208)
needs the same "is this index entry dirty in the working tree?" answer, with
content **and** mode. Without consolidation this PR would add a fourth copy.

A subtlety found during investigation: `status`/`rm` compare against the **index
entry** (id + mode); `apply-changeset` compares against a **changeset id** (no
index entry, no mode — overwrite-dirty is purely about content loss). These are
genuinely different operations, so a single primitive cannot faithfully serve
both without force-fitting.

## Decision

Introduce one primitive as the single source of truth for the **index-entry**
comparison:

```ts
compareWorkingTreeEntry(ctx, entry): Promise<'absent' | 'unchanged' | 'modified'>
```

(`absent` = no working file; `modified` = mode or content differs from the entry;
content+mode per ADR-208.) Consumers:

- **`status`** migrates onto it: `absent → deleted`, `modified → modified`,
  `unchanged → (omit)`. This makes `status` mode-aware (a faithfulness upgrade).
- **`rm`** consumes it for the `local` half of the valve (`absent → skip valve`).

Extract the reusable **atoms** so every site shares one definition:
`deriveWorkingMode(stat)` and `readWorkingTreeContent(ctx, path, stat)` (moved
out of `add`, which now imports them); the loose-object hash is the existing
`hashBlob` primitive.

`apply-changeset` (checkout/merge) is **not** migrated onto
`compareWorkingTreeEntry` — it compares to a changeset id, not an index entry.
It adopts the `hashBlob` atom (dropping its inline header+hash duplication) and
keeps its changeset-compare semantics. A follow-up backlog item may unify the
overwrite-dirty path once a shared "compare to arbitrary id" shape is warranted.

## Consequences

### Positive

- One definition of "working file vs index entry"; `status` and `rm` provably
  agree (and now both mode-aware).
- Natural home for the future stat-cache fast path (perf priority #5) — added
  once, benefits every consumer.
- Removes the inline header+hash duplication in `status` and `apply-changeset`.

### Negative

- Touches `status` (behaviour change: mode-only changes now reported) and `add`
  (atom extraction), enlarging this PR's blast radius and its coverage/mutation
  surface beyond `rm` alone.

### Neutral

- `apply-changeset` keeps its own dirty shape; the mutualization is partial by
  design (atoms shared, primitive not), documented here so it reads as
  intentional rather than missed.

## Alternatives considered

- **Atoms only** (no shared primitive; `rm` builds its own local-diff). Rejected:
  leaves two divergent "modified?" notions (`status` content-only vs `rm`
  content+mode).
- **Force `apply-changeset` onto the primitive too.** Rejected: its compare
  target is a changeset id, not an index entry; adoption would be semantically
  wrong and risk checkout/merge correctness for marginal DRY gain.
