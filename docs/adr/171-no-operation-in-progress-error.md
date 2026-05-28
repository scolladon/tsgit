# ADR-171: `NO_OPERATION_IN_PROGRESS` error shape

## Status

Accepted (at `f6678401f5a103a69747c81239b1d8e42a0d1fff`)

## Context

`abortMerge` and `continueMerge` need a uniform error to surface
when the user invokes them outside of an active merge. Canonical
git's message is `fatal: There is no merge to abort (MERGE_HEAD
missing).` — informative, but unstructured.

Three shapes were considered:

- **A single per-command code**: `NO_MERGE_IN_PROGRESS`. Simple, but
  Phase 22 will need three siblings (`NO_REBASE_IN_PROGRESS`,
  `NO_CHERRY_PICK_IN_PROGRESS`, `NO_REVERT_IN_PROGRESS`). Four
  almost-identical codes pollute the error union.
- **A generic code with a string field**: `NO_OPERATION_IN_PROGRESS`
  with `operation: string`. Loses type safety — callers can't
  exhaustively switch on operation values.
- **A generic code with a string-literal-union field**:
  `NO_OPERATION_IN_PROGRESS` with `operation: 'merge' | 'rebase' |
  'cherry-pick' | 'revert'`. The mirror of the existing
  `OPERATION_IN_PROGRESS` code.

## Decision

Add a new error code to `CommandError`:

```typescript
| {
    readonly code: 'NO_OPERATION_IN_PROGRESS';
    readonly operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  }
```

with a constructor `noOperationInProgress(operation)` parallel to
the existing `operationInProgress`.

`abortMerge` and `continueMerge` throw it with `operation: 'merge'`
when `MERGE_HEAD` is absent (or, for abort, when `ORIG_HEAD` is
absent — the merge state contract requires both).

## Consequences

### Positive

- **Symmetry with `OPERATION_IN_PROGRESS`.** The two codes are
  duals: one fires when a marker exists and the caller didn't
  expect it; the other fires when a marker is absent and the caller
  required it. Same `operation` discriminator on both sides — same
  error-catching code pattern for users.
- **Phase 22 reuses without expansion.** Adding rebase / cherry-pick
  abort+continue uses the same code with a different `operation`
  value. No new error variants in the union.
- **Exhaustive type narrowing.** Callers that catch
  `NO_OPERATION_IN_PROGRESS` can switch on `data.operation` with
  TypeScript exhaustiveness checking — the four operation values
  match `OPERATION_IN_PROGRESS`.

### Negative

- **No path information.** A user with a corrupt `ORIG_HEAD` and
  intact `MERGE_HEAD` gets the same error code as a user with no
  merge state at all. The error message can disambiguate via
  `Error.message`, but the structured payload doesn't. Mitigation:
  a future variant could carry a `reason: 'missing-merge-head' |
  'missing-orig-head'` discriminator if user demand emerges.

### Neutral

- The `operation` field's literal union is duplicated between
  `OPERATION_IN_PROGRESS` and `NO_OPERATION_IN_PROGRESS`. A shared
  type alias would deduplicate, but the duplication is small and
  keeping the two codes textually independent reads more clearly
  in `error.ts`'s grep view. Deferred.

## Alternatives considered

- **`NO_MERGE_IN_PROGRESS`** — rejected. Forces three sibling codes
  in Phase 22.
- **Reuse `OPERATION_IN_PROGRESS` with a `present: false` field** —
  rejected. Overloads the existing semantic; existing callers that
  check the code lose their narrowing because both presence and
  absence now share it.
- **Throw a generic `INVALID_STATE` code** — rejected. Too vague;
  callers can't tell merge-related errors from any other state
  invariant violation.
