---
subjects:
  - docs/adr/724-maintenance-command-with-commit-graph-and-gc-lite.md
---
# 805 — ADR-724 carries one bare superseded-status line plus a bullet naming ADR-732 and ADR-733

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D6) · **Supersedes/Refines:** none

## Context

ADR-724 was superseded in three parts by ADR-731, ADR-732 and ADR-733, and its status line says
so in one sentence with a parenthetical scope. Only ADR-731 declares the supersession in its
front matter, so the decision lint demands exactly one line, `- **Status:** superseded by
ADR-731`, and the composite sentence fails it. The information about the other two supersessions
must survive.

## Options considered

1. **One bare status line; the three-ADR nuance only in the block quote** — cons: demotes two
   real supersessions to prose.
2. **Declare `supersedes: 724` in ADR-732 and ADR-733 too** — pros: completes the machine-readable
   graph / cons: forces near-identical carried-forward paragraphs into three ADRs and asks for new
   decision prose only the user can ratify.
3. **One bare status line plus a separate non-status bullet naming ADR-732 and ADR-733 with
   their scopes** (designer's recommendation) — pros: one added bullet, both supersessions
   visible at bullet level, nothing duplicated.

## Decision

**Adopted-as-recommended (no user judgment): option 3.** ADR-724's status line becomes the exact
form the lint requires, and a bullet directly below it names ADR-732 (pack consolidation) and
ADR-733 (promisor consolidation) with the scope each took over. The same shape, minus the extra
bullet, applies to ADR-389 and ADR-541: their parenthetical scopes move into the block-quote
note. The anchors in ADR-721 and ADR-752 are re-wrapped so each starts its own line in plain
text, wording unchanged.

## Consequences

The decision lint passes on the tracked tree. A future multi-superseder ADR follows the same
form: one lint-exact status line per declared supersession, a bullet for the rest.
