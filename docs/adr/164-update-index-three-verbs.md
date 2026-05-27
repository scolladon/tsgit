# ADR-164: `updateIndex` ships as three discrete verbs

## Status

Accepted (at `7d04c08`)

## Context

Phase 20.2's third primitive is the "granular index CRUD" surface.
Three options were on the table:

1. **Three discrete verbs** — `stageEntry`, `unstageEntry`,
   `setEntryFlags`. Each acquires the index lock, performs one
   operation, commits. Composes; each verb tells the caller exactly
   what it does.
2. **Single `updateIndex(actions[])` batch primitive** — one call
   takes `{ op, path, ... }[]`; one lock, one commit for the whole
   batch. Atomicity for multi-edit scripted flows; clunkier for
   single-shot use.
3. **Both** — discrete verbs plus a batch primitive. Widest surface,
   highest test cost.

Downstream callers in Phase 21–22:

- `stash pop` — restores N index entries plus flags. Today goes
  through `commands/add` which buffers internally. The batch shape
  would help; three verbs in a loop still works (each releases the
  lock between calls, so concurrent writers could interleave — but
  `stash pop` runs inside its own outer lock anyway).
- `mv` — two operations (remove old path, stage new). Doable with
  two discrete verb calls; the batch shape isn't needed.
- `cherry-pick`, `rebase` — replay changesets that are already
  represented as `applyChangeset` calls (existing primitive). The
  index CRUD layer is below those, not above.

The "atomicity across N entries" use case has exactly one foreseeable
caller (`stash pop`), and it already runs inside `stash`'s outer
write boundary. Optimising the surface for that single caller would
ship 30% more API for one consumer.

## Decision

Take option (1): three discrete verbs. No batch primitive in 20.2.

If 21.3 (`stash`) proves the batch shape is necessary, we add
`updateIndexBatch` then — additive, no breaking change. The discrete
verbs stay regardless because they're the surface every other
consumer wants.

## Consequences

### Positive

- Each verb's name describes exactly what it does — `stageEntry`,
  `unstageEntry`, `setEntryFlags`. No discriminator-action enum.
- Failure modes are local: a misspelt action in a batch payload
  becomes a compile error on the verb selection itself.
- Composes naturally with `await stageEntry(...); await
  setEntryFlags(...)` — the way `commands/add` and `commands/rm`
  already mix multiple primitives.
- Smallest surface that covers known consumers.

### Negative

- N index-entry writes from one caller pay N lock acquisitions.
  In-process this is sub-millisecond; cross-process collisions are
  the documented `RESOURCE_LOCKED` contract.
- A future "atomic batch" use case has to import a new primitive
  rather than tweak an existing parameter. Acceptable — that's the
  20.x → 20.2a follow-up shape.

### Neutral

- `commands/add` still buffers paths inside its own lock for the
  bulk path. The discrete verbs do not replace it; they unblock
  callers who can't go through the pathspec resolver.

## Alternatives considered

- **Option 2 (batch only)** — rejected: forces a Discriminated-Union
  payload shape on every caller, including those staging a single
  file. Friction for the common case to support a rare one.
- **Option 3 (both)** — rejected by YAGNI. Test cost doubles; the
  batch primitive's only known caller can be served by the verbs
  inside its own outer lock.
