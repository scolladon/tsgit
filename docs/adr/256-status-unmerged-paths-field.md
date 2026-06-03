# ADR-256: `status` reports unmerged paths as a first-class field carrying the conflict state and per-stage blobs

## Status

Accepted (at `4e9f9433`)

## Context

`StatusResult` has no representation for unmerged (conflicted) paths.
`diffIndexAgainstTree` — the staged column — is stage-0-only, so a conflicted
path (which has stages 1/2/3 and no stage-0 entry) is silently absent from the
staged column. Worse, the working-tree pass builds its lookup from **all** index
entries (last stage wins), so a conflicted path is currently mis-classified by
whichever stage entry lands last. [ADR-254](254-status-staged-column-coarse-changekind.md)
logged "Unmerged paths (stage 1/2/3) reporting on `StatusResult`" as a follow-up;
this is it.

Grounded against real `git` (isolated env, signing off):

- An unmerged path appears **only** in its own porcelain line — never *also* in
  the working-tree column. `git status` lists conflicts under a separate
  "Unmerged paths" section.
- The porcelain **XY** code is a total function of which of stages 1 (base) / 2
  (ours) / 3 (theirs) are present — the seven non-empty subsets of `{1,2,3}`:

  | s1 | s2 | s3 | code | meaning |
  |----|----|----|------|---------|
  | ✓ | ✓ | ✓ | `UU` | both modified |
  | | ✓ | ✓ | `AA` | both added |
  | ✓ | | | `DD` | both deleted |
  | | ✓ | | `AU` | added by us |
  | | | ✓ | `UA` | added by them |
  | ✓ | | ✓ | `DU` | deleted by us |
  | ✓ | ✓ | | `UD` | deleted by them |

- Porcelain **v2** `u` lines additionally carry each stage's mode + oid
  (`m1 m2 m3 … h1 h2 h3`).

The domain already has the plumbing: `groupUnmergedEntries(index)` returns
`{ staged, unmerged: Map<FilePath, { stage1?, stage2?, stage3? }> }`, unit-tested
but consumed by nothing.

Two judgment calls:

1. **Where do unmerged paths live on `StatusResult`?** git models them as a
   distinct category, not part of the staged/working columns. Folding them into a
   column would be unfaithful (a `UU` path would gain a spurious working-tree
   entry). → a separate `unmerged` field.
2. **What does each entry carry?** Options:
   - **A.** `ConflictKind` enum + path only — reconstructs porcelain v1 fully;
     lightest surface; per-stage blobs deferred.
   - **B.** `ConflictKind` enum + per-stage `{ id, mode }` (base/ours/theirs) —
     lossless, reconstructs porcelain v2 too; heavier, no follow-up.
   - **C.** raw per-stage `{ id, mode }` triple, no enum — most raw, but pushes
     the (well-defined) classification onto every consumer.

## Decision

- **Separate field.** `StatusResult` gains
  `readonly unmerged: ReadonlyArray<UnmergedEntry>`, sorted by path (git order).
  `clean` becomes true only when all three columns *and* `unmerged` are empty.

- **Shape B** — the enum *and* the per-stage blobs:

  ```ts
  type ConflictKind =
    | 'both-modified' | 'both-added' | 'both-deleted'
    | 'added-by-us' | 'added-by-them'
    | 'deleted-by-us' | 'deleted-by-them';

  interface ConflictStage {
    readonly id: ObjectId;
    readonly mode: FileMode;
  }

  interface UnmergedEntry {
    readonly kind: ConflictKind;
    readonly path: FilePath;
    readonly base?: ConflictStage;   // stage 1
    readonly ours?: ConflictStage;   // stage 2
    readonly theirs?: ConflictStage; // stage 3
  }
  ```

  The `kind` is the semantic conflict state (porcelain v1 XY is a trivial caller
  mapping); the per-stage blobs make the field **lossless** — porcelain v2 `u`
  lines can be reconstructed without a later widening. A pure domain classifier
  `classifyUnmerged(group): ConflictKind` maps the stage-presence triple to one of
  the seven states as a fall-through decision tree whose final arm is the
  single-stage-3 case — total over a non-empty group (every `groupUnmergedEntries`
  group has ≥1 stage), no dead branch.

Rationale for B over the (lean, recommended) A: the per-stage `{id, mode}` is
already in hand from `groupUnmergedEntries` — surfacing it now is nearly free,
keeps the structured surface lossless against porcelain v2, and avoids a future
breaking widening of `UnmergedEntry`. The cost is a slightly larger public type,
accepted deliberately.

The working-tree pass is repartitioned via `groupUnmergedEntries`: pass 1
iterates stage-0 entries only (conflicted paths no longer mis-classified);
untracked exclusion tests the tracked set = stage-0 paths ∪ unmerged paths.
`describe --dirty/--broken` counts a non-empty `unmerged` as dirty (a mid-merge
index is dirty per `git diff-index HEAD`).

## Consequences

### Positive

- Conflicted paths are reported faithfully and no longer leak into the
  working-tree column; the latent mis-classification is fixed.
- Lossless against both porcelain v1 (enum) and v2 (per-stage blobs) — no future
  breaking widening anticipated.
- Consumes the already-built `groupUnmergedEntries` / `UnmergedEntryGroup`
  plumbing, giving it its first caller; `classifyUnmerged` is reusable by any
  future conflict-aware command.

### Negative

- Larger public `StatusResult` surface (`unmerged`, `UnmergedEntry`,
  `ConflictKind`, `ConflictStage`) than the lean enum-only shape.

### Neutral

- A natural merge rarely produces `DD`/`AU`/`UA`; those three states are pinned by
  a direct unit test of `classifyUnmerged` (all seven), independent of the
  interop merge scenario.
- No rendering surface — XY/conflict letters are reconstructed in the interop
  test from `kind`; `status` emits no string (ADR-249).
