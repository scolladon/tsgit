# 679 — An untrusted repository reads as an empty config scope

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D11) · **Paired with:** ADR-666 · **Refines:** ADR-249

## Context

Measured against git, an untrusted repository is not "a repository that refuses more gently" —
**to a gentle-setup command it simply is not a repository, and its config scope is empty**. A
distinctive key planted locally is invisible (`config user.name` exits 1 with no output);
`config --list` exits 0 printing only the non-repository scopes; `core.bare = banana`, which
refuses every command on a *trusted* repository, **stops refusing** because it is never read;
and config writes refuse with `fatal: not in a git directory`, leaving the file byte-unchanged.

## Options considered

1. **An untrusted repository reads as an empty repository config scope** — one guard in
   `readConfig` — and the two refusals move to the operational tier the `config` read verbs skip
   (design recommendation) — pros: reproduces every measured row / cons: `readConfig` gains a
   layout-dependent early return, and the operational tier's membership becomes load-bearing.
2. **Both refusals in `assertRepository`** — pros: one tier / cons: diverges on data ADR-249
   treats as binding (an empty list is a result, not a rendering), and it *parses the attacker's
   config file* in order to then refuse — strictly worse security than not reading it.
3. **Both in `assertRepository`, with the `config` porcelain repointed at a trust-free assert**
   — reproduces the read behaviour but leaves the file parsed and adds a third assert whose only
   job is to be skipped.

## Decision

**Option 1 — adopted as recommended (no user judgment), and reinforced by the user's ratified
choice in ADR-666 to keep git's config-porcelain tier for the sibling format gate.**

The two acceptance gates now express one rule: *a repository the acceptance tier rejects has no
readable config scope, and gentle-setup verbs survive on the scopes that remain.* One mechanism
serves both.

The security payload is that the untrusted repository's config file is **never parsed** — not at
open (Stage 2 is skipped, ADR-678) and not at command time. `merge.<d>.driver`,
`core.excludesFile` and `core.attributesFile` are never read from an untrusted repository.

## Consequences

- Both measured ordering pins — ownership shadowing the layout-config refusal, and ownership
  shadowing the repository-format refusal — dissolve into a *consequence* rather than rules to
  maintain: the downstream gates have nothing to read, so nothing has to be sequenced against
  them.
- The exact set of verbs that survive on an untrusted or format-rejected repository becomes a
  documented contract, enumerated on the `openRepository` docs page.
- `readConfig` gains one layout-dependent early return; its memoisation is unchanged.
