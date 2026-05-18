# ADR-026: Conflicting merges return a `kind: 'conflict'` result, not a thrown error

## Status

Accepted (at `3ca03a7a1820ee89b2b3e4bc3e902fb2c098b4e8`)

## Context

Phase 13.4a wired the three-way tree walk but threw
`MERGE_HAS_CONFLICTS` when conflicts were detected. The throw was a
placeholder for Phase 13.4b. Now that we persist merge state on
disk (markers, stage-1/2/3 index, MERGE_HEAD, MERGE_MSG, ORIG_HEAD),
we need to decide how callers learn about the conflict:

- **A — keep throwing.** `MERGE_HAS_CONFLICTS` is augmented with
  paths/count and carries no merge-state metadata.
- **B — throw a richer error.** Carry the conflict list AND the
  merge-state references in the error data.
- **C — return a `kind: 'conflict'` variant.** Extend the existing
  `MergeResult` discriminated union.

## Decision

We adopt option C. The `MergeResult` type grows a fourth variant:

```typescript
| {
    readonly kind: 'conflict';
    readonly conflicts: ReadonlyArray<{
      readonly path: FilePath;
      readonly type: ConflictType;
    }>;
    readonly mergeHead: ObjectId;
    readonly origHead: ObjectId;
  }
```

Callers that pattern-match on `kind` add a `case 'conflict':` branch.
The discriminated union's exhaustiveness check catches missing
branches at compile time.

## Consequences

### Positive

- **Symmetric with existing `MergeResult` kinds.** `up-to-date`,
  `fast-forward`, and `merge` already return rich metadata; the
  conflict case follows the same shape.
- **A conflicting merge is a SUCCESSFUL library call.** The state
  on disk is persisted intentionally — the user can resolve and
  commit. Throwing would imply a programming error or unrecoverable
  failure.
- **TypeScript exhaustiveness catches missing cases.** A caller
  that switches on `kind` without a `conflict` arm fails to
  compile, preventing silent fall-through.
- **No try/catch noise around the call site.** Callers inspect the
  return value with familiar pattern-matching idioms.

### Negative

- **Breaking change at the type level.** Existing callers that
  switched exhaustively on the three pre-existing kinds will fail
  to compile after this PR. Mitigated by the MIGRATION.md update
  and the small caller surface (this is a brand-new library).
- **The CLI `git merge` returns a non-zero exit code on conflict.**
  Callers that mirror CLI behaviour have to translate
  `kind === 'conflict'` into their preferred error surface. Trivial
  but worth noting.
- **`MERGE_HAS_CONFLICTS` becomes vestigial in `merge.ts`.** It
  stays in the domain for callers (primitive layer) that genuinely
  want to throw — e.g., a future `mergePathFile` primitive that
  doesn't write merge state. Removing the error from the union
  would be a wider refactor with no upside.

### Neutral

- The `conflicts` array in the return value duplicates information
  already in the index's stage-1/2/3 entries on disk. We include
  it for callers that don't want to re-read the index.
- Forward-compatible with `--abort` and other v2 surfaces: the
  conflict-result kind doesn't constrain future shape.

## Alternatives considered

- **Option A — keep throwing.** Rejected. Throwing makes a
  successful state look like a failure; callers must catch-and-
  inspect; doesn't compose with TypeScript exhaustiveness.
- **Option B — richer thrown error.** Rejected. Same problem as A
  plus an ad-hoc error shape that diverges from every other
  command's contract.
- **Option D — TWO return paths: `MergeResult` for clean cases,
  `MergeConflictResult` for conflicts.** Rejected. Two return
  types force callers to handle the dispatch externally; the
  whole point of a discriminated union is to keep dispatch
  internal to the type system.
