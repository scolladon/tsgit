---
subjects:
  - src/domain/name-rev/ref-pattern.ts
  - src/application/commands/name-rev.ts
---
<!-- cspell:ignore wildmatch -->
# 1040 — `name-rev` filters match every `/`-suffix and report abbreviation as data

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-249 and ADR-841; none superseded

## Context

git's `name_ref` runs `subpath_matches(path, filter)`: `wildmatch(filter, subpath, 0)` on the full
refname, then on the text after each `/` (`refs/tags/v1.0`, `tags/v1.0`, `v1.0`); excludes are
tested first (N10–N13). `buildRefFilter` matches the full refname only, so `--refs 'v*'` names
nothing (N2). When an include matched only through a suffix git sets `can_abbreviate_output` and
prints `refs_shorten_unambiguous_ref(path)` — `v1.0^0` for N2 but `heads/x` when a tag `x` also
exists (N25) — while a full match keeps the fixed `refs/` strip (N5, N27). The shortening needs
ref-existence lookups and is rendering (ADR-249); tsgit already has `shortenUnambiguousRef`.

## Options considered

1. **`NameRevResult.abbreviated: boolean`** (designer's recommendation) — the suffix-only signal
   as data; the caller shortens. Pros: ADR-249; the only party that knows the match kind cheaply.
   Cons: one additive public field.
2. **No field** — every caller recomputes suffix matching from its own patterns.
3. **Return a pre-shortened name** — renders in the library and needs ref lookups in the result.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `buildRefFilter` compiles each pattern
once, tests every `/`-suffix for includes and excludes, and exposes `abbreviates(ref)`;
`nameCommit` and `exactRefMatch` set `abbreviated` on the result. `--tags --name-only` keeps the
caller's own rule (N21).

## Consequences

- N2–N4, N6–N8, N10–N13, N16–N19, N23, N25, N26 and N28 flip to git's names; the interop
  renderer shortens with `git rev-parse --abbrev-ref` as the oracle.
- The naming ref chosen does not change, so the tip table stays.
