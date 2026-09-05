---
subjects:
  - docs/BACKLOG.md
---
# 806 — The completed backlog entry 30.3 cites ADR-752

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D7) · **Supersedes/Refines:** none

## Context

The completed backlog entry 30.3 cites ADR-723, which ADR-752 superseded; the decision lint's
citation sweep reports it. The lint's waiver token covers a whole file, never a line, and no
waiver file or invocation contract exists in this repository today.

## Options considered

1. **Re-point the citation at ADR-752, naming the addendum that survived** (designer's
   recommendation) — pros: the sentence stays true and the reader lands on the live decision.
2. **Waive the whole backlog file as history** — cons: every future stale citation in the backlog
   goes unreported; needs machinery that does not exist here.
3. **Drop the `ADR-` prefix so the sweep stops matching** — cons: defeats the check.

## Decision

**Ratified by the user: option 1.** The entry cites ADR-752 and names what it carried forward
from its predecessor; the rest of the entry is unchanged.

## Consequences

The backlog is a live page for the citation sweep; completed entries are updated when the
decision they cite is superseded. No waiver machinery is introduced.
