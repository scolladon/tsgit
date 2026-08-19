# 666 — Repository-format refusals keep git's config-porcelain tier

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/repository-format-acceptance-gate.md (candidate D1) · **Refines:** ADR-639, ADR-664 · **Paired with:** ADR-679

## Context

git's repository-format gate is measurably a *third* tier, distinct from both tiers tsgit
implements. On a `repositoryformatversion = 99` repository, every repository-needing command
dies with `fatal: Expected git repo version <= 1, found 99` (exit 128) — but `config --list`
exits **0**, printing only the non-repository scopes, and `config <key>` exits **1**. Contrast
the gate tsgit already has: `core.bare = banana` kills even `config --list` with exit 128.

The parenthetical in `bare-repo-custom-gitdir.md` §1b — repeated verbatim in the backlog entry
— named `assertDiscoveryBooleansValid` as the natural home. That was an inference from `log`,
never a porcelain measurement, and the measurement contradicts it.

## Options considered

1. **Open time**, in `readRepositoryFormat` — `openRepository` throws (design recommendation)
   — pros: one structural chokepoint on every route, nothing to keep total; matches the
   `init` refusal for free / cons: tsgit's `config` porcelain refuses where git's survives —
   a measured divergence on data ADR-249 treats as binding.
2. **First command**, beside `assertDiscoveryBooleansValid` — pros: no new tier / cons: same
   divergence one call later, plus a second enumeration site.
3. **Split** — the operational tier refuses; `config` and `remote` survive with the repository
   scope dropped — pros: reproduces the measured rows byte-for-byte / cons: a second tier to
   maintain.

## Decision

**Option 3 — ratified by the user, against the design's recommendation.**

Repository-format refusals fire on the operational tier. The `config` and `remote` read verbs
survive with the repository config scope dropped, exactly as git's do.

The design rejected option 3 on the grounds that "the sibling trust gate would have to
replicate the split". That objection is void: ADR-679 builds precisely that mechanism for the
ownership gate regardless, so this reuses one shared tier rather than doubling it. Both
acceptance gates therefore express one rule — *a repository the acceptance tier rejects has no
readable config scope, and gentle-setup verbs survive on the scopes that remain.*

## Consequences

- The operational tier's exact membership (which verbs skip it) becomes load-bearing and must
  be enumerated on the `openRepository` docs page, not inferred from which assert a command
  happens to call.
- Interop pins the porcelain rows as co-truth rather than as an asserted divergence.
- Refusal timing diverges from ADR-664's open-time choice for *layout* config. That ADR is
  refined, not superseded: layout keys still refuse at open; format keys refuse at the tier
  git refuses them on.
