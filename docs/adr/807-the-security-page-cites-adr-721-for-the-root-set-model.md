---
subjects:
  - docs/understand/security.md
---
# 807 — The security page cites ADR-721 for the root-set model

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D8) · **Supersedes/Refines:** none

## Context

The security page cites ADR-541 for the containment root-set model. ADR-721 superseded ADR-541
on the facade wrapper's read-path role and carried the root-set model forward unchanged, so the
cited decision is partly superseded and the citation sweep reports it. The page's opening
paragraph already describes ADR-721's ruling without citing it.

## Options considered

1. **Cite ADR-721, naming the root-set model as what it carried forward** (designer's
   recommendation) — pros: one accurate citation; ADR-721's own body records the lineage.
2. **Waive the file** — cons: disproportionate for one line in a page that will keep citing ADRs.
3. **Cite ADR-721 and refer to ADR-541 by title only** — cons: a citation written to evade the
   sweep.

## Decision

**Ratified by the user: option 1.** The sentence cites ADR-721 as the single authority for
first-party read containment and says the root-set model is what it carried forward.

## Consequences

The page cites the governing decision. The lineage to ADR-541 is one hop away in ADR-721.
