# ADR-118: Two-pass scanner — `scanItBlocks` + `scanDescribeBlocks` with offset-containment join

## Status

Accepted (at `62dc683`)

## Context

ADR-117 promotes Given/When into `describe()` ancestors and leaves
`Then` on the `it()`. The detector now has to validate a path of
describe titles, not just the leaf title. Three options:

1. **Switch to an AST parser** (TypeScript compiler API or a
   purpose-built one) — every detector could share a single tree.
2. **Extend the existing `scanItBlocks` to also emit describe
   blocks** — single walk, mixed records.
3. **Add a second sibling scanner (`scanDescribeBlocks`) and join
   on source-offset containment** — same regex/brace approach as the
   existing pass.

ADR-097 already committed the project to regex/brace scanning for the
audit, and ADR-108 / ADR-114 reinforced that line as detectors
multiplied. The cost ceiling we agreed to revisit at was "many more
heuristics or a deeper structural rule"; adding describe-awareness is
the first structural rule but not yet a multi-heuristic explosion.

## Decision

- **Add a sibling scanner `scanDescribeBlocks`** that mirrors
  `scanItBlocks` exactly: same paren/brace walker, same title
  extractor, same skip-modifier set. Output:
  `{ line, title, openIdx, closeIdx, isSkipped }`.
- **Join the two passes by source-offset containment.** For each
  `it()` record, find every `describe()` whose
  `(openIdx, closeIdx)` strictly contains the `it()` opener offset;
  order closest-first. This is O(N·M) for N describes and M `it()`s
  per file but N+M is small in practice (max ~150 per file, audited
  against the current tree).
- **Keep `scanItBlocks` untouched.** Other detectors
  (`detect-bare-class-throw`, `detect-banned-sut-name`,
  `detect-missing-aaa`, `detect-empty-aaa-section`,
  `detect-under-asserted`) read it; changing its record shape would
  ripple. Only the GWT detector consumes the join.
- **Support `describe.each([…])('title', …)`** the same way
  `scanItBlocks` already supports `it.each`. `skipIf` / `runIf` two-
  stage forms stay deferred (19.3b).
- **Reject AST migration** for now. The marginal precision gain
  (handles string interpolation, comments inside titles, etc.) does
  not justify the dependency, the build-time cost, and the rewrite
  of every existing detector. Revisit if a future heuristic actually
  needs structural information regex can't see.

## Consequences

### Positive

- **Each scanner stays small and audit-readable.** No structural
  state, no AST node walking, no compiler-API surface.
- **Other detectors unaffected.** Zero risk of regression in the six
  detectors that already passed ADR-097 design review.
- **Test surface is symmetric.** `scanDescribeBlocks` reuses the
  scanner-fixture pattern from `scanItBlocks`.

### Negative

- **Two passes over the file source** instead of one. Cost is
  negligible (<1ms per file at current sizes).
- **The join is per-detector logic.** If a second detector later
  needs describe ancestors, we extract a shared helper rather than
  copy-pasting.
- **The accepted false-positive risk of regex/brace scanning
  doubles** — now applies to describe-title extraction too. Same
  posture: documented, accepted.

### Neutral

- The join function is named `findDescribeAncestors(itRecord,
  describes)` and lives inside `detect-bad-title.ts` until a second
  caller emerges.
- The "revisit ceiling" set in ADR-108 still stands. Eight heuristics
  is the new state of play; if a ninth is proposed alongside another
  structural rule, AST migration becomes a live conversation.
