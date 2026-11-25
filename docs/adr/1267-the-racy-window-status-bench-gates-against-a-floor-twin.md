---
subjects:
  - test/bench/status-racy-window.bench.ts
---
# 1267 — The racy-window status bench gates against a floor twin

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (DC-C, §6) · **Supersedes/Refines:** applies ADR-1247 and ADR-1255; evidence of DOCTRINE(D-7)

## Context

Under ADR-1262 `status` hashes every entry that shares the index's second, as git does. Main
trusts the stat of the entries earlier in that second, so main is no yardstick for the cost.

The design proposed a gate of 1.25 over an index read plus one hash per file. Measured before
ratifying, on main's racy path with every entry racy (median of 9, load 3):

| Tree | racy `status` | settled `status` | bare read + SHA-1 | over `lstat` + read + hash | over settled + read + hash |
|---|---|---|---|---|---|
| 5000 files of 2 KiB, three runs | 144 to 155 ms | 30 to 35 ms | 88 to 97 ms | 1.36 to 1.60 | 1.12 to 1.31 |
| 20000 files of 2 KiB | 653 ms | 106 ms | 412 ms | 1.43 | 1.26 |

The proposed gate is not reachable by correct code: the walk, the index compare against `HEAD`
and the index write are part of every `status`, and the proposed floor holds none of them.

## Options considered

1. **A bench pair: `status` in the racy window, and a floor twin in the same process made of a
   settled `status` plus a bare read and SHA-1 of every tracked file; gate 1.5** (recommended).
2. No new gate: the existing benches and an A/B run after the commit.
3. Option 1 plus an automated ratio row in the perf suite, gated at 2.0.

## Decision

**User-ratified — option 1.** `status` in the racy window costs at most 1.5 times the floor
twin. The ratio is measured again on the fixed code and recorded in the design.

A second hash of every entry, by the reader and then by the smudge pass, would read about 1.8,
computed from the measured parts.

Refused: option 2 leaves that second hash unguarded. Option 3 adds a load-sensitive row to every
gate run.

## Consequences

### Positive

- The cost git itself pays is measured apart from any overhead tsgit adds.

### Negative

- One more bench to run on a quiet machine.
