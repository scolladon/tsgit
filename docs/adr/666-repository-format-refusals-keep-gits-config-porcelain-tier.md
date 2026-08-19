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
3. **Split** — the operational tier refuses; the surviving verbs carry on with the repository
   scope dropped — pros: reproduces the measured rows byte-for-byte / cons: a second tier to
   maintain.

## Decision

**Option 3 — ratified by the user, against the design's recommendation.**

Repository-format refusals fire on the operational tier. The **`config` read verbs** survive
with the repository config scope dropped, exactly as git's do.

**Correction, measured after ratification and before merge.** An earlier draft of this decision
named "the `config` and `remote` read verbs" as the surviving pair. That is wrong about `remote`.
Re-measured independently, twice, on git 2.55.0 in an isolated `mktemp` with `GIT_*` scrubbed:

| verb | exit | note |
|---|---|---|
| `config --list`, `config <key>`, `config --get-regexp`, `config --list --show-origin` | 0 (or 1 when no other scope holds the key) | **survive**; two `warning:` lines, repository scope absent |
| `config --local --list` | 128 | `fatal: --local can only be used inside a git repository` |
| `config <key> <value>`, `--add`, `--unset` | 128 | **refuse**; repository config file byte-unchanged |
| `remote`, `remote -v`, `remote get-url`, `remote show -n`, `remote add`, `remote rename`, `remote remove` | 128 | **all refuse**; config file byte-unchanged |

The surviving set is therefore **four `config` read verbs**, not fifteen verbs.

The design rejected option 3 on the grounds that "the sibling trust gate would have to
replicate the split". That objection is void: ADR-679 builds precisely that mechanism for the
ownership gate regardless, so this reuses one shared tier rather than doubling it. Both
acceptance gates therefore express one rule — *a repository the acceptance tier rejects has no
readable config scope; the `config` read verbs survive on the scopes that remain, and everything
else refuses.*

## Consequences

- The operational tier's exact membership (which verbs skip it) becomes load-bearing and must
  be enumerated on the `openRepository` docs page, not inferred from which assert a command
  happens to call.
- **Where the refusal attaches is a consequence that is NOT settled by this ADR.** tsgit today
  puts nine `config` sites (writers included) and six `remote` sites on the ungated bare
  `assertRepository`. A mechanism that merely drops the config scope there would let
  `repo.config.set()` write into a rejected repository's config file where git refuses with the
  file byte-unchanged. The attach point binds this gate and the ownership gate identically and
  is decided once, for both, in a separate ADR.
- Interop pins the porcelain rows as co-truth rather than as an asserted divergence.
- Refusal timing diverges from ADR-664's open-time choice for *layout* config. That ADR is
  refined, not superseded: layout keys still refuse at open; format keys refuse at the tier
  git refuses them on.
