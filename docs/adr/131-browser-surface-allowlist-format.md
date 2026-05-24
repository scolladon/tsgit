# ADR-131: Browser-surface allowlist format

## Status

Accepted (at `75a0cde6`)

## Context

A handful of `Repository` surfaces cannot be tested in the browser
without infrastructure that 19.5a deliberately defers (an in-page
HTTP server for transport; a hook runner for `runHook`). The audit
must let these names pass without losing the discipline that every
exemption is intentional, justified, and traceable.

Three shapes for the allowlist were considered:

- A bare array of names (`["clone", "fetch"]`). Cheap but loses
  rationale; old entries rot without a paper trail.
- Inline `// allow-browser-surface: reason` comments inside
  `src/repository.ts`. Co-locates rationale with the binding but
  pollutes the facade with test-infrastructure metadata.
- A standalone JSON file with structured entries. Separation of
  concerns, mechanically validated, easy to diff.

## Decision

Use a standalone JSON file at
`tooling/audit-browser-surface.allowlist.json` with the schema:

```json
{
  "commands": [
    { "name": "clone", "reason": "...", "deferredTo": "19.8" }
  ],
  "primitives": [
    { "name": "runHook", "reason": "...", "deferredTo": null }
  ]
}
```

Validation rules enforced at audit start (any failure exits non-zero
before the coverage check runs):

- Top-level keys are exactly `commands` and `primitives`.
- Every entry has `name` (non-empty string), `reason` (non-empty
  string), and `deferredTo` (string or `null`).
- Every `name` must be a currently bound surface on the matching
  tier — entries naming removed surfaces fail loudly so the
  allowlist doesn't rot.
- `deferredTo` is opaque metadata; the audit doesn't verify the
  named phase exists.

A `null` `deferredTo` means the exemption is structural and
permanent (e.g., browser has no hook runner by design). A string
value names a future phase that is expected to close the gap.

## Consequences

### Positive

- Adding or removing an exemption is a one-file diff that PR review
  can audit alongside any infrastructure change that justifies it.
- The validator catches stale entries before they hide a real
  regression: if `clone` ever gets removed from the facade, the next
  audit run fails until the allowlist entry is removed.
- The `reason` field forces the author to write down the rationale
  at decision time, not at audit time.

### Negative

- A JSON file with free-form `reason` strings is not machine-
  diffable beyond "the entry changed." Acceptable; PR review is the
  intended reader.
- The schema is hand-rolled rather than zod / ajv. Consistent with
  the rest of `tooling/` (`mutation-budgets.ts`,
  `check-doc-coverage.ts`) which all hand-roll narrow validators
  to keep the dependency surface minimal.

### Neutral

- The allowlist file lives under `tooling/`, not `docs/`, because
  the audit script is its sole consumer and CI's working directory
  expects it there.
