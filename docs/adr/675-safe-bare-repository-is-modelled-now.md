# 675 — `safe.bareRepository` is modelled now, as `bareRepositories`

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D7) · **Refines:** ADR-671

## Context

git 2.38 added `safe.bareRepository` (`all` | `explicit`) for repositories planted inside a tree
you cloned yourself. Until the bare-repository work, tsgit's discovery could not reach a gitdir
that way; the `BARE_DIR` route made that exposure reachable for the first time.

The measured predicate is **not** bareness (see ADR-674): it is *discovery reached the gitdir by
the cwd-is-a-gitdir route AND the gitdir's basename is not literally `.git`*. In tsgit's
vocabulary both terms are available from `WalkOutcome` at the moment the gate runs — no config
read, no work-tree resolution.

## Options considered

1. **Model it now**, as `bareRepositories?: 'all' | 'explicit'` (design recommendation) — pros:
   closes a vector the ownership gate structurally cannot see / cons: more surface in an
   already-large change.
2. **Defer to a follow-up** — pros: smaller now / cons: leaves the vector open, and needs a new
   backlog entry against a standing preference that work rides in the PR that finds it.
3. **Permanent no-op** — accept the option, always behave as `'all'` — a config knob that does
   nothing.

## Decision

**Option 1 — ratified by the user.**

Three reachability arguments carried it. It is **not subsumed** by the ownership gate: a
repository directory planted inside your own clone is owned by *you*, so ownership passes and
only this gate stops it. Its predicate is precisely the "this was not placed here by a normal
checkout" signal. And it needs no ownership capability, so — uniquely in this feature — it is
**fully interop-testable against real git today, on every platform, with no skip and no escape
hatch**.

Ordering is measured and reproduced: this gate fires **before** the ownership gate, and
`trustedDirectories` does not lift it.

## Consequences

- `bareRepositories` joins the trust option group of ADR-671 and follows the same naming rule:
  named for what it does, not for git's key.
- The default is `'all'`, matching git, so nothing changes for existing callers.
- It is the one part of this feature whose faithfulness is proven end-to-end against real git
  rather than through a capability stub — which makes it the anchor row of the interop suite.
