---
subjects:
  - src/domain/pathspec/compile-glob.ts
supersedes:
  - adr: "1259"
    scope: "a single entry holding the last path and its fold"
---
# 1260 — A fixed tail refuses a path, and two paths are remembered

- **Status:** accepted
- **Date:** 2026-11-24
- **Design:** docs/design/wildmatch-bracket-class.md (§4, §5) · **Supersedes/Refines:** supersedes ADR-1259 (one entry); refines ADR-1252 and ADR-1253

## Context

Review measured two costs the gate of ADR-1255 does not see.

Attribute rules test an unanchored rule against the basename and an anchored rule against the
relative path. A rule set mixing both alternates two strings, so the single-entry memo of
ADR-1259 misses on every rule: 20000 files against 20 mixed rules cost 43.6 ms folded on
lower-case paths and 71.5 ms on mixed-case paths, against 11.1 ms case-exact.

A star-led rule ending in a set (`*.py[cod]`, `*.[oa]`) has no fast path. Every path pays a
byte encode and a full table fill for it, per rule: six such rules took 39 of the 60 ms of the
with-sets bench row.

## Options considered

1. **Remember the last two paths for the fold and for the encode, and refuse a path whose last
   bytes cannot be the pattern's fixed tail** (recommended).
2. Fold and encode once in each rule loop and hand the matcher prepared text.
3. Keep the per-rule costs.

## Decision

**Adopted-as-recommended (no user judgment)** — ADR-1259's ruling chose a memo over a hoist; this
extends it to the case review measured. Option 1:

- the fold and the encode each keep their last two results, so a path and its basename both
  hit;
- the tokens after a pattern's last star each consume one byte, and a match must reach the end
  of the path: a path whose last bytes fail them is refused before any table is filled. git's
  `dowild` reaches the same refusal by backtracking.

Both caches hold a pure function of the path, and the refusal is a necessary condition of a
match, so no verdict changes.

Measured after the change, same workloads: ignore-match bench 15.1 ms without sets, 19.4 ms with
sets, 19.5 ms for the one-byte twin (from 21.0, 60.4 and 62.8 ms); folded ignore matching 19.4 ms
on lower-case paths and 21.1 ms on mixed-case paths against 16.9 ms case-exact.

Superseded from ADR-1259: the single entry. Carried forward: the memo lives in
`compile-glob.ts`, caches `asciiLower`, and changes no signature.

## Consequences

### Positive

- A rule set with sets costs what its one-byte twin costs, and a folded rule set stays within a
  quarter of a case-exact one on mixed anchored and unanchored rules.

### Negative

- Two caches of two entries each are module-level state; the encode cache keeps two path byte
  arrays alive.
- A weakened refusal or a disabled cache changes cost only: the performance suite, not the unit
  suite, catches it.
