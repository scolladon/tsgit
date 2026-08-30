---
subjects:
  - src/application/primitives/internal/resolve-tree-path.ts
---
# 761 — Path descent scans the whole directory and returns the first match

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (review round 1) · **Supersedes/Refines:** none — ADR-723's eager-validation ruling stands

## Context

The descent walked every entry of a directory even after finding its target. Review found
the shipped code did not actually validate those trailing entries — `matched ??=`
short-circuits, so entries after the match were advanced but never checked. All four
review dimensions found it independently, and the resulting refusal was
position-dependent: a bad-mode sibling raised `INVALID_FILE_MODE` before the target and
was ignored after it.

The first attempt at a decision here recorded that git "validates neither sibling" and
therefore ratified stopping at the match. **A direct probe of git 2.55.0 shows that is
only half true, and the wrong half.** Over a single-level tree searched with
`git rev-parse <tree>:good`:

| fault on a sibling | before the match | after the match |
|---|---|---|
| non-octal mode `10064a` (**parse tier**) | `fatal: malformed mode in tree entry` | `fatal: malformed mode in tree entry` |
| octal-but-unrecognised `777777` (**check tier**) | resolves, exit 0 | resolves, exit 0 |

So git never applies the *check* tier during a path lookup, and always applies the *parse*
tier across the whole tree regardless of where the match sits. Stopping at the match is
faithful on the tier git ignores and unfaithful on the tier git enforces.

## Options considered

1. **Scan the whole directory, return the first match** — pros: keeps git's structural parity, and the refusal stops depending on sibling order / cons: no scan saving.
2. **Stop at the first match** — cons: measured to lose parse-tier parity; a malformed sibling after the match stops refusing, where git refuses.
3. **Stop at the match and drop the check tier from the scan** — cons: matches git for the descent alone, but makes the descent disagree with the root level, which validates every entry through the parse path; it trades one divergence for an internal inconsistency.

## Decision

**Option 1, on the measurement above.** The descent scans every entry of the directory,
remembers the **first** name match, and returns it after the walk completes. The structural
scan therefore covers the whole directory, matching git; the check tier stays applied per
visited entry, which keeps the raw descent consistent with the parsed root level.

The check tier's own divergence from git — tsgit refuses an octal-but-unrecognised mode on
read where git resolves — is **pre-existing and already recorded** as one of the two
surviving read-path divergences. It is not created or widened here, and it is not this
decision to change.

## Consequences

### Positive

- The position-dependent refusal is gone: the same tree gives the same answer regardless of sibling order.
- Structural parity with git holds across the whole directory.

### Negative

- No scan saving; the walk is the full directory width, as before.

### Neutral

- The earlier framing of this decision — that stopping at the match was both faster and more faithful — was wrong, and is preserved here rather than quietly replaced. Measuring both tiers separately is what distinguishes them; a single probe of "does git refuse" cannot.
