# 557 — The final-terminator rule lives in `normalizeLine`, mirrored in the digest

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

Pinned against git 2.55.0: git ignores a difference in the final line's terminator under
every flag that sets `diff_from_contents` — `-w`, `-b`, `--ignore-space-at-eol` **and**
`--ignore-cr-at-eol` — and does so symmetrically (LF gained and LF lost behave
identically). It never does so under plain diff or under `--ignore-blank-lines` alone.
That set is exactly `lineKeyIsActive(key)`, i.e. `mode !== 'none' || ignoreCrAtEol` — so
the rule is neither "every mode but `'none'`" nor unconditional. tsgit diverges because
`LineDigest.terminated` participates in `digestsEqual`, and the `withStat` arm diverges
identically because `normalizeLine` preserves the LF and `bytesEqual` sees it.

## Options considered

1. **In `normalizeLine`, mirrored in `digestNormalizedLine`** (designer's recommendation)
   — one rule; `internOne` and `linesEqualUnder` inherit it; plus the
   `trailingNoNewline` postimage fix. Pros: DRY and faithful — `linesEqualUnder` starts
   agreeing with git's `xdl_recmatch` under an active key, and the `expectedDigest` test
   oracle stays *independent* instead of needing a second rule bolted on. Measured churn:
   8 of 25 `normalizeLine` rows / cons: a public **behaviour** change (different bytes
   under an active key) with no signature or `reports/api.json` change.
2. **Leave `normalizeLine` byte-stable; apply the rule at the two comparison sites only**
   — cons: two rules that must never drift, the exact failure mode ADR-551 was written to
   prevent, one layer down.
3. **Drop-verdict only** — fix `digestNormalizedLine` and let the stat arm's reroute carry
   the rest. Cons: **not faithful enough.** tsgit reports `2 2` where git reports `1 1`
   under `-w`, and `added`/`deleted` are structured data the prime directive binds.

## Decision

Adopted-as-recommended (no user judgment): **option 1**. Suppression happens at digest
**construction**, not in `digestsEqual`, because all four digest folders mix the LF into
the FNV hash.

## Consequences

Three sites change in one commit: `normalizeLine` (the `withStat` twin — `internOne`
interns through it, which is what makes the stat arm agree), `digestNormalizedLine`, and
`patch-serializer.ts::trailingNoNewline`. That third site is newly reachable: git renders
a context line from the postimage and emits `\ No newline at end of file` from the
**postimage's** termination alone, while tsgit's `(isLastOld && !oldHasTrailingNewline) ||
(isLastNew && !newHasTrailingNewline)` would emit a marker git does not. The OR is
unreachable-divergent today only because a context match currently forces equal
termination — precisely what this fix destroys. Two `Stryker disable` directives on that
function have their premise falsified and must be **deleted, not re-anchored**.
`LineDigest.terminated` has no reader outside `digestsEqual`; `normalizeLine` has three
(`linesEqualUnder`, `isBlankLine`, `internOne`), of which `isBlankLine` is provably
unaffected.
