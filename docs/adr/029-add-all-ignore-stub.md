# ADR-029: `add --all` ships with a no-op ignore predicate

## Status

Accepted (at `5ecd61a`)

## Context

BACKLOG §14.1 (`add --all`) and §14.3 (`.gitignore` evaluation in `add
--all` / `status` untracked enumeration) are separate phases. §14.1
must ship before §14.3 because the walking + staging machinery has no
dependency on `.gitignore` semantics, and bundling them risks a fat,
hard-to-review change.

`add --all` still needs *some* answer to the question "should this
path be included?". Two options:

1. **Stub:** treat every path as not-ignored. Defer real evaluation
   to §14.3. Surface the seam so §14.3 is a drop-in replacement.
2. **Eager pull-in:** read repo-root `.gitignore`, nested
   `.gitignore`, `.git/info/exclude`, the global excludesFile, and
   honour all of them now. The infrastructure (parser + matcher) is
   already implemented in `src/domain/ignore/`.

Option 2 expands the scope to multi-level ignore composition,
`.gitignore` discovery during the walk, and global-config plumbing —
all §14.3 work. Doing it inside §14.1 makes the design and the PR
larger, defeats the slice boundary, and forces the reviewer to grade
two features at once. It would also break the BACKLOG ledger, which
treats §14.1 and §14.3 as independent tickets.

## Decision

`add --all` accepts a per-instance `IgnorePredicate` (function
`(FilePath, isDirectory) => boolean`). §14.1 ships
`defaultIgnorePredicate = () => false`. §14.3 will replace the
default with a real implementation. The predicate runs AFTER `seen`
is updated so that an ignored-but-tracked file does not get dropped
from the index — Git's invariant.

## Consequences

### Positive

- Slice stays small; review surface for §14.1 is just the walk + the
  bulk-mode dispatch.
- §14.3 is a single-file change (the default predicate, plus tests).
- The seam is testable in §14.1 — internal tests can inject a custom
  predicate to verify the ignore-aware code path even before §14.3.

### Negative

- Until §14.3 lands, `repo.add({ all: true })` will happily stage
  build artefacts (`node_modules/`, `dist/`, …). Users will notice;
  the README + RUNBOOK call this out explicitly with a "v1.x patch"
  pointer. Anyone wanting safe behaviour today filters their own
  paths via the literal-path mode.

### Neutral

- The predicate signature is internal — the public `AddOptions` does
  NOT expose it. §14.3 may choose to expose it later (e.g. for
  `add --all --no-ignore`) or keep the predicate strictly internal.
