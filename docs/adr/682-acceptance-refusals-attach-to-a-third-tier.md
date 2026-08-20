# 682 — Acceptance refusals attach to a third tier, `assertAcceptedRepository`

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/repository-format-acceptance-gate.md · docs/design/ownership-trust-gate.md (both, candidate DN-1) · **Refines:** ADR-666, ADR-679

## Context

Both acceptance gates need one home, and neither existing tier expresses the measured behaviour.
`assertRepository` (HEAD usable + discovery booleans) is called directly by **15 verbs** —
`configGet`, `configGetAll`, `configGetRegexp`, `configList`, `configSet`, `configUnset`,
`configUnsetAll`, `configRenameSection`, `configRemoveSection`, and all six of `remoteList`,
`remoteAdd`, `remoteRemove`, `remoteRename`, `remoteSetUrl`, `remoteShow`.
`assertOperationalRepository` = `assertRepository` + `assertEagerConfigValid` and is reached by
45 modules.

Measured (independently re-verified by the session), exactly **four** of those 15 survive a
rejected repository: `configGet`, `configGetAll`, `configGetRegexp`, `configList`. The five
config writers and all six remote verbs refuse with exit 128, leaving the config file
byte-unchanged. Attaching the refusals to the operational tier alone would let `repo.config.set()`
write into a rejected or untrusted repository's config file — the attacker's file.

## Options considered

1. **Invert the default** — refusals into `assertRepository`; the 4 survivors opt out via a new
   explicitly-named weaker assert (~4 sites) — pros: fails closed; smallest diff (both designs
   recommended this) / cons: `assertRepository`'s meaning shifts.
2. **A third tier** — `assertAcceptedRepository` = `assertRepository` + the new gates; the 11
   non-survivors move onto it; `assertOperationalRepository` chains through it (~11 sites) —
   pros: names git's real three tiers, explicit at every call site / cons: fails open.
3. **Reuse the operational tier** — move the 11 onto it (~11 sites) — cons: those verbs newly
   inherit the eager `[core]` validation they skip today, an unmeasured behaviour change bundled
   into a security fix; also fails open.

## Decision

**Option 2 — ratified by the user, against both designs' recommendation.**

Three tiers, each named for what it asserts:

```
assertRepository          = HEAD usable + discovery booleans        <- the 4 surviving config reads
assertAcceptedRepository  = assertRepository + acceptance gates     <- the 11 movers
assertOperationalRepository = assertAcceptedRepository + eager [core] <- the 45 operational modules
```

The acceptance gates are the four refusals of ADR-668 and ADR-674: format version, unsupported
extension, dubious ownership, implicit bare repository.

**Required mitigation for the fails-open residual.** Because a future command that reaches for
`assertRepository` would silently operate on a rejected repository, the weaker tier is guarded
**mechanically, not by convention**: an architecture-tier check asserts that no module calls bare
`assertRepository` unless it appears on an explicit allowlist of exactly those four verbs. Adding
a fifth requires editing the allowlist, which is a reviewable act. This guard is part of the
change, not a follow-up.

## Consequences

- ~11 call sites move; the two `config.ts` / `remote.ts` modules carry the split explicitly.
- ADR-666 and ADR-679 name this tier as their attach point; their own decisions are unchanged.
- The three-tier shape becomes a documented contract on the `openRepository` docs page, listing
  exactly which verbs survive a rejected repository.
- The allowlist guard is the reason this option is safe to ship; if it were dropped, option 1
  would be the correct choice instead.
