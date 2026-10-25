---
subjects:
  - src/application/commands/internal/pull-into-void.ts
  - src/application/primitives/materialize-tree.ts
  - src/application/primitives/apply-changeset.ts
---
# 1077 — `pull` into an unborn branch protects ignored occupants

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC3, P5) · **Supersedes/Refines:** refines ADR-226

## Context

git 2.55 `pull` into an unborn branch runs `checkout_fast_forward` with `overwrite_ignore = 0`.
It refuses an ignored file or directory in the way, where `checkout` overwrites one. tsgit's
unforced apply always treats ignored occupants as expendable. Today it overwrites ignored data on
three shapes and crashes on two (design RC7). After ADR-1075, the crashing shapes would silently
delete ignored files that git keeps.

## Options considered

1. **Fold now, as an optional enum `ignoredOccupants: 'overwrite' | 'protect'`** on
   `MaterializeTreeOpts` and `ApplyChangesetOpts`. The default `overwrite` is git's usual
   `overwrite_ignore = 1`. Pros: git-faithful; a named mode, not a boolean parameter; additive to
   the public primitive surface. Cons: one more option on a public primitive.
2. **Leave it.** Pros: no API change. Cons: ADR-1075 turns crashes into data loss.

## Decision

**Adopted as recommended (no user judgment): option 1.** `pull-into-void` passes `protect`. Under
`protect`, the pre-flight's ignore probe answers "not ignored", so an ignored occupant is refused
like an untracked one. `clearOccupants` then has nothing it may remove.

## Consequences

- The option is optional and defaults to the current behaviour, so the public primitive change is
  additive.
- `api.json` changes, and is regenerated before push.
