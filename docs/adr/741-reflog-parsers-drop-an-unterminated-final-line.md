# ADR-741: Reflog parsers drop an unterminated final line

## Status

Accepted (at `fc54f8cd`) — ratified by the user

## Context

git requires a reflog line to end with LF: an unterminated final line (the torn
write, the likeliest real corruption) is dropped — the newest entry is lost
(measured, design doc §1a row 25). tsgit's parsers keep such an entry. The rule is
file-level (the split on `\n`), not a per-line predicate. Alternatives: fix the
lenient parser only, making the two parsers disagree about the same bytes — the
exact trap class this backlog item removes; or record the divergence unchanged.

## Decision

Both `parseReflog` (strict) and `parseReflogLenient` treat a final line without a
terminating LF as absent. This changes the published strict `parseReflog`'s
behaviour: a torn final entry is silently dropped rather than parsed; every other
malformed line still throws on the strict path.

## Consequences

### Positive

- git-faithful on the likeliest real corruption; both parsers agree about every
  file.

### Negative

- The strict parser silently hides a torn write instead of surfacing it — callers
  relying on strictness lose that one signal.

### Neutral

- The existing proven-equivalent Stryker suppression on `parseReflogLenient`'s
  empty-line guard is structure-specific; if this reshapes the loop, the
  equivalence must be re-proved, not carried forward.
