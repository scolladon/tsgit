# ADR-310: add/add conflicts keep `type: 'add-add'` and gain a `contentVerdict` field

## Status

Accepted (at `<sha-after-merge>`)

## Context

Routing both-added paths through the empty-base content merge (24.9f) makes an
add/add conflict carry two facts at once: the **tree-level shape** (both sides
added, no stage 1 — what git's `CONFLICT (add/add)` label is derived from) and
the **content-level verdict** (text markers, binary take-ours, or clean content
with a mode-only disagreement — what git's `warning: Cannot merge binary files`
and the presence/absence of markers are derived from). `MergeConflict.type` is
a single discriminant and can only carry one of them.

Options considered:

1. Keep `type: 'add-add'`, no new field — the content verdict is recoverable
   only by re-inspecting the stage blobs.
2. Propagate the merger's `'content'`/`'binary'` as `type` — breaks existing
   `type === 'add-add'` consumers; the add/add shape is re-derivable from
   `baseId === undefined`.
3. Keep `type: 'add-add'` **and** add a secondary field with the content
   verdict.

## Decision

Option 3. `MergeConflict` gains an optional

```ts
readonly contentVerdict?: 'clean' | 'content' | 'binary';
```

populated on add/add conflicts that ran the content merge:

- `'content'` — the text merge conflicted; `conflictContent` holds the
  per-region marked bytes.
- `'binary'`  — binary detected (or `-merge`/`binary` driver); `conflictContent`
  holds the take-ours bytes.
- `'clean'`   — the content merged cleanly but the modes disagree (git still
  reports `add/add`); `conflictContent` holds the clean merged bytes, no
  markers.

Bare add/add conflicts that bypass the merger (gitlink pairs, symlink/symlink)
carry no `contentVerdict`. Conflict types other than `add-add` never carry it —
their `type` already is the verdict.

## Consequences

### Positive

- Backward-compatible: `type === 'add-add'` keeps matching; existing consumers
  see strictly more data.
- A consumer can reconstruct git's display (`CONFLICT (add/add)`, the binary
  warning, marker presence) from structured fields alone, per ADR-249.
- The mode-only conflict (`'clean'`) is distinguishable from a marker-bearing
  one without parsing `conflictContent` for marker bytes.

### Negative

- A small widening of `MergeConflict` for a detail derivable (at blob-read
  cost) from the stage ids.

### Neutral

- The index stage emissions are unchanged — stages 2/3 only, exactly as today
  (already byte-faithful to git).
