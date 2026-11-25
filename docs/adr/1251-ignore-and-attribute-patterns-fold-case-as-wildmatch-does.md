---
subjects:
  - src/domain/glob/wildmatch.ts
  - src/domain/pathspec/compile-glob.ts
  - src/domain/ignore/parse-gitignore.ts
  - src/domain/attributes/parse-gitattributes.ts
  - src/application/primitives/internal/ignore-evaluator.ts
  - src/application/primitives/internal/read-gitignore.ts
  - src/application/primitives/internal/read-gitattributes.ts
supersedes:
  - adr: "1214"
    scope: "the fold lowers the whole pattern and the whole path"
---
<!-- cspell:ignore casefold -->
# 1251 — Ignore and attribute patterns fold case as wildmatch does

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (G-c, DC-I, R2, R8, §3) · **Supersedes/Refines:** supersedes ADR-1214 (fold model); applies DOCTRINE(D-2)

## Context

Under `core.ignorecase = true`, git ignores `x.log` for `*.LOG` and matches `dir/f` for `Dir/f`
(rows L1–L4). tsgit's `.gitignore` and `.gitattributes` readers never fold: only sparse passes
`caseFold`. The brief pins class rows under both `core.ignorecase` values for every consumer, and
those rows cannot go green for ignore and attributes without the fold.

`compileGlob`'s fold lowers the whole pattern and the whole path. git's `WM_CASEFOLD` lowers the
text byte and a plain pattern byte only: an escaped byte and a set member are compared as written
(`\A` and `[A]` match neither `a` nor `A`, rows E13, F1), a range also tries the upper-cased text
byte (`[A-Z]` matches `a`, F3), and `[:upper:]` admits lower case (F8).

## Options considered

Where the readers learn `core.ignoreCase`:

1. **Read it once per ignore evaluator or attribute provider build and pass it down**
   (recommended).
2. Each loader reads the configuration.
3. Parse case-exact and re-parse folded on demand.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-2) for the fold itself: the change
makes the rows reachable and the readers already diverge on main. Option 1 for the wiring, no
trade-off: the alternatives differ in mechanics only. `parseGitignore` and `parseGitattributes`
take an optional `{ caseFold }`.

The fold is `WM_CASEFOLD` exactly, in the shared core, for all three consumers: the path is
lowered over ASCII, a plain pattern byte is lowered, escaped bytes and set members are not, a
range retries the upper-cased byte, `[:upper:]` admits lower case, and negation applies last.

Superseded from ADR-1214: lowering the whole pattern. Carried forward: sparse patterns fold ASCII
case under `core.ignorecase`, read from the local configuration.

## Consequences

### Positive

- On macOS and Windows defaults, ignore and attribute verdicts follow git for patterns and paths
  that differ in case.

### Negative

- A repository whose rules matched only case-exactly sees more paths ignored or attributed under
  `core.ignorecase = true`.
- Under the fold, `[A]x` and `\A` stop matching in sparse rules, as in git.
