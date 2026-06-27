# 427 — bundle verify fully parses the embedded packfile

- **Status:** accepted
- **Date:** 2026-06-27
- **Design:** docs/design/bundle.md · **Relates:** ADR-226 (git-faithfulness), ADR-425 (verify query)
- **Decision class:** D-FAITHFULNESS (user judgment)

## Context

`git bundle verify` does more than read the header: it hands the embedded packfile to the
index-pack/rev-list machinery to confirm the pack is intact and the history is usable. How
deeply tsgit's `verify` exercises the pack is a faithfulness-versus-cost trade-off — from a
cheap trailer check up to a full entry-by-entry parse.

## Options considered

1. **Header + prerequisites + pack-trailer check** — validate the header, check
   prerequisites, verify the pack trailer SHA-1 *(designer recommendation)* — pros: cheap;
   catches truncation; cons: does not catch corruption of the inflated entry bodies; less
   than what git's verify actually exercises.
2. **Header + prerequisites only** — pros: fastest; cons: trusts the pack bytes entirely.
3. **Full pack parse** — walk and inflate every pack entry — pros: closest to what
   `git bundle verify` exercises; catches body corruption, not just truncation; cons: pays
   a full-pack inflate on verify.

## Decision

**Option 3 — ratified by the user**, deviating from the designer's trailer-check. The user
chose maximal faithfulness: `verify` fully parses and inflates the embedded pack, matching
what git's verify exercises, rather than trusting the bytes after a trailer check.

## Consequences

- `verify` reuses the existing pack-reading machinery to walk every entry; a corrupt
  entry surfaces as a verify failure, not a silently-passing trailer.
- The cost is a full-pack inflate per `verify`; acceptable for a verification operation and
  consistent with git's own behaviour.
