# 621 — The bitmap parser declines where git declines

- **Status:** accepted (adopted-as-recommended)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (§D1, Pin J) · **Refines:** ADR-605, ADR-615, ADR-618

## Context

ADR-605 shipped the bitmap parser on the reasoning that being *stricter* than git costs
nothing on the read path, because a decline merely falls back to the walk and the walk is the
correct answer. **ADR-618 falsified that premise.** With haves present the two tiers no longer
agree — the walk returns a superset — so a decline that reaches the walk now **changes the
answer** on exactly the shape `pack-objects` cares about. Strictness is no longer free.

## Options considered

1. **Decline where git declines** — the accept-set is git's, so a decline never introduces a
   tier change git would not also make.
2. **Decline on any structural anomaly** — simpler and safer-looking / silently enlarges
   have-bearing answers wherever tsgit is stricter than git.

## Decision

Option 1. The parser's accept-set is git's accept-set. Pin J shows the two decline together on
every structural row, so this is a narrow rule rather than a broad promise; the one row where
both must shrug is an oversized declared `bitSize`, which git tolerates and tsgit therefore
tolerates too — bounded per ADR-611, never trusted for allocation.

This does **not** relax ADR-611's bounds. Accepting a file git accepts is not the same as
allocating from a count it declares: every declared length is still validated against the
remaining buffer before use, and decoding stays lazy. The parser accepts the *file* and
refuses the *arithmetic* — those are separate gates and only the first is git-matched.

## Consequences

Keeps ADR-605's separation intact from the other side: the `fsck` pass still hashes without
parsing, so no parser strictness can leak into a `fsck` verdict, and now no parser strictness
can silently enlarge a closure either. Any future hardening of the parser must re-derive its
licence from this ADR rather than from ADR-605's now-falsified "declines are free" reasoning.
