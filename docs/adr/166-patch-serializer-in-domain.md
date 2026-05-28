# ADR-166: Patch serializer lives in the domain

## Status

Accepted (at `<sha-after-merge>`)

## Context

Phase 20.3 ships unified-diff text output for `repo.diff`. The
serializer takes a list of file changes plus their loaded blob bytes
and returns a `string`. Two natural homes:

1. **Domain (`src/domain/diff/patch-serializer.ts`).** Pure function:
   `(files, opts) => string`. No `Context`, no `Port`, no I/O. Sits
   next to the existing `diffLines`, `isBinary`, `LineDiff` types in
   `src/domain/diff/`. The tree-diff and line-diff algorithms already
   live there; the serializer is the same shape (bytes in, string
   out).

2. **Application primitive (`src/application/primitives/diff-patch.ts`).**
   Receives a `Context` and resolves blobs itself. The primitive wraps
   `readObject` + `domainDiffTrees` + serialization in one call.

The pull is whether bytes-loading is the serializer's job. If it is,
the serializer needs `Context`; if not, it stays pure.

## Decision

Put the **serializer in the domain** as a pure function. The
application-layer bridge (which loads blobs via `readObject` and turns
each `DiffChange` into a `PatchFile`) lives inside
`src/application/commands/diff.ts` alongside the existing structured
path. No new primitive.

## Consequences

### Positive

- Serializer testability matches the rest of `domain/diff/*` — golden
  strings + property tests, no fixtures, no fake ports. Tens of unit
  tests run in milliseconds.
- Reusable from the future `apply` / `am` / `format-patch` commands by
  importing the domain module directly. Application-layer entry points
  compose the same domain primitive instead of forking the emitter.
- Dependency-cruiser already enforces `domain` ← `application` —
  staying inside `domain` keeps the dependency graph one-way.

### Negative

- Two-step orchestration in `commands/diff.ts`: load bytes, then
  render. A primitive that bundles both would be a single call. The
  trade-off — primitive plumbing for `Context` everywhere the patch
  text is produced — is heavier than the orchestration cost.
- Domain layer grows: `patch-serializer.ts` adds ~400 LOC of pure
  emitter. Acceptable: it replaces ~400 LOC of CLI-side string munging
  every downstream caller would otherwise write.

### Neutral

- The `PatchFile` input shape is exported from `domain/diff/index.ts`.
  Callers that already have blob bytes (test scaffolding, future
  `format-patch`) can call the serializer directly.

## Alternatives considered

- **Application primitive (option 2 above).** Rejected: the I/O is
  small (a `readObject` call per changed file) and lives naturally in
  `commands/diff.ts`. A primitive would force every future caller to
  thread `Context`, which is the opposite of why
  `domain/diff/tree-diff.ts` is pure.
- **Inline inside `commands/diff.ts`.** Rejected: reuse from `apply` /
  `format-patch` would force a second copy or a refactor. Domain
  module is cheaper now.
