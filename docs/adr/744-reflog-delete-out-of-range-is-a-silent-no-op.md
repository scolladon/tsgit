# ADR-744: Reflog delete out-of-range is a silent no-op

## Status

Accepted (at `fc54f8cd`) — ratified by the user (against the design's recommendation)

## Context

`git reflog delete main@{99}` with an out-of-range index exits 0 silently; on a
corrupt file it still rewrites and purges the malformed lines, on a clean file it
leaves the file unchanged (measured, design doc §1b). tsgit throws
`REFLOG_ENTRY_OUT_OF_RANGE`. The design recommended keeping the typed error — a
library-flavoured knowing divergence. The user ruled for faithfulness, consistent
with the standing always-choose-the-git-faithful-fix principle.

## Decision

`runDelete` with an out-of-range (or non-integer/negative) index is a no-op that
matches git's observable behaviour: no error, and the same file state git leaves —
purged of malformed lines when the lenient read skipped any, untouched otherwise.
`ReflogResult`'s `delete` arm admits an absent `removed`
(`removed?: ReflogEntry` or equivalent), which is a published-surface type change.

## Consequences

### Positive

- Byte-for-byte faithful, including the purge-on-corrupt rewrite.

### Negative

- Callers lose the typed out-of-range error; a caller must inspect `removed` to
  learn nothing was deleted. Published result type changes
  (`reports/api.json` regeneration gates the push).

### Neutral

- The `reflogNotFound` precondition (missing reflog) is unchanged — git also
  errors there (exit 255).
