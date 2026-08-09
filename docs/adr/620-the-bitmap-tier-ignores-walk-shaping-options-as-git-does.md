# 620 — The bitmap tier ignores walk-shaping options, as git does

- **Status:** accepted (ratified)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (Pin AC) · **Refines:** ADR-226, ADR-613, ADR-618

## Context

ADR-618 gives `rev-list` a caller-facing tier control. That control can be combined with the
walk-shaping options ADR-613 ships, and git's behaviour under the combination is surprising:
asked for the bitmap tier *and* a shaping option, git loads the bitmap and returns the **full
closure as though the option were absent** — measured 227 objects against 183 for
`--first-parent`, and 227 against 7 for `--no-walk`. It does not refuse, and it does not
honour the option. (`--max-count` needs no decision: git abandons the bitmap for it.)

The options are meaningful only to a traversal, and the bitmap tier does not traverse.

## Options considered

1. **Reproduce git** — ignore the shaping options on the bitmap tier, and say so in the
   option's doc-comment / inherits a genuine footgun.
2. **Honour the filter by declining the bitmap** — returns the correct shaped answer / quietly
   better than git, and therefore a divergence when the tier was explicitly requested.
3. **Refuse the combination** — safest for a caller / strictly stricter than git: refusing a
   call git answers.

## Decision

Option 1, by direct application of the prime directive (ADR-226): the bitmap tier ignores
walk-shaping options and returns the full closure, exactly as git does. The tier control's
doc-comment states plainly that first-parent and no-walk have no effect on the bitmap tier,
so the behaviour is discoverable at the point of use rather than only in a pin.

Because ADR-618 makes the walk the **default** for `rev-list`, a caller who has not opted into
the bitmap tier never meets this behaviour.

## Consequences

Inherits a footgun that is git's, not tsgit's, and documents rather than repairs it — the
repair (option 2) would be a silent divergence, which the prime directive treats as worse than
a documented surprise. An interop row pins the combination in both tiers so the inherited
behaviour cannot drift unnoticed.
