# ADR-378: Whitespace diff options as a flat enum plus inline toggles

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/whitespace-diff-options.md](../design/whitespace-diff-options.md)
- **Refines:** [ADR-249](249-describe-structured-data-only.md)

## Context

24.14 surfaces git's whitespace diff family (`-w`, `-b`, `--ignore-space-at-eol`,
`--ignore-cr-at-eol`, `--ignore-blank-lines`) as structured modes on `DiffOptions` /
`DiffTreesOptions`. Pinned against real git: the `-w` / `-b` / `--ignore-space-at-eol`
trio is mutually exclusive with `-w` dominating (order-independent), while
`--ignore-cr-at-eol` and `--ignore-blank-lines` are orthogonal and combine freely with
the trio and each other. The surface must represent exactly the legal combinations — no
illegal `{all + change}` state — and per ADR-249 these are DATA modes (they change which
hunks/files/counts exist), not forbidden rendering knobs.

## Options considered

1. **Sub-object** `whitespace?: { mode?: 'all'|'change'|'at-eol'; ignoreCrAtEol?; ignoreBlankLines? }` (designer's recommendation) — pros: groups one concern cohesively / cons: a nested object where the rest of the options surface is flat.
2. **Independent booleans** (`ignoreAllSpace?`, `ignoreSpaceChange?`, …) — pros: 1:1 with git flags / cons: admits the illegal `{all + change}` combo and pushes `-w`-dominates-`-b` precedence onto callers.
3. **(chosen) Flat enum + inline toggles** on the options root — pros: enum forbids the illegal trio state and encodes `-w` dominance in the type; matches the existing flat options style (`detectRenames`/`recursive`/`withStat`) / cons: three whitespace keys sit alongside the rest on the root.

## Decision

`DiffOptions` and `DiffTreesOptions` each gain three flat fields:

- `ignoreWhitespace?: 'all' | 'change' | 'at-eol'` — the mutually-exclusive trio as one
  enum (`all` = `-w`, `change` = `-b`, `at-eol` = `--ignore-space-at-eol`); absent ⇒
  today's exact byte comparison.
- `ignoreCrAtEol?: boolean` — orthogonal; `--ignore-cr-at-eol`.
- `ignoreBlankLines?: boolean` — orthogonal; `--ignore-blank-lines` (scope per ADR-379).

The enum makes the illegal `{all + change}` state unrepresentable and encodes `-w`'s
dominance over `-b`/`--ignore-space-at-eol` in the type (only one trio value selectable),
so dominance is structural, not a runtime precedence rule.

## Consequences

- `-w` dominance is type-level: a caller cannot ask for "`all` and `change` as distinct
  effects" because they are not distinct in git (`-w` simply wins).
- Three new keys per options type; the resolved internal whitespace descriptor and its
  type re-export via `export type *` (`reports/api.json` regenerates).
- A legal-but-redundant combination git also accepts (e.g. `ignoreWhitespace: 'all'` +
  `ignoreCrAtEol: true`, since `-w` already ignores a trailing CR) is permitted and
  collapses to the same outcome — faithful to git accepting `-w --ignore-cr-at-eol`.
- The config surface (ADR-382) mirrors these flat keys.
